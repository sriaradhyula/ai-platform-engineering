"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { CheckCircle2, History, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ViewOnlyTooltip } from "@/components/tome/ViewOnlyTooltip";
import { cn } from "@/lib/utils";

/**
 * Page revision history + diff. Left: the page's revisions (newest first,
 * ingest-authored ones flagged, linked to the run that wrote them). Right: a
 * split word-diff of the selected revision against the previous one (first
 * revision vs an empty page), with a Revert action. Port of TTT's
 * `HistoryPanel`, rendered in the main pane instead of a drawer.
 */

interface RevisionSummary {
  id: string;
  author: string;
  message: string;
  created_at: string;
  report_id: string | null;
  status: "live" | "draft" | "rejected";
  deleted: boolean;
  reverted_from: string | null;
  draft_created_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_outcome: "published" | "rejected" | null;
}

interface HistoryBundle {
  currentRevisionId: string | null;
  revisions: RevisionSummary[];
}

interface RevisionDetail {
  id: string;
  body: string;
}

export function PageHistoryView({
  slug,
  path,
  canEdit,
  onReverted,
  onOpenRun,
  onReviewDraft,
}: {
  slug: string;
  path: string;
  canEdit: boolean;
  /** Called after a successful revert so the caller can reload the wiki page. */
  onReverted?: () => void;
  /** Navigate to the ingest run that produced a revision. */
  onOpenRun?: (runId: string) => void;
  /** Navigate directly to an ingest run's draft review surface. */
  onReviewDraft?: (runId: string) => void;
}) {
  const [history, setHistory] = useState<HistoryBundle | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  // The loaded diff bundle, tagged with the selection it belongs to so a
  // stale fetch never renders against the wrong revision.
  const [loaded, setLoaded] = useState<{
    idx: number;
    oldBody: string;
    newBody: string;
  } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [resolving, setResolving] = useState<"publish" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reactive theme — the diff recolors live when the user toggles dark/light.
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const loadRevisions = useCallback(async (): Promise<HistoryBundle> => {
    try {
      const r = await fetch(`/api/tome/projects/${slug}/history/${path}`);
      const j = await r.json();
      return {
        currentRevisionId: j?.data?.current_revision_id ?? null,
        revisions: j?.data?.revisions ?? [],
      };
    } catch {
      return { currentRevisionId: null, revisions: [] };
    }
  }, [slug, path]);

  useEffect(() => {
    let cancelled = false;
    void loadRevisions().then((loadedHistory) => {
      if (!cancelled) setHistory(loadedHistory);
    });
    return () => {
      cancelled = true;
    };
  }, [loadRevisions]);

  const revisions = history?.revisions ?? null;
  const selected = revisions?.[selectedIdx] ?? null;
  const current = revisions?.find((revision) => revision.id === history?.currentRevisionId);
  // Draft review must compare with what readers can actually see, not merely
  // the next-newest draft. Published history retains sequential comparisons.
  const previous = selected?.status === "draft"
    ? current
    : revisions?.[selectedIdx + 1];
  const selectedIsCurrent = selected?.id === history?.currentRevisionId;

  // Load the two sides of the diff whenever the selection changes. setState
  // happens only in the async callback (no synchronous reset).
  useEffect(() => {
    let cancelled = false;
    const fetchBody = async (id: string | undefined): Promise<string> => {
      if (!id) return "";
      const r = await fetch(`/api/tome/projects/${slug}/revisions/${id}`);
      const j = await r.json();
      return (j?.data as RevisionDetail)?.body ?? "";
    };
    if (!selected) return;
    void (async () => {
      const [nb, ob] = await Promise.all([
        fetchBody(selected.id),
        fetchBody(previous?.id),
      ]);
      if (!cancelled) setLoaded({ idx: selectedIdx, oldBody: ob, newBody: nb });
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, selected, previous, selectedIdx]);

  const diffReady = loaded?.idx === selectedIdx;
  const oldBody = loaded?.oldBody ?? "";
  const newBody = loaded?.newBody ?? "";

  const headerNote = useMemo(() => {
    if (!selected) return "";
    return previous
      ? `Changes in this revision (${previous.author} → ${selected.author})`
      : "First revision, compared against an empty page.";
  }, [selected, previous]);

  const revert = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`Revert ${path} to the ${selected.author} revision from ${new Date(selected.created_at).toLocaleString()}?`)) {
      return;
    }
    setReverting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tome/projects/${slug}/revert/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revisionId: selected.id }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `revert failed (${res.status})`);
      }
      const fresh = await loadRevisions();
      setHistory(fresh);
      setSelectedIdx(0);
      onReverted?.();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setReverting(false);
    }
  }, [selected, slug, path, loadRevisions, onReverted]);

  const resolveOrphanDraft = useCallback(async (action: "publish" | "reject") => {
    if (!selected || selected.status !== "draft" || selected.report_id) return;
    const verb = action === "publish" ? "Publish" : "Discard";
    if (!window.confirm(
      action === "publish"
        ? `Publish this ${path} draft? It will replace the version currently visible to readers.`
        : `Discard this ${path} draft? The current published page will not change.`,
    )) return;

    setResolving(action);
    setError(null);
    try {
      const res = await fetch(`/api/tome/projects/${slug}/revisions/${selected.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          base_revision_id: history?.currentRevisionId ?? null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `${verb} failed (${res.status})`);
      }
      const fresh = await loadRevisions();
      setHistory(fresh);
      const resolvedIndex = fresh.revisions.findIndex((revision) => revision.id === selected.id);
      setSelectedIdx(resolvedIndex >= 0 ? resolvedIndex : 0);
      onReverted?.();
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setResolving(null);
    }
  }, [history?.currentRevisionId, loadRevisions, onReverted, path, selected, slug]);

  const openRun = useCallback(async (reportId: string, review = false) => {
    try {
      const res = await fetch(`/api/tome/projects/${slug}/ingest-reports/${reportId}/run`);
      if (!res.ok) return;
      const j = await res.json();
      const runId = j?.data?.run_id;
      if (runId) {
        if (review) onReviewDraft?.(runId);
        else onOpenRun?.(runId);
      }
    } catch {
      /* no run found for this report — nothing to link to */
    }
  }, [slug, onOpenRun, onReviewDraft]);

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-72 shrink-0 border-r">
        <ScrollArea className="h-full">
          {revisions === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : revisions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No revisions yet.</p>
          ) : (
            <ul>
              {revisions.map((r, i) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedIdx(i)}
                    className={cn(
                      "block w-full border-b px-4 py-3 text-left text-sm transition-colors hover:bg-muted",
                      selectedIdx === i && "bg-muted",
                    )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{r.author}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {r.id === history?.currentRevisionId && (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                              current
                            </span>
                          )}
                          {r.status === "draft" && (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                              draft
                            </span>
                          )}
                          {r.status === "rejected" && (
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-800 dark:bg-red-900/40 dark:text-red-300">
                              rejected
                            </span>
                          )}
                          {r.report_id && (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                void openRun(r.report_id!);
                              }}
                              className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-800 hover:underline dark:bg-sky-900/40 dark:text-sky-300"
                            >
                              ingest
                            </span>
                          )}
                        </span>
                      </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </div>
                    {r.message && (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {r.message}
                      </div>
                    )}
                    {r.reverted_from && (
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <History className="h-3 w-3" /> reverted a prior revision
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </aside>

      <section className="min-w-0 flex-1 overflow-auto bg-muted/30">
        {!selected ? (
          <p className="p-6 text-sm text-muted-foreground">
            Pick a revision on the left.
          </p>
        ) : !diffReady ? (
          <p className="p-6 text-sm text-muted-foreground">Loading diff…</p>
        ) : (
          <div className="text-sm">
            <div className="flex items-center justify-between gap-3 border-b px-5 py-2">
              <span className="text-xs text-muted-foreground">{headerNote}</span>
              {selected.status === "live" && !selectedIsCurrent && (
                <ViewOnlyTooltip viewOnly={!canEdit}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void revert()}
                    disabled={reverting || !canEdit}
                  >
                    {reverting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <History className="h-3.5 w-3.5" />
                    )}
                    Revert to this
                  </Button>
                </ViewOnlyTooltip>
              )}
              {selected.status === "draft" && selected.report_id && onReviewDraft && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void openRun(selected.report_id!, true)}
                >
                  Review draft
                </Button>
              )}
              {selected.status === "draft" && !selected.report_id && (
                <div className="flex items-center gap-2">
                  <ViewOnlyTooltip viewOnly={!canEdit}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void resolveOrphanDraft("reject")}
                      disabled={resolving !== null || !canEdit}
                    >
                      {resolving === "reject" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      Discard draft
                    </Button>
                  </ViewOnlyTooltip>
                  <ViewOnlyTooltip viewOnly={!canEdit}>
                    <Button
                      size="sm"
                      onClick={() => void resolveOrphanDraft("publish")}
                      disabled={resolving !== null || !canEdit}
                    >
                      {resolving === "publish" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      Publish draft
                    </Button>
                  </ViewOnlyTooltip>
                </div>
              )}
            </div>
            {error && (
              <p className="border-b bg-destructive/10 px-5 py-2 text-xs text-destructive">{error}</p>
            )}
            {selected.status === "draft" && (
              <p className="border-b border-amber-800/30 bg-amber-950/20 px-5 py-2 text-xs text-amber-300">
                Draft — not visible to wiki readers. The diff compares it with the current published revision.
              </p>
            )}
            {selected.status === "rejected" && (
              <p className="border-b border-red-800/30 bg-red-950/20 px-5 py-2 text-xs text-red-300">
                Rejected draft — never published to the wiki.
              </p>
            )}
            <ReactDiffViewer
              oldValue={oldBody ?? ""}
              newValue={newBody ?? ""}
              splitView
              compareMethod={DiffMethod.WORDS}
              useDarkTheme={dark}
              leftTitle={
                previous
                  ? `${previous.author} · ${new Date(previous.created_at).toLocaleString()}`
                  : "(empty)"
              }
              rightTitle={`${selected.author} · ${new Date(selected.created_at).toLocaleString()}${selected.status === "draft" ? " · DRAFT" : ""}`}
            />
          </div>
        )}
      </section>
    </div>
  );
}
