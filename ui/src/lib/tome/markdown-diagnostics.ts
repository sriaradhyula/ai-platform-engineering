import type { Diagnostic } from "@/components/skills/workspace/RichCodeEditor";
import { parseTomeEmbed } from "@/lib/tome/embeds";
import { parseTomeHref } from "@/lib/tome/tome-links";

const EMBED_LANGUAGES = new Set(["vidcast", "youtube", "arxiv", "pdf"]);

export interface TomeMarkdownDiagnosticOptions {
  knownPaths?: ReadonlySet<string>;
}

/** Diagnostics for constructs that can become unsafe, broken, or lossy in rich mode. */
export function diagnoseTomeMarkdown(
  markdown: string,
  options: TomeMarkdownDiagnosticOptions = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (markdown.startsWith("---")) {
    if (!markdown.startsWith("---\n") || markdown.indexOf("\n---", 4) === -1) {
      diagnostics.push({
        from: 0,
        to: Math.min(markdown.length, 3),
        severity: "error",
        message: "Frontmatter must use opening and closing --- delimiters on their own lines.",
      });
    }
  }

  const fenced = /```([^\n`]*)\n([\s\S]*?)(?:\n```|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(markdown)) !== null) {
    const language = match[1].trim().toLowerCase();
    if (!EMBED_LANGUAGES.has(language)) continue;
    const parsed = parseTomeEmbed(language, match[2]);
    if (parsed?.ok === false) {
      diagnostics.push({
        from: match.index,
        to: Math.min(markdown.length, match.index + Math.max(3, match[0].length)),
        severity: "error",
        message: parsed.error,
      });
    }
  }

  const links = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  while ((match = links.exec(markdown)) !== null) {
    const href = match[1];
    const target = parseTomeHref(href);
    if (!target || target.project || !options.knownPaths) continue;
    if (!options.knownPaths.has(target.path)) {
      diagnostics.push({
        from: match.index,
        to: match.index + match[0].length,
        severity: "warning",
        message: `Wiki link does not resolve to an existing page: ${target.path}`,
      });
    }
  }

  const rawHtml = /<(?:iframe|script|style|object|embed|[A-Z][A-Za-z0-9.-]*)\b[^>]*>/g;
  while ((match = rawHtml.exec(markdown)) !== null) {
    diagnostics.push({
      from: match.index,
      to: match.index + match[0].length,
      severity: "warning",
      message: "Raw HTML/MDX is sanitized in preview and may be lost when switching through rich mode. Use a supported embed block instead.",
    });
  }

  const unsupportedEmbed = /```(youtube|vidcast|arxiv|pdf)-[^\s`]*/gi;
  while ((match = unsupportedEmbed.exec(markdown)) !== null) {
    diagnostics.push({
      from: match.index,
      to: match.index + match[0].length,
      severity: "warning",
      message: "Unsupported embed fence. Use youtube, vidcast, arxiv, or pdf exactly.",
    });
  }

  return diagnostics;
}
