// Fetch recorded/transcribed Webex meetings for the ingest meeting picker.
//
// Two Webex sources are unioned so the picker isn't limited to recordings:
//   - GET /v1/recordings         — recordings in the caller's library (host-owned)
//   - GET /v1/meetingTranscripts — transcripts the caller can access
// Transcripts often surface meetings the user attended (not just hosted), which
// recordings alone do not. Both are keyed by meetingId; we merge on it.
//
// Webex semantics we work around (see issue #76):
//   - With no from/to, both endpoints default to a narrow ~7-day window. We page
//     across the requested lookback, capped at 30 days for an interactive picker.
//   - /recordings returns the caller's OWN (host-owned) recordings; recordings of
//     meetings hosted by others are not returned under a normal user token. That
//     is a hard Webex limitation — documented, not fixable here.
//
// `?debug=1` returns raw diagnostics (counts + sample items from recordings,
// transcripts, and /meetings) to inspect what the token can actually see.

import { NextRequest } from "next/server";

import { successResponse, withErrorHandler } from "@/lib/api-middleware";
import { loadTomeProject } from "@/lib/tome/tome-api";
import { resolveForwardedCredentials } from "@/lib/tome/agent-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

export interface WebexMeetingListItem {
  id: string;
  title: string;
  start: string;
  siteUrl?: string;
  hasSummary: boolean;
  hasTranscript: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Webex caps a single from/to query at ~30 days, so page across 30-day windows.
const WINDOW_DAYS = 30;
const DEFAULT_LOOKBACK_DAYS = 3;
const MAX_LOOKBACK_DAYS = 30;
// Safety caps so a large history can't fan out unbounded.
const MAX_PAGES_PER_WINDOW = 10;
const SUMMARY_CHECK_CAP = 100;
const TRANSCRIPT_CHECK_CAP = 100;
const WEBEX_REQUEST_TIMEOUT_MS = 6_000;
const HISTORY_DEADLINE_MS = 18_000;
const TRANSCRIPT_LIST_DEADLINE_MS = 2_000;
const HISTORY_CONCURRENCY_PER_ENDPOINT = 2;
const SUMMARY_DEADLINE_MS = 5_000;
const SUMMARY_CONCURRENCY = 8;
const TRANSCRIPT_CHECK_DEADLINE_MS = 5_000;
const TRANSCRIPT_CHECK_CONCURRENCY = 8;

/** ISO 8601 without milliseconds (Webex rejects the `.000Z` form). */
function isoNoMs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Extract the `rel="next"` URL from a Webex `Link` response header. */
function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (m) return m[1];
  }
  return null;
}

function webexSiteOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "webex.com" && !host.endsWith(".webex.com"))) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function hasWebexTranscriptUrl(value: unknown): boolean {
  return webexSiteOrigin(value) !== null;
}

async function fetchBeforeDeadline(
  url: string,
  headers: Record<string, string>,
  deadline: number,
): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Webex request deadline exceeded");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(WEBEX_REQUEST_TIMEOUT_MS, remaining),
  );
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET with one retry on 429 (respecting Retry-After, capped). */
async function wfetch(
  url: string,
  headers: Record<string, string>,
  deadline: number,
): Promise<Response> {
  const res = await fetchBeforeDeadline(url, headers, deadline);
  if (res.status !== 429) return res;
  const wait = Math.min(Number(res.headers.get("Retry-After")) || 2, 10);
  if (Date.now() + wait * 1000 >= deadline) return res;
  await new Promise((r) => setTimeout(r, wait * 1000));
  return fetchBeforeDeadline(url, headers, deadline);
}

async function mapConcurrent<T>(
  count: number,
  concurrency: number,
  fn: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const index = next++;
      results[index] = await fn(index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Page a Webex list endpoint across 30-day windows back `LOOKBACK_DAYS` days,
 * following the `Link: rel="next"` header within each window. Returns the raw
 * item objects unioned across all windows/pages.
 */
async function fetchWindowed(
  endpoint: string,
  headers: Record<string, string>,
  lookbackDays: number,
  deadlineMs = HISTORY_DEADLINE_MS,
): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  const deadline = now + deadlineMs;
  const windowCount = Math.ceil(lookbackDays / WINDOW_DAYS);
  const windows = await mapConcurrent(
    windowCount,
    HISTORY_CONCURRENCY_PER_ENDPOINT,
    async (windowIndex) => {
      const items: Record<string, unknown>[] = [];
      const off = windowIndex * WINDOW_DAYS;
      if (Date.now() >= deadline) return items;
      const to = new Date(now - off * DAY_MS);
      const from = new Date(now - Math.min(off + WINDOW_DAYS, lookbackDays) * DAY_MS);
      let url: string | null =
        `${endpoint}?max=100&from=${encodeURIComponent(isoNoMs(from))}&to=${encodeURIComponent(isoNoMs(to))}`;
      for (let page = 0; url && page < MAX_PAGES_PER_WINDOW; page++) {
        if (Date.now() >= deadline) break;
        let res: Response;
        try {
          res = await wfetch(url, headers, deadline);
        } catch {
          break;
        }
        if (!res.ok) break;
        const json = (await res.json()) as { items?: Record<string, unknown>[] };
        if (Array.isArray(json.items)) items.push(...json.items);
        url = parseNextLink(res.headers.get("link"));
      }
      return items;
    },
  );
  return windows.flat();
}

async function hasTranscriptForMeeting(
  meeting: {
    meetingId: string;
    hasTranscript: boolean;
    recordingId?: string;
    siteOrigin?: string;
  },
  headers: Record<string, string>,
  deadline: number,
): Promise<boolean> {
  if (meeting.hasTranscript) return true;
  if (Date.now() >= deadline) return false;

  try {
    const response = await wfetch(
      `https://webexapis.com/v1/meetingTranscripts?meetingId=${encodeURIComponent(meeting.meetingId)}&max=1`,
      headers,
      deadline,
    );
    if (response.ok) {
      const payload = (await response.json()) as { items?: unknown[] };
      if ((payload.items?.length ?? 0) > 0) return true;
    }
  } catch {
    // Fall through to User Hub, which can expose shared/cohost transcripts
    // omitted by the public transcript API.
  }

  if (!meeting.recordingId || !meeting.siteOrigin || Date.now() >= deadline) return false;
  try {
    const response = await wfetch(
      `${meeting.siteOrigin}/webappng/api/v1/recordings/${encodeURIComponent(meeting.recordingId)}/stream`,
      { ...headers, clientType: "web" },
      deadline,
    );
    if (!response.ok) return false;
    const payload = (await response.json()) as {
      meetingInstanceId?: unknown;
      downloadRecordingInfo?: { downloadInfo?: { transcriptURL?: unknown } };
    };
    return (
      payload.meetingInstanceId === meeting.meetingId &&
      hasWebexTranscriptUrl(payload.downloadRecordingInfo?.downloadInfo?.transcriptURL)
    );
  } catch {
    return false;
  }
}

export const GET = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug } = await ctx.params;
  const tctx = await loadTomeProject(request, slug);
  const debug = request.nextUrl.searchParams.get("debug") === "1";
  const requestedLookback = Number(request.nextUrl.searchParams.get("lookbackDays"));
  const lookbackDays =
    Number.isInteger(requestedLookback) && requestedLookback > 0
      ? Math.min(requestedLookback, MAX_LOOKBACK_DAYS)
      : DEFAULT_LOOKBACK_DAYS;

  const creds = await resolveForwardedCredentials(tctx);
  const token = creds["webex"]?.access_token;

  if (!token) {
    return successResponse(debug ? { note: "no webex token", meetings: [] } : { meetings: [] });
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  // Recordings + transcripts across the full lookback, in parallel.
  const [recItems, txItems] = await Promise.all([
    fetchWindowed("https://webexapis.com/v1/recordings", headers, lookbackDays),
    fetchWindowed(
      "https://webexapis.com/v1/meetingTranscripts",
      headers,
      lookbackDays,
      TRANSCRIPT_LIST_DEADLINE_MS,
    ),
  ]);

  if (debug) {
    const meetingsProbe = await fetchWindowed(
      "https://webexapis.com/v1/meetings",
      headers,
      lookbackDays,
    );
    return successResponse({
      lookbackDays,
      windowDays: WINDOW_DAYS,
      recordings: {
        total: recItems.length,
        withMeetingId: recItems.filter((r) => r.meetingId).length,
        withoutMeetingId: recItems.filter((r) => !r.meetingId).length,
        sample: recItems.slice(0, 3),
      },
      transcripts: {
        total: txItems.length,
        withMeetingId: txItems.filter((t) => t.meetingId).length,
        sample: txItems.slice(0, 3),
      },
      meetings: {
        total: meetingsProbe.length,
        sample: meetingsProbe.slice(0, 3),
      },
    });
  }

  // Merge both sources by meetingId. A recording or a transcript is enough to
  // list (and later ingest) a meeting; downstream fetches summary/transcript by
  // meetingId, so an item without one is unusable — count it, don't show it.
  const byMeeting = new Map<
    string,
    {
      title: string;
      start: string;
      hasTranscript: boolean;
      recordingId?: string;
      siteOrigin?: string;
    }
  >();
  let skippedNoMeetingId = 0;

  for (const r of recItems) {
    const meetingId = typeof r.meetingId === "string" ? r.meetingId : "";
    if (!meetingId) {
      skippedNoMeetingId++;
      continue;
    }
    const existing = byMeeting.get(meetingId);
    const title = (typeof r.topic === "string" && r.topic) || existing?.title || "Untitled meeting";
    const start =
      (typeof r.timeRecorded === "string" && r.timeRecorded) ||
      (typeof r.createTime === "string" && r.createTime) ||
      existing?.start ||
      "";
    byMeeting.set(meetingId, {
      title,
      start,
      hasTranscript: existing?.hasTranscript ?? false,
      recordingId: (typeof r.id === "string" && r.id) || existing?.recordingId,
      siteOrigin: webexSiteOrigin(r.siteUrl) || existing?.siteOrigin,
    });
  }

  for (const t of txItems) {
    const meetingId = typeof t.meetingId === "string" ? t.meetingId : "";
    if (!meetingId) continue;
    const existing = byMeeting.get(meetingId);
    const title =
      existing?.title ||
      (typeof t.title === "string" && t.title) ||
      "Untitled meeting";
    const start =
      existing?.start || (typeof t.createTime === "string" && t.createTime) || "";
    byMeeting.set(meetingId, {
      title,
      start,
      hasTranscript: true,
      recordingId: existing?.recordingId,
      siteOrigin: existing?.siteOrigin,
    });
  }

  // Newest first.
  const merged = [...byMeeting.entries()]
    .map(([meetingId, m]) => ({ meetingId, ...m }))
    .sort((a, b) => (b.start || "").localeCompare(a.start || ""));

  // Summary availability per meeting (no global list endpoint). Bounded so a
  // large history doesn't fan out into hundreds of calls.
  const summaryDeadline = Date.now() + SUMMARY_DEADLINE_MS;
  const transcriptDeadline = Date.now() + TRANSCRIPT_CHECK_DEADLINE_MS;
  const [summaryFlags, transcriptFlags] = await Promise.all([
    mapConcurrent(merged.length, SUMMARY_CONCURRENCY, async (i) => {
      const { meetingId } = merged[i];
      if (i >= SUMMARY_CHECK_CAP) return false;
      if (Date.now() >= summaryDeadline) return false;
      try {
        const res = await wfetch(
          `https://webexapis.com/v1/meetingSummaries?meetingId=${encodeURIComponent(meetingId)}`,
          headers,
          summaryDeadline,
        );
        if (!res.ok) return false;
        const j = (await res.json()) as { items?: unknown[] };
        return (j.items?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }),
    mapConcurrent(merged.length, TRANSCRIPT_CHECK_CONCURRENCY, async (i) => {
      if (i >= TRANSCRIPT_CHECK_CAP) return false;
      return hasTranscriptForMeeting(merged[i], headers, transcriptDeadline);
    }),
  ]);

  const meetings: WebexMeetingListItem[] = merged.map((m, i) => ({
    id: m.meetingId,
    title: m.title,
    start: m.start,
    ...(m.siteOrigin ? { siteUrl: m.siteOrigin } : {}),
    hasSummary: summaryFlags[i],
    hasTranscript: transcriptFlags[i],
  }));

  if (skippedNoMeetingId > 0) {
    console.log(`[webex-meetings] skipped ${skippedNoMeetingId} recording(s) with no meetingId`);
  }

  return successResponse({ meetings });
});
