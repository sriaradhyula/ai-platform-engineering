/**
 * Page-kind guard — `kind` is code-owned on agent writes (#369, #348).
 *
 * A page's `kind` is a human decision. Users pin or flip it with the UI
 * toggle, which writes through the user-facing route
 * (`PUT /api/tome/projects/[slug]/pages/[...path]`); the ingest agent is told
 * to preserve `stable`/`hidden` pages and rewrite only `dynamic`/`report`
 * ones. Before this guard, `kind` was simply whatever the agent typed into
 * frontmatter, and an admin edit to the page-template config reached the
 * agent as "`<path>` kind changed stable → dynamic in the template; treat it
 * as dynamic going forward". The agent obeyed and rewrote the frontmatter,
 * silently undoing the user's pin — every run, forever. 20 of 77 recorded
 * pins were destroyed that way, across 8 users and 8 projects.
 *
 * The rule enforced here: **an agent write may not change the `kind` of a
 * page that already declares one.** Template kind still governs pages the
 * agent CREATES; from then on the stored value wins until a human changes it.
 *
 * Scope note — only an *explicit* stored `kind:` is protected. A stored page
 * with no `kind` line has no recorded decision to defend, so the agent may
 * stamp one (that is how a page picks up its kind after a frontmatter-less
 * upload). Everything the UI toggle writes is explicit, so every user pin is
 * covered.
 *
 * Server-only in practice, but pure and dependency-light so it unit-tests
 * without a DB.
 */

import { FM_KIND, parseFrontmatter } from "@/lib/tome/schema";
import { PAGE_KINDS, type PageKind } from "@/types/tome";

const FENCE = "---\n";

/** Frontmatter `kind` if the markdown declares a known one, else null. */
export function explicitKind(markdown: string | null | undefined): PageKind | null {
  if (!markdown) return null;
  const [fm] = parseFrontmatter(markdown);
  const raw = fm[FM_KIND];
  if (typeof raw !== "string") return null;
  const kind = raw.trim().toLowerCase();
  return (PAGE_KINDS as readonly string[]).includes(kind) ? (kind as PageKind) : null;
}

/**
 * `markdown` with its frontmatter `kind` set to `kind`, touching nothing else.
 *
 * Deliberately a surgical line rewrite rather than a parse/serialize round
 * trip: agent-authored frontmatter carries block-list arrays, comments, and
 * key orderings that `serializeFrontmatter` would flatten, turning a
 * one-value correction into a whole-page diff in the revision history.
 */
export function withKind(markdown: string, kind: PageKind): string {
  if (!markdown.startsWith(FENCE)) {
    return `${FENCE}${FM_KIND}: ${kind}\n---\n${markdown}`;
  }
  const end = markdown.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    // Unterminated fence — not frontmatter as far as the parser is concerned.
    return `${FENCE}${FM_KIND}: ${kind}\n---\n${markdown}`;
  }
  const block = markdown.slice(FENCE.length, end + 1);
  const rest = markdown.slice(end + 1);
  const lines = block.split("\n");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx === -1) continue;
    if (lines[i].slice(0, idx).trim() !== FM_KIND) continue;
    lines[i] = `${FM_KIND}: ${kind}`;
    replaced = true;
    break;
  }
  if (!replaced) {
    // Keep the trailing empty element produced by the block's final newline.
    lines.splice(Math.max(lines.length - 1, 0), 0, `${FM_KIND}: ${kind}`);
  }
  return FENCE + lines.join("\n") + rest;
}

export interface KindGuardResult {
  /** The markdown to persist — `incoming`, or `incoming` with `kind` restored. */
  markdown: string;
  /** True when the agent tried to change an explicitly declared `kind`. */
  blocked: boolean;
  /** The stored kind that was preserved (only set when `blocked`). */
  storedKind: PageKind | null;
  /** The kind the agent tried to write (only set when `blocked`). */
  attemptedKind: PageKind | null;
}

/**
 * Enforce the rule above for one agent write.
 *
 * `stored` is the page's current live markdown, or null/undefined when the
 * agent is creating the page (in which case its declared kind stands).
 */
export function preserveStoredKind(
  stored: string | null | undefined,
  incoming: string,
): KindGuardResult {
  const storedKind = explicitKind(stored);
  if (storedKind === null) {
    return { markdown: incoming, blocked: false, storedKind: null, attemptedKind: null };
  }
  const attemptedKind = explicitKind(incoming);
  if (attemptedKind === storedKind) {
    return { markdown: incoming, blocked: false, storedKind, attemptedKind };
  }
  return {
    markdown: withKind(incoming, storedKind),
    blocked: true,
    storedKind,
    attemptedKind,
  };
}
