const VIDCAST_ORIGIN = "https://app.vidcast.io";
const VIDCAST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDCAST_VIDEO_PATH_RE = /^\/share\/(?:embed\/)?([^/]+)\/?$/i;
const VIDCAST_PLAYLIST_PATH_RE = /^\/playlists\/(?:embed\/)?([^/]+)\/?$/i;
const VIDEO_BOOLEAN_PARAMS = new Set([
  "autoplay",
  "cc",
  "mute",
  "disableCopyDropdown",
  "disableAMA",
]);
const VIDEO_ALLOWED_PARAMS = new Set([...VIDEO_BOOLEAN_PARAMS, "t"]);
const PLAYLIST_BOOLEAN_PARAMS = new Set([
  "autoplay",
  "cc",
  "mute",
  "expand",
  "forceautoplay",
  "loop",
  "disableAMA",
  "enableCopy",
]);
const PLAYLIST_ALLOWED_PARAMS = new Set([
  ...PLAYLIST_BOOLEAN_PARAMS,
  "t",
  "index",
  "ccLang",
  "pageShareId",
  "videoShareId",
]);
const MAX_TITLE_LENGTH = 200;
const MIN_WIDTH_PERCENT = 25;
const MAX_WIDTH_PERCENT = 100;

export interface VidcastEmbed {
  src: string;
  title: string;
  watchUrl: string;
  widthPercent?: number;
  alignment: "left" | "center" | "right";
}

export type VidcastParseResult =
  | { ok: true; value: VidcastEmbed }
  | { ok: false; error: string };

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

/** Convert a public Vidcast share URL into the canonical, safe embed URL. */
export function normalizeVidcastUrl(value: string): {
  src: string;
  watchUrl: string;
  resourceType: "video" | "playlist";
} | null {
  let input: URL;
  try {
    input = new URL(value.trim());
  } catch {
    return null;
  }

  if (
    input.origin !== VIDCAST_ORIGIN ||
    input.username ||
    input.password ||
    input.port ||
    input.hash
  ) {
    return null;
  }

  const videoPath = input.pathname.match(VIDCAST_VIDEO_PATH_RE);
  const playlistPath = input.pathname.match(VIDCAST_PLAYLIST_PATH_RE);
  const resourceType = videoPath ? "video" : playlistPath ? "playlist" : null;
  const id = videoPath?.[1] ?? playlistPath?.[1];
  if (!resourceType || !id || !VIDCAST_ID_RE.test(id)) return null;

  const allowedParams = resourceType === "playlist" ? PLAYLIST_ALLOWED_PARAMS : VIDEO_ALLOWED_PARAMS;
  const booleanParams = resourceType === "playlist" ? PLAYLIST_BOOLEAN_PARAMS : VIDEO_BOOLEAN_PARAMS;
  const seen = new Set<string>();
  for (const [key, parameter] of input.searchParams) {
    if (!allowedParams.has(key) || seen.has(key)) return null;
    seen.add(key);
    if (booleanParams.has(key) && !/^[01]$/.test(parameter)) return null;
    if ((key === "t" || key === "index") && !/^\d+$/.test(parameter)) return null;
    if (key === "ccLang" && !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(parameter)) return null;
    if ((key === "pageShareId" || key === "videoShareId") && !VIDCAST_ID_RE.test(parameter)) return null;
  }

  const canonicalId = id.toLowerCase();
  const pathPrefix = resourceType === "playlist" ? "playlists" : "share";
  const src = new URL(`${VIDCAST_ORIGIN}/${pathPrefix}/embed/${canonicalId}`);
  const watchUrl = new URL(`${VIDCAST_ORIGIN}/${pathPrefix}/${canonicalId}`);
  for (const [key, parameter] of input.searchParams) {
    src.searchParams.set(key, parameter);
    watchUrl.searchParams.set(key, parameter);
  }
  // Vidcast's playlist embed otherwise starts with its video tray collapsed.
  // Show the full playlist by default while preserving an explicit opt-out.
  // Keep this player-only option off the human-facing playlist URL.
  if (resourceType === "playlist" && !src.searchParams.has("expand")) {
    src.searchParams.set("expand", "1");
  }

  return { src: src.toString(), watchUrl: watchUrl.toString(), resourceType };
}

/** Persist the playlist tray preference on any accepted Vidcast playlist URL. */
export function setVidcastPlaylistExpanded(value: string, expanded: boolean): string | null {
  const normalized = normalizeVidcastUrl(value);
  if (normalized?.resourceType !== "playlist") return null;

  const url = new URL(value.trim());
  url.searchParams.set("expand", expanded ? "1" : "0");
  return url.toString();
}

/** Update the URL in a Vidcast fenced block without changing its other fields. */
export function setVidcastBlockPlaylistExpanded(
  content: string,
  expanded: boolean,
): string | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 1 && /^https:\/\//i.test(lines[0].trim())) {
    return setVidcastPlaylistExpanded(lines[0], expanded);
  }

  const urlIndex = lines.findIndex((line) => /^\s*url\s*:/i.test(line));
  if (urlIndex < 0) return null;
  const match = lines[urlIndex].match(/^(\s*url\s*:\s*)(.*?)(\s*)$/i);
  if (!match) return null;
  const rawUrl = unquote(match[2]);
  const url = setVidcastPlaylistExpanded(rawUrl, expanded);
  if (!url) return null;
  lines[urlIndex] = `${match[1]}${url}${match[3]}`;
  return lines.join("\n");
}

/**
 * Parse a `vidcast` fenced block.
 *
 * The block may contain a URL by itself, or `url:` and optional `title:`
 * fields. This intentionally is not general YAML: keeping the accepted shape
 * tiny makes the iframe boundary easy to audit.
 */
export function parseVidcastEmbed(content: string): VidcastParseResult {
  const body = content.trim();
  if (!body) return { ok: false, error: "Vidcast URL is required." };

  let rawUrl = "";
  let title = "";
  let widthPercent: number | undefined;
  let alignment: "left" | "center" | "right" = "center";

  if (!body.includes("\n") && /^https:\/\//i.test(body)) {
    rawUrl = body;
  } else {
    const values = new Map<string, string>();
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!field) {
        return {
          ok: false,
          error: "Use only url:, title:, width:, and align: fields in a Vidcast block.",
        };
      }
      const key = field[1].toLowerCase();
      if (
        (key !== "url" && key !== "title" && key !== "width" && key !== "align") ||
        values.has(key)
      ) {
        return { ok: false, error: `Unsupported or duplicate Vidcast field: ${field[1]}.` };
      }
      values.set(key, unquote(field[2]));
    }
    rawUrl = values.get("url") ?? "";
    title = values.get("title") || title;
    const rawWidth = values.get("width");
    if (rawWidth !== undefined) {
      const match = rawWidth.match(/^(\d{1,3})(?:%)?$/);
      const width = match ? Number(match[1]) : Number.NaN;
      if (
        !Number.isInteger(width) ||
        width < MIN_WIDTH_PERCENT ||
        width > MAX_WIDTH_PERCENT
      ) {
        return {
          ok: false,
          error: `Vidcast width must be between ${MIN_WIDTH_PERCENT}% and ${MAX_WIDTH_PERCENT}%.`,
        };
      }
      widthPercent = width;
    }
    const rawAlignment = values.get("align")?.toLowerCase();
    if (rawAlignment !== undefined) {
      if (rawAlignment !== "left" && rawAlignment !== "center" && rawAlignment !== "right") {
        return { ok: false, error: "Vidcast alignment must be left, center, or right." };
      }
      alignment = rawAlignment;
    }
  }

  if (!rawUrl) return { ok: false, error: "Vidcast URL is required." };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `Vidcast titles must be ${MAX_TITLE_LENGTH} characters or fewer.` };
  }

  const normalized = normalizeVidcastUrl(rawUrl);
  if (!normalized) {
    return {
      ok: false,
      error: "Use an HTTPS app.vidcast.io share or playlist URL with only supported playback options.",
    };
  }

  const { resourceType, ...urls } = normalized;
  return {
    ok: true,
    value: {
      ...urls,
      title: title || (resourceType === "playlist" ? "Vidcast playlist" : "Vidcast video"),
      widthPercent,
      alignment,
    },
  };
}
