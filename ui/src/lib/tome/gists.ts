/** Trim freeform gist tags and drop empty or duplicate values. */
export function normalizeGistTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const tag of input) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** Derive a stable, readable Markdown filename for legacy or newly-created gists. */
export function defaultGistFilename(title: string): string {
  const stem = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `${stem || "gist"}.md`;
}

/** Validate a user-authored flat Markdown filename and add `.md` when omitted. */
export function normalizeGistFilename(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Filename must be a non-empty string");
  }
  let filename = input.trim();
  if (filename.length > 160) throw new Error("Filename must be 160 characters or fewer");
  if (/[\\/\0\r\n]/.test(filename) || filename === "." || filename === "..") {
    throw new Error("Filename must be a file name, not a path");
  }
  if (!/\.mdx?$/i.test(filename)) filename += ".md";
  if (!filename.replace(/\.mdx?$/i, "").trim()) {
    throw new Error("Filename must include a name before the extension");
  }
  return filename;
}
