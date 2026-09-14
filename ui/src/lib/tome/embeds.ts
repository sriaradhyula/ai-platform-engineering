import { normalizeVidcastUrl, parseVidcastEmbed } from "@/lib/tome/vidcast";

export type TomeEmbedProvider = "vidcast" | "youtube" | "arxiv" | "pdf";
export type TomeMediaAlignment = "left" | "center" | "right";

export interface TomeEmbedUrlMatch {
  provider: TomeEmbedProvider;
  markdown: string;
}

export interface TomeEmbed {
  provider: TomeEmbedProvider;
  kind: "video" | "document";
  src: string;
  title: string;
  watchUrl: string;
  linkLabel: string;
  /** Responsive width as a percentage of the available editor/page width. */
  widthPercent?: number;
  alignment: TomeMediaAlignment;
}

export type TomeEmbedParseResult =
  | { ok: true; value: TomeEmbed }
  | { ok: false; error: string };

interface EmbedFields {
  url: string;
  title: string;
  widthPercent?: number;
  alignment: TomeMediaAlignment;
}

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,80}$/;
const ARXIV_MODERN_ID_RE = /^\d{4}\.\d{4,5}(?:v\d+)?$/i;
const ARXIV_LEGACY_ID_RE = /^[A-Za-z][A-Za-z0-9.-]*\/\d{7}(?:v\d+)?$/i;
const MAX_TITLE_LENGTH = 200;
export const MIN_EMBED_WIDTH_PERCENT = 25;
export const MAX_EMBED_WIDTH_PERCENT = 100;

function parseWidthPercent(
  value: string | undefined,
  providerLabel: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined || value === "") return { ok: true };
  const match = value.trim().match(/^(\d{1,3})(?:%)?$/);
  const width = match ? Number(match[1]) : Number.NaN;
  if (
    !Number.isInteger(width) ||
    width < MIN_EMBED_WIDTH_PERCENT ||
    width > MAX_EMBED_WIDTH_PERCENT
  ) {
    return {
      ok: false,
      error: `${providerLabel} width must be between ${MIN_EMBED_WIDTH_PERCENT}% and ${MAX_EMBED_WIDTH_PERCENT}%.`,
    };
  }
  return { ok: true, value: width };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function parseEmbedFields(
  content: string,
  providerLabel: string,
  defaultTitle: string,
): { ok: true; value: EmbedFields } | { ok: false; error: string } {
  const body = content.trim();
  if (!body) return { ok: false, error: `${providerLabel} URL is required.` };

  let url = "";
  let title = defaultTitle;
  let widthPercent: number | undefined;
  let alignment: TomeMediaAlignment = "center";
  const usesFields =
    body.includes("\n") || /^[A-Za-z][A-Za-z0-9_-]*:\s*/.test(body);
  if (!usesFields) {
    url = body;
  } else {
    const values = new Map<string, string>();
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!field) {
        return {
          ok: false,
          error: `Use only url:, title:, width:, and align: fields in a ${providerLabel} block.`,
        };
      }
      const key = field[1].toLowerCase();
      if (
        (key !== "url" && key !== "title" && key !== "width" && key !== "align") ||
        values.has(key)
      ) {
        return {
          ok: false,
          error: `Unsupported or duplicate ${providerLabel} field: ${field[1]}.`,
        };
      }
      values.set(key, unquote(field[2]));
    }
    url = values.get("url") ?? "";
    title = values.get("title") || title;
    const width = parseWidthPercent(values.get("width"), providerLabel);
    if (width.ok === false) return width;
    widthPercent = width.value;
    const rawAlignment = values.get("align")?.toLowerCase();
    if (rawAlignment !== undefined) {
      if (rawAlignment !== "left" && rawAlignment !== "center" && rawAlignment !== "right") {
        return {
          ok: false,
          error: `${providerLabel} alignment must be left, center, or right.`,
        };
      }
      alignment = rawAlignment;
    }
  }

  if (!url) return { ok: false, error: `${providerLabel} URL is required.` };
  if (title.length > MAX_TITLE_LENGTH) {
    return {
      ok: false,
      error: `${providerLabel} titles must be ${MAX_TITLE_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value: { url, title, widthPercent, alignment } };
}

function parseTime(value: string | null): string | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return value;
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || !match.slice(1).some(Boolean)) return null;
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  return String(seconds);
}

/** Normalize common YouTube share, watch, shorts, and embed URLs. */
export function normalizeYouTubeUrl(value: string): {
  src: string;
  watchUrl: string;
} | null {
  let input: URL;
  try {
    input = new URL(value.trim());
  } catch {
    return null;
  }

  if (
    input.protocol !== "https:" ||
    input.username ||
    input.password ||
    input.port ||
    input.hash
  ) {
    return null;
  }

  const host = input.hostname.toLowerCase();
  let videoId = "";
  let playlistId = "";
  if (host === "youtu.be") {
    videoId = input.pathname.match(/^\/([^/]+)\/?$/)?.[1] ?? "";
  } else if (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "www.youtube-nocookie.com"
  ) {
    if (input.pathname === "/watch") {
      videoId = input.searchParams.get("v") ?? "";
      playlistId = input.searchParams.get("list") ?? "";
    }
    else if (input.pathname === "/playlist") playlistId = input.searchParams.get("list") ?? "";
    else if (input.pathname === "/embed/videoseries") {
      playlistId = input.searchParams.get("list") ?? "";
    }
    else videoId = input.pathname.match(/^\/(?:embed|shorts)\/([^/]+)\/?$/)?.[1] ?? "";
  } else {
    return null;
  }
  if (!YOUTUBE_VIDEO_ID_RE.test(videoId) && !YOUTUBE_PLAYLIST_ID_RE.test(playlistId)) return null;
  if (playlistId && !YOUTUBE_PLAYLIST_ID_RE.test(playlistId)) return null;

  const start = parseTime(input.searchParams.get("start") ?? input.searchParams.get("t"));
  if ((input.searchParams.has("start") || input.searchParams.has("t")) && start === null) {
    return null;
  }

  const src = new URL(
    videoId
      ? `https://www.youtube-nocookie.com/embed/${videoId}`
      : "https://www.youtube-nocookie.com/embed/videoseries",
  );
  const watchUrl = new URL(videoId ? "https://www.youtube.com/watch" : "https://www.youtube.com/playlist");
  if (videoId) watchUrl.searchParams.set("v", videoId);
  if (playlistId) {
    src.searchParams.set("list", playlistId);
    watchUrl.searchParams.set("list", playlistId);
  }
  if (start && start !== "0") {
    src.searchParams.set("start", start);
    watchUrl.searchParams.set("t", start);
  }
  for (const key of ["autoplay", "controls", "mute", "rel"] as const) {
    const parameter = input.searchParams.get(key);
    if (parameter !== null) {
      if (!/^[01]$/.test(parameter)) return null;
      src.searchParams.set(key, parameter);
    }
  }
  if (input.searchParams.has("cc_load_policy")) {
    if (input.searchParams.get("cc_load_policy") !== "1") return null;
    src.searchParams.set("cc_load_policy", "1");
  }

  return { src: src.toString(), watchUrl: watchUrl.toString() };
}

/** Validate a direct HTTPS PDF URL. The fallback source link always remains visible. */
export function normalizePdfUrl(value: string): { src: string; watchUrl: string } | null {
  let input: URL;
  try {
    input = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    input.protocol !== "https:" ||
    input.username ||
    input.password ||
    input.port ||
    input.hash ||
    !input.pathname.toLowerCase().endsWith(".pdf")
  ) {
    return null;
  }
  return { src: input.toString(), watchUrl: input.toString() };
}

function quoteField(value: string): string {
  return JSON.stringify(value);
}

/** Portable canonical representation persisted in Tome Markdown revisions. */
export function serializeTomeEmbedBlock(
  provider: TomeEmbedProvider,
  url: string,
  title?: string,
  widthPercent?: number,
  alignment: TomeMediaAlignment = "center",
): string {
  const lines = [`url: ${url.trim()}`];
  if (title?.trim()) lines.push(`title: ${quoteField(title.trim())}`);
  if (widthPercent !== undefined && widthPercent < MAX_EMBED_WIDTH_PERCENT) {
    const width = Math.min(
      MAX_EMBED_WIDTH_PERCENT,
      Math.max(MIN_EMBED_WIDTH_PERCENT, Math.round(widthPercent)),
    );
    lines.push(`width: ${width}%`);
  }
  if (alignment !== "center") lines.push(`align: ${alignment}`);
  return `\`\`\`${provider}\n${lines.join("\n")}\n\`\`\``;
}

/**
 * Recognize a standalone, safe media URL and convert it to Tome's portable
 * fenced-block representation. This is intentionally URL-only: ordinary
 * prose, Markdown links, and provider-like text must retain normal paste
 * behavior.
 */
export function matchTomeEmbedUrl(value: string): TomeEmbedUrlMatch | null {
  const url = value.trim();
  if (!url || /\s/.test(url)) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  let provider: TomeEmbedProvider | null = null;
  if (normalizeVidcastUrl(url)) provider = "vidcast";
  else if (normalizeYouTubeUrl(url)) provider = "youtube";
  // Check arXiv before generic PDF so an arXiv PDF retains paper semantics
  // and links back to its abstract page.
  else if (normalizeArxivUrl(url)) provider = "arxiv";
  else if (normalizePdfUrl(url)) provider = "pdf";

  if (!provider) return null;
  return {
    provider,
    markdown: `\n\n${serializeTomeEmbedBlock(provider, url)}\n\n`,
  };
}

function normalizeArxivId(value: string): string | null {
  const candidate = value.replace(/^arxiv:/i, "").replace(/\.pdf$/i, "").trim();
  if (!ARXIV_MODERN_ID_RE.test(candidate) && !ARXIV_LEGACY_ID_RE.test(candidate)) return null;
  return candidate;
}

/** Normalize an arXiv identifier or abs, HTML, or PDF URL to its PDF. */
export function normalizeArxivUrl(value: string): {
  src: string;
  watchUrl: string;
} | null {
  const directId = normalizeArxivId(value);
  if (directId) {
    return {
      src: `https://arxiv.org/pdf/${directId}`,
      watchUrl: `https://arxiv.org/abs/${directId}`,
    };
  }

  let input: URL;
  try {
    input = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    input.protocol !== "https:" ||
    (input.hostname !== "arxiv.org" && input.hostname !== "www.arxiv.org") ||
    input.username ||
    input.password ||
    input.port ||
    input.search ||
    input.hash
  ) {
    return null;
  }

  const path = input.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)\/?$/i);
  let decodedPath = "";
  try {
    decodedPath = path ? decodeURIComponent(path[1]) : "";
  } catch {
    return null;
  }
  const id = normalizeArxivId(decodedPath);
  if (!id) return null;
  return {
    src: `https://arxiv.org/pdf/${id}`,
    watchUrl: `https://arxiv.org/abs/${id}`,
  };
}

export function parseTomeEmbed(
  language: string,
  content: string,
): TomeEmbedParseResult | null {
  const provider = language.trim().toLowerCase() as TomeEmbedProvider;
  if (provider === "vidcast") {
    const parsed = parseVidcastEmbed(content);
    if (parsed.ok === false) return parsed;
    return {
      ok: true,
      value: {
        ...parsed.value,
        provider,
        kind: "video",
        linkLabel: parsed.value.src.includes("/playlists/embed/")
          ? "Open playlist on Vidcast"
          : "Watch on Vidcast",
        alignment: parsed.value.alignment,
      },
    };
  }

  if (provider !== "youtube" && provider !== "arxiv" && provider !== "pdf") return null;
  const label = provider === "youtube" ? "YouTube" : provider === "arxiv" ? "arXiv" : "PDF";
  const fields = parseEmbedFields(
    content,
    label,
    provider === "youtube" ? "YouTube video or playlist" : provider === "arxiv" ? "arXiv paper" : "PDF document",
  );
  if (fields.ok === false) return fields;
  const normalized =
    provider === "youtube"
      ? normalizeYouTubeUrl(fields.value.url)
      : provider === "arxiv"
        ? normalizeArxivUrl(fields.value.url)
        : normalizePdfUrl(fields.value.url);
  if (!normalized) {
    return {
      ok: false,
      error:
        provider === "youtube"
          ? "Use a valid HTTPS YouTube video or playlist URL with supported playback options."
          : provider === "arxiv"
            ? "Use a valid arXiv identifier or HTTPS abs, HTML, or PDF URL."
            : "Use a direct HTTPS URL ending in .pdf.",
    };
  }

  return {
    ok: true,
    value: {
      ...normalized,
      provider,
      kind: provider === "youtube" ? "video" : "document",
      title: fields.value.title,
      linkLabel: provider === "youtube" ? "Watch on YouTube" : provider === "arxiv" ? "Open on arXiv" : "Open PDF",
      widthPercent: fields.value.widthPercent,
      alignment: fields.value.alignment,
    },
  };
}
