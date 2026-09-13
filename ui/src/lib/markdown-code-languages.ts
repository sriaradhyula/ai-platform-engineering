const PORTABLE_LANGUAGE_ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
};

/** Convert editor display names into case-stable Markdown fence identifiers. */
export function normalizeMarkdownCodeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  return PORTABLE_LANGUAGE_ALIASES[normalized] ?? normalized;
}

/** Normalize only opening code-fence info strings, never code content. */
export function normalizeMarkdownCodeFences(markdown: string): string {
  let activeFence: { marker: "`" | "~"; length: number } | null = null;

  return markdown
    .split("\n")
    .map((line) => {
      if (activeFence) {
        const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/);
        if (
          closing &&
          closing[1][0] === activeFence.marker &&
          closing[1].length >= activeFence.length
        ) {
          activeFence = null;
        }
        return line;
      }

      const opening = line.match(/^(\s*)(`{3,}|~{3,})([ \t]*)([^\s`~]+)?(.*)$/);
      if (!opening) return line;

      const fence = opening[2];
      activeFence = {
        marker: fence[0] as "`" | "~",
        length: fence.length,
      };
      if (!opening[4]) return line;

      return `${opening[1]}${fence}${opening[3]}${normalizeMarkdownCodeLanguage(opening[4])}${opening[5]}`;
    })
    .join("\n");
}
