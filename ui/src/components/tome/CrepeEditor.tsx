"use client";

// Thin wrapper around Milkdown's Crepe WYSIWYG editor. Client-only.

import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "./crepe-theme.css";
import { editorViewCtx, remarkPluginsCtx } from "@milkdown/kit/core";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import { redo, undo } from "@milkdown/kit/prose/history";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { Fragment, type Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import type { Node as MarkdownAstNode } from "@milkdown/transformer";
import {
  hardbreakSchema,
  htmlAttr,
  htmlSchema,
  linkAttr,
} from "@milkdown/kit/preset/commonmark";
import { $prose, insert, markdownToSlice, replaceAll } from "@milkdown/utils";
import { Minus, Plus } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { classifyCitationHref } from "@/lib/tome/citations";
import { renderInlineMarkdown } from "@/components/shared/timeline/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { TomeMediaInsertDialog } from "@/components/tome/TomeMediaInsertDialog";
import { normalizeMarkdownCodeFences } from "@/lib/markdown-code-languages";
import {
  hydrateEmbedPreviews,
  imageFileToDataUrl,
  mediaAlignmentControlsMarkup,
  renderTomeCodePreview,
} from "@/lib/tome/editor-media";
import {
  MAX_EMBED_WIDTH_PERCENT,
  MIN_EMBED_WIDTH_PERCENT,
  matchTomeEmbedUrl,
  type TomeMediaAlignment,
} from "@/lib/tome/embeds";
import { setVidcastBlockPlaylistExpanded } from "@/lib/tome/vidcast";
import { serializeTomeColumns, TOME_COLUMN_MARKER } from "@/lib/tome/page-columns";
import {
  parseTomeHref,
  wikiRoute,
  type GlossaryPreview,
  type GlossaryResolver,
} from "@/lib/tome/tome-links";

export type { GlossaryPreview } from "@/lib/tome/tome-links";

export type CrepeEditorHandle = {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  insertMarkdown: (md: string) => void;
  /** Current text selection, retained while an editor popover has focus. */
  getSelectedText: () => string;
  /** Retain and visibly mark the current selection while another control has focus. */
  captureSelection: () => void;
  /** Restore a retained selection after a popover is discarded. */
  restoreSelection: () => void;
  /** Replace the current selection, or insert at the cursor when it is empty. */
  replaceSelection: (md: string) => void;
};

type Props = {
  initialMarkdown: string;
  readonly?: boolean;
  /**
   * When true, updates to `initialMarkdown` are applied to the live editor
   * (via Milkdown's replaceAll command) rather than ignored. Default false:
   * the wiki editor reads the value once at mount and remounts on key change
   * to avoid clobbering in-flight user edits. Streaming surfaces (chat) set
   * this to true so token-by-token updates flow into the same instance.
   */
  liveUpdate?: boolean;
  /**
   * Called when an internal wiki link (`tome://<path>` or a bare `*.md`) is
   * clicked, instead of opening it in a new tab. The host routes it via SPA
   * navigation. External links always open in a new tab.
   */
  onNavigate?: (path: string) => void;
  /**
   * Resolve a glossary term slug to its definition for the hover card.
   * Synchronous — the host already has all pages loaded. Return null if the
   * term has no entry. When omitted, glossary links still render + navigate,
   * just without a hovercard.
   */
  glossaryPreview?: GlossaryResolver;
  /**
   * Hide rendered HTML-comment nodes (e.g. agent-only sourcing guidance
   * seeded into a page body). Milkdown renders `<!-- ... -->` as visible
   * text by default — this is off for the admin template editor's seed-body
   * fields (the admin needs to see/edit the raw guidance) and on for the
   * live wiki view (end users should never see it).
   */
  hideHtmlComments?: boolean;
  /** Called after every user-visible document update. */
  onChange?: (markdown: string) => void;
  /** Show Crepe's full formatting toolbar above editable documents. */
  showToolbar?: boolean;
  /** Open a host-owned media picker. Defaults to Crepe's built-in picker. */
  onInsertMedia?: () => void;
  /** Open the host AI Assist flow for the current non-empty selection. */
  onEnhanceSelection?: () => void;
  /** Offer responsive two- and three-column page sections. */
  enableColumns?: boolean;
};

const MERMAID_ZOOM_MIN = 25;
const MERMAID_ZOOM_MAX = 200;
const MERMAID_ZOOM_STEP = 25;
const TOME_MEDIA_ICON = [
  '<svg data-tome-media-icon="true" viewBox="0 0 24 24" fill="none"',
  ' xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"',
  ' stroke-linecap="round" stroke-linejoin="round">',
  '<rect width="16" height="14" x="5" y="4" rx="2"/>',
  '<path d="M3 8v10a2 2 0 0 0 2 2h12"/>',
  '<path data-tome-media-play="true" d="m11 8 5 3-5 3Z"/>',
  "</svg>",
].join("");
const TOME_BULLET_LIST_ICON = [
  '<svg data-tome-bullet-list-icon="true" xmlns="http://www.w3.org/2000/svg"',
  ' width="24" height="24" viewBox="0 0 24 24">',
  '<path d="M4 10.5A1.5 1.5 0 1 0 4 13.5a1.5 1.5 0 0 0 0-3Zm0-6A1.5 1.5 0 1 0 4 7.5a1.5 1.5 0 0 0 0-3Zm0 12A1.5 1.5 0 1 0 4 19.5a1.5 1.5 0 0 0 0-3ZM8 19h12a1 1 0 1 0 0-2H8a1 1 0 1 0 0 2Zm0-6h12a1 1 0 1 0 0-2H8a1 1 0 1 0 0 2ZM7 6a1 1 0 0 0 1 1h12a1 1 0 1 0 0-2H8a1 1 0 0 0-1 1Z"/>',
  "</svg>",
].join("");
const TOME_UNDO_ICON = [
  '<svg data-tome-undo-icon="true" viewBox="0 0 24 24" fill="none"',
  ' xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"',
  ' stroke-linecap="round" stroke-linejoin="round">',
  '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  "</svg>",
].join("");
const TOME_REDO_ICON = [
  '<svg data-tome-redo-icon="true" viewBox="0 0 24 24" fill="none"',
  ' xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"',
  ' stroke-linecap="round" stroke-linejoin="round">',
  '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  "</svg>",
].join("");
const TOME_AI_ICON = [
  '<svg data-tome-ai-icon="true" viewBox="0 0 24 24" fill="none"',
  ' xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"',
  ' stroke-linecap="round" stroke-linejoin="round">',
  '<path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z"/>',
  '<path d="m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L22 17l-2.2-.8L19 14Z"/>',
  '<path d="M5 3v4M3 5h4"/>',
  "</svg>",
].join("");
const TOME_COLUMNS_ICON = [
  '<svg data-tome-columns-icon="true" viewBox="0 0 24 24" fill="none"',
  ' xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"',
  ' stroke-linecap="round" stroke-linejoin="round">',
  '<rect x="3" y="4" width="7" height="16" rx="1"/>',
  '<rect x="14" y="4" width="7" height="16" rx="1"/>',
  "</svg>",
].join("");

type PendingAiSelection = { from: number; to: number } | null;

const pendingAiSelectionKey = new PluginKey<PendingAiSelection>(
  "tome-pending-ai-selection",
);

const pendingAiSelectionPlugin = $prose(
  () =>
    new Plugin<PendingAiSelection>({
      key: pendingAiSelectionKey,
      state: {
        init: () => null,
        apply: (transaction, current) => {
          const next = transaction.getMeta(pendingAiSelectionKey) as
            | PendingAiSelection
            | undefined;
          if (next !== undefined) return next;
          if (!current) return null;
          return {
            from: transaction.mapping.map(current.from),
            to: transaction.mapping.map(current.to),
          };
        },
      },
      props: {
        decorations: (state) => {
          const selection = pendingAiSelectionKey.getState(state);
          if (!selection || selection.from === selection.to) return null;
          return DecorationSet.create(state.doc, [
            Decoration.inline(selection.from, selection.to, {
              class: "tome-pending-ai-selection",
            }),
          ]);
        },
      },
    }),
);

function isTomeColumnNode(node: ProseMirrorNode): boolean {
  const first = node.firstChild;
  return node.type.name === "blockquote" &&
    first?.type.name === "paragraph" &&
    first.textContent.trim().toLowerCase() === TOME_COLUMN_MARKER;
}

function isTomeColumnSeparatorNode(node: ProseMirrorNode): boolean {
  if (node.type.name !== "paragraph") return false;
  const content = node.textContent.trim().toLowerCase();
  return content === "" || /^<br\s*\/?\s*>$/.test(content);
}

const tomeColumnsPlugin = $prose(
  () =>
    new Plugin({
      appendTransaction: (transactions, _oldState, state) => {
        if (!transactions.some((transaction) => transaction.docChanged)) return null;

        const topLevel: Array<{ node: ProseMirrorNode; position: number }> = [];
        state.doc.forEach((node, position) => topLevel.push({ node, position }));
        const repairs: Array<{
          column: ProseMirrorNode;
          from: number;
          separators: ProseMirrorNode[];
          to: number;
        }> = [];

        for (let index = 0; index < topLevel.length - 1; index += 1) {
          const current = topLevel[index];
          if (!isTomeColumnNode(current.node)) continue;
          const separators: ProseMirrorNode[] = [];
          let nextIndex = index + 1;
          while (
            nextIndex < topLevel.length &&
            isTomeColumnSeparatorNode(topLevel[nextIndex].node)
          ) {
            separators.push(topLevel[nextIndex].node);
            nextIndex += 1;
          }
          const nextColumn = topLevel[nextIndex];
          if (separators.length && nextColumn && isTomeColumnNode(nextColumn.node)) {
            repairs.push({
              column: current.node,
              from: current.position,
              separators,
              to: nextColumn.position,
            });
          }
        }
        if (!repairs.length) return null;

        let transaction = state.tr;
        repairs.reverse().forEach(({ column, from, separators, to }) => {
          const content = column.content.append(Fragment.fromArray(separators));
          transaction = transaction.replaceWith(from, to, column.copy(content));
        });
        return transaction.docChanged ? transaction : null;
      },
      props: {
        decorations: (state) => {
          const topLevel: Array<{ node: ProseMirrorNode; position: number }> = [];
          state.doc.forEach((node, position) => topLevel.push({ node, position }));
          const decorations: Decoration[] = [];

          for (let start = 0; start < topLevel.length;) {
            if (!isTomeColumnNode(topLevel[start].node)) {
              start += 1;
              continue;
            }
            const columnIndexes = [start];
            const separatorIndexes: number[] = [];
            let pendingSeparatorIndexes: number[] = [];
            let end = start + 1;
            while (end < topLevel.length) {
              const candidate = topLevel[end].node;
              if (isTomeColumnSeparatorNode(candidate)) {
                pendingSeparatorIndexes.push(end);
                end += 1;
                continue;
              }
              if (isTomeColumnNode(candidate)) {
                separatorIndexes.push(...pendingSeparatorIndexes);
                pendingSeparatorIndexes = [];
                columnIndexes.push(end);
                end += 1;
                continue;
              }
              break;
            }
            const count = columnIndexes.length;
            if (count >= 2 && count <= 3) {
              columnIndexes.forEach((index, columnIndex) => {
                const { node, position } = topLevel[index];
                decorations.push(
                  Decoration.node(position, position + node.nodeSize, {
                    class: "tome-column tome-column-editable",
                    "data-column-count": String(count),
                    "data-column-index": String(columnIndex + 1),
                  }),
                );
                const marker = node.firstChild;
                if (marker) {
                  const markerPosition = position + 1;
                  decorations.push(
                    Decoration.node(markerPosition, markerPosition + marker.nodeSize, {
                      class: "tome-column-marker",
                    }),
                  );
                }
              });
              separatorIndexes.forEach((index) => {
                const { node, position } = topLevel[index];
                decorations.push(
                  Decoration.node(position, position + node.nodeSize, {
                    class: "tome-column-separator",
                  }),
                );
              });
            }
            start = end;
          }

          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
);

function capturePendingAiSelection(view: EditorView): void {
  const { from, to } = view.state.selection;
  view.dispatch(view.state.tr.setMeta(pendingAiSelectionKey, { from, to }));
}

function getPendingAiSelection(view: EditorView): PendingAiSelection {
  return pendingAiSelectionKey.getState(view.state) ?? null;
}

function restorePendingAiSelection(view: EditorView): boolean {
  const selection = getPendingAiSelection(view);
  if (!selection) return false;
  const maxPosition = view.state.doc.content.size;
  const from = Math.min(selection.from, maxPosition);
  const to = Math.min(selection.to, maxPosition);
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, from, to))
      .setMeta(pendingAiSelectionKey, null),
  );
  view.focus();
  return true;
}

type MutableMarkdownAstNode = MarkdownAstNode & {
  children?: MutableMarkdownAstNode[];
  value?: string;
};

function restoreTableCellBreaks(node: MarkdownAstNode, insideTableCell = false): void {
  const current = node as MutableMarkdownAstNode;
  const isTableCell = insideTableCell || current.type === "tableCell";
  current.children?.forEach((child) => {
    if (
      isTableCell &&
      child.type === "html" &&
      typeof child.value === "string" &&
      /^<br\s*\/?\s*>$/i.test(child.value.trim())
    ) {
      child.type = "break";
      delete child.value;
      return;
    }
    restoreTableCellBreaks(child as MarkdownAstNode, isTableCell);
  });
}

type SelectionPosition = {
  depth: number;
  node: (depth: number) => { type: { name: string }; textContent?: string };
};

function isInTableCell($position: SelectionPosition): boolean {
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const name = $position.node(depth).type.name;
    if (name === "table_cell" || name === "table_header") return true;
  }
  return false;
}

function normalizeTableCellLine(line: string): string {
  return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
}

/** Insert portable inline content into a GFM table cell. */
function insertTableCellLines(crepe: Crepe, lines: string[]): boolean {
  let handled = false;
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!isInTableCell(view.state.selection.$from)) return;
    const hardbreak = view.state.schema.nodes.hardbreak;
    if (!hardbreak) return;

    handled = true;
    let transaction = view.state.tr.deleteSelection();
    lines.forEach((line, index) => {
      if (index > 0) {
        transaction = transaction.replaceSelectionWith(hardbreak.create());
      }
      const normalized = normalizeTableCellLine(line);
      if (normalized) transaction = transaction.insertText(normalized);
    });
    view.dispatch(transaction.scrollIntoView());
  });
  return handled;
}

function insertTableCellBullet(crepe: Crepe): boolean {
  let handled = false;
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { selection } = view.state;
    if (!isInTableCell(selection.$from)) return;
    handled = true;
    if (selection.empty !== false || selection.from === selection.to) {
      view.dispatch(view.state.tr.insertText("• ", selection.from).scrollIntoView());
      return;
    }

    // A GFM table cell cannot contain a block list. When multiple visual
    // lines in the same cell are selected, toggle portable inline bullets on
    // every selected hardbreak-delimited line instead of only at `from`.
    const { $from, $to } = selection;
    if ($from.parent !== $to.parent) return;
    const paragraph = $from.parent;
    const lineStarts = [0];
    paragraph.forEach((node, offset) => {
      if (node.type.name === "hardbreak") lineStarts.push(offset + node.nodeSize);
    });

    const startOffset = $from.parentOffset;
    const endOffset = Math.max(startOffset, $to.parentOffset - 1);
    const selectedStarts = lineStarts.filter((lineStart, index) => {
      const nextStart = lineStarts[index + 1] ?? paragraph.content.size + 1;
      return lineStart <= endOffset && nextStart > startOffset;
    });
    if (selectedStarts.length === 0) return;

    const markerAt = (lineStart: number) =>
      paragraph.textBetween(
        lineStart,
        Math.min(lineStart + 2, paragraph.content.size),
        "",
        "",
      );
    const removeBullets = selectedStarts.every((lineStart) => markerAt(lineStart) === "• ");
    const paragraphStart = $from.start();
    let transaction = view.state.tr;
    [...selectedStarts].reverse().forEach((lineStart) => {
      const position = paragraphStart + lineStart;
      const marker = markerAt(lineStart);
      if (removeBullets) {
        transaction = transaction.delete(position, position + 2);
      } else if (marker === "• ") {
        return;
      } else if (/^[-*+] $/.test(marker)) {
        transaction = transaction.insertText("• ", position, position + 2);
      } else {
        transaction = transaction.insertText("• ", position);
      }
    });
    view.dispatch(transaction.scrollIntoView());
  });
  return handled;
}

function insertTableCellLineBreak(crepe: Crepe): boolean {
  let handled = false;
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { selection } = view.state;
    if (!isInTableCell(selection.$from)) return;
    const hardbreak = view.state.schema.nodes.hardbreak;
    if (!hardbreak) return;

    handled = true;
    const continueBullet = selection.$from.parent.textContent.trimStart().startsWith("• ");
    let transaction = view.state.tr.replaceSelectionWith(hardbreak.create());
    if (continueBullet) transaction = transaction.insertText("• ");
    view.dispatch(transaction.scrollIntoView());
  });
  return handled;
}

/**
 * Delete the top-level document node that contains `dom` (an image block or
 * an embed/mermaid code block). Editing-only: callers must gate on
 * `!readonly` first, since Crepe still resolves DOM positions in a read-only
 * view even though the transaction would be inert there.
 */
function deleteTopLevelBlockAtDom(crepe: Crepe, dom: Element): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const pos = view.posAtDOM(dom, 0);
    const $pos = view.state.doc.resolve(pos);
    if ($pos.depth === 0) {
      // Image node views map their outer wrapper to the document position
      // immediately before the node rather than to a position inside it.
      const node = $pos.nodeAfter;
      if (!node) return;
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
      return;
    }
    const start = $pos.before(1);
    const node = $pos.node(1);
    view.dispatch(view.state.tr.delete(start, start + node.nodeSize));
  });
}

function clampMediaWidth(width: number): number {
  return Math.min(
    MAX_EMBED_WIDTH_PERCENT,
    Math.max(MIN_EMBED_WIDTH_PERCENT, Math.round(width)),
  );
}

function withEmbedWidth(content: string, widthPercent: number): string {
  const lines = content
    .trim()
    .split(/\r?\n/)
    .filter((line) => !/^\s*width\s*:/i.test(line));
  const width = clampMediaWidth(widthPercent);
  if (width < MAX_EMBED_WIDTH_PERCENT) lines.push(`width: ${width}%`);
  return lines.join("\n");
}

function withEmbedAlignment(content: string, alignment: TomeMediaAlignment): string {
  const lines = content
    .trim()
    .split(/\r?\n/)
    .filter((line) => !/^\s*align\s*:/i.test(line));
  if (alignment !== "center") lines.push(`align: ${alignment}`);
  return lines.join("\n");
}

function persistMediaWidthAtDom(crepe: Crepe, dom: HTMLElement, widthPercent: number): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const domPos = view.posAtDOM(dom, 0);
    const $pos = view.state.doc.resolve(domPos);
    const pos = $pos.depth === 0 ? domPos : $pos.before(1);
    const node = $pos.depth === 0 ? $pos.nodeAfter : $pos.node(1);
    if (!node) return;

    const width = clampMediaWidth(widthPercent);
    if (node.type.name === "image-block") {
      view.dispatch(view.state.tr.setNodeAttribute(pos, "ratio", width / 100));
      return;
    }
    if (node.type.name !== "code_block") return;

    const content = withEmbedWidth(node.textContent, width);
    const replacement = node.type.create(
      node.attrs,
      content ? view.state.schema.text(content) : undefined,
      node.marks,
    );
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, replacement));
  });
}

function persistVidcastPlaylistExpandedAtDom(
  crepe: Crepe,
  dom: HTMLElement,
  expanded: boolean,
): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const domPos = view.posAtDOM(dom, 0);
    const $pos = view.state.doc.resolve(domPos);
    const pos = $pos.depth === 0 ? domPos : $pos.before(1);
    const node = $pos.depth === 0 ? $pos.nodeAfter : $pos.node(1);
    if (!node || node.type.name !== "code_block") return;

    const content = setVidcastBlockPlaylistExpanded(node.textContent, expanded);
    if (!content) return;
    const replacement = node.type.create(
      node.attrs,
      view.state.schema.text(content),
      node.marks,
    );
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, replacement));
  });
}

function persistMediaAlignmentAtDom(
  crepe: Crepe,
  dom: HTMLElement,
  alignment: TomeMediaAlignment,
): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const domPos = view.posAtDOM(dom, 0);
    const $pos = view.state.doc.resolve(domPos);
    const pos = $pos.depth === 0 ? domPos : $pos.before(1);
    const node = $pos.depth === 0 ? $pos.nodeAfter : $pos.node(1);
    if (!node) return;
    if (node.type.name === "image-block") {
      view.dispatch(view.state.tr.setNodeAttribute(pos, "alignment", alignment));
      return;
    }
    if (node.type.name !== "code_block") return;

    const content = withEmbedAlignment(node.textContent, alignment);
    const replacement = node.type.create(
      node.attrs,
      content ? view.state.schema.text(content) : undefined,
      node.marks,
    );
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, replacement));
  });
}

function applyMediaAlignment(dom: HTMLElement, alignment: TomeMediaAlignment): void {
  dom.dataset.mediaAlign = alignment;
  dom.querySelectorAll<HTMLElement>(".tome-media-align").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.align === alignment));
  });
}

function applyMediaWidth(dom: HTMLElement, widthPercent: number): void {
  const width = clampMediaWidth(widthPercent);
  if (dom.classList.contains("tome-embed-preview")) {
    dom.style.setProperty("--tome-media-width", `${width}%`);
    dom.dataset.embedWidth = String(width);
  } else if (width < MAX_EMBED_WIDTH_PERCENT) {
    dom.style.setProperty("--tome-media-width", `${width}%`);
    dom.dataset.mediaWidth = String(width);
  } else {
    dom.style.removeProperty("--tome-media-width");
    delete dom.dataset.mediaWidth;
  }
  const handle = dom.querySelector<HTMLElement>(".tome-media-resize");
  handle?.setAttribute("aria-valuenow", String(width));
  const label = handle?.querySelector<HTMLElement>(".tome-media-size-label");
  if (label) label.textContent = `${width}%`;
}

function readImageWidthAtDom(crepe: Crepe, dom: HTMLElement): number {
  let width = MAX_EMBED_WIDTH_PERCENT;
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const domPos = view.posAtDOM(dom, 0);
    const $pos = view.state.doc.resolve(domPos);
    const node = $pos.depth === 0 ? $pos.nodeAfter : $pos.node(1);
    const ratio = Number(node?.attrs?.ratio);
    if (Number.isFinite(ratio) && ratio > 0) width = clampMediaWidth(ratio * 100);
  });
  return width;
}

function readImageAlignmentAtDom(crepe: Crepe, dom: HTMLElement): TomeMediaAlignment {
  let alignment: TomeMediaAlignment = "center";
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const domPos = view.posAtDOM(dom, 0);
    const $pos = view.state.doc.resolve(domPos);
    const node = $pos.depth === 0 ? $pos.nodeAfter : $pos.node(1);
    const value = node?.attrs?.alignment;
    if (value === "left" || value === "right") alignment = value;
  });
  return alignment;
}

function parseImageLayoutMetadata(value: string): {
  ratio: number;
  alignment: TomeMediaAlignment;
} {
  const [rawRatio, rawAlignment] = value.split("|", 2);
  const parsedRatio = Number(rawRatio || 1);
  const ratio = Number.isFinite(parsedRatio) && parsedRatio > 0 ? parsedRatio : 1;
  const alignment =
    rawAlignment === "left" || rawAlignment === "right" ? rawAlignment : "center";
  return { ratio, alignment };
}

function serializeImageLayoutMetadata(
  ratio: number,
  alignment: TomeMediaAlignment,
): string {
  const value = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const serializedRatio = Number.parseFloat(value.toFixed(2)).toString();
  return alignment === "center" ? serializedRatio : `${serializedRatio}|${alignment}`;
}

/**
 * Thin wrapper around Crepe. Mounts on the host div, exposes a ref handle
 * the parent can call to read the current markdown out (for save).
 *
 * IMPORTANT: this component does not re-create the editor when
 * `initialMarkdown` changes — that would clobber unsaved edits. Parents
 * should remount (via `key` prop) if they want a hard reset.
 */
export const CrepeEditor = forwardRef<CrepeEditorHandle, Props>(function CrepeEditor(
  {
    initialMarkdown,
    readonly = false,
    liveUpdate = false,
    onNavigate,
    glossaryPreview,
    hideHtmlComments = false,
    onChange,
    showToolbar,
    onInsertMedia,
    onEnhanceSelection,
    enableColumns = false,
  },
  ref,
) {
  const { toast } = useToast();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const readyRef = useRef(false);
  const [expandedMermaid, setExpandedMermaid] = useState<{
    svg: string;
    width: number;
  } | null>(null);
  const [mermaidZoom, setMermaidZoom] = useState(100);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  // Latest callbacks, read by the (mount-once) DOM handlers.
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);
  const glossaryPreviewRef = useRef(glossaryPreview);
  useEffect(() => {
    glossaryPreviewRef.current = glossaryPreview;
  }, [glossaryPreview]);
  const readonlyRef = useRef(readonly);
  useEffect(() => {
    readonlyRef.current = readonly;
  }, [readonly]);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const onInsertMediaRef = useRef(onInsertMedia);
  useEffect(() => {
    onInsertMediaRef.current = onInsertMedia;
  }, [onInsertMedia]);
  const onEnhanceSelectionRef = useRef(onEnhanceSelection);
  useEffect(() => {
    onEnhanceSelectionRef.current = onEnhanceSelection;
  }, [onEnhanceSelection]);

  useEffect(() => {
    if (!hostRef.current) return;
    const crepe = new Crepe({
      root: hostRef.current,
      defaultValue: initialMarkdown,
      features: {
        [Crepe.Feature.TopBar]: showToolbar ?? !readonly,
      },
      featureConfigs: {
        [Crepe.Feature.CodeMirror]: {
          renderPreview: renderTomeCodePreview,
          previewLoading: "Rendering Mermaid diagram…",
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: async (file: File) => {
            try {
              return await imageFileToDataUrl(file);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "The image could not be embedded.";
              toast(message, "error");
              throw error;
            }
          },
        },
        [Crepe.Feature.TopBar]: {
          bulletListIcon: TOME_BULLET_LIST_ICON,
          buildTopBar: (builder) => {
            if (enableColumns) {
              builder.getGroup("insert").addItem("tome-columns", {
                icon: TOME_COLUMNS_ICON,
                active: () => false,
                onRun: () => setColumnsOpen(true),
              });
            }
            builder.getGroup("insert").addItem("tome-media", {
              icon: TOME_MEDIA_ICON,
              active: () => false,
              onRun: () => {
                if (onInsertMediaRef.current) onInsertMediaRef.current();
                else setMediaOpen(true);
              },
            });
            builder
              .addGroup("history", "History")
              .addItem("tome-undo", {
                icon: TOME_UNDO_ICON,
                active: () => false,
                onRun: (ctx) => {
                  const view = ctx.get(editorViewCtx);
                  if (undo(view.state, view.dispatch.bind(view))) view.focus();
                },
              })
              .addItem("tome-redo", {
                icon: TOME_REDO_ICON,
                active: () => false,
                onRun: (ctx) => {
                  const view = ctx.get(editorViewCtx);
                  if (redo(view.state, view.dispatch.bind(view))) view.focus();
                },
            });
          },
        },
        [Crepe.Feature.Toolbar]: {
          buildToolbar: (builder) => {
            if (!onEnhanceSelectionRef.current) return;
            builder.addGroup("tome-ai", "AI").addItem("tome-enhance-ai", {
              icon: TOME_AI_ICON,
              label: "Enhance with AI",
              active: () => false,
              onRun: (ctx) => {
                capturePendingAiSelection(ctx.get(editorViewCtx));
                onEnhanceSelectionRef.current?.();
              },
            });
          },
        },
      },
    });
    if (typeof crepe.on === "function") {
      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, nextMarkdown) => {
          onChangeRef.current?.(normalizeMarkdown(nextMarkdown));
        });
      });
    }
    crepeRef.current = crepe;
    readyRef.current = false;
    crepe.editor.use(pendingAiSelectionPlugin);
    if (enableColumns) crepe.editor.use(tomeColumnsPlugin);

    // Tag citation-shaped link hrefs with a chip class. This is the proper
    // Milkdown extension point — `linkAttr` is invoked when the link mark
    // renders to DOM, returning extra attributes for the <a>. Standard
    // markdown links stay portable; visual styling is in CSS.
    crepe.editor.config((ctx) => {
      // Crepe stores image width in the Markdown image's alt field. Extend
      // that portable metadata as `<ratio>|<alignment>` while continuing to
      // accept its existing numeric-only form as centered.
      const previousImageBlockSchema = ctx.get(imageBlockSchema.key);
      ctx.set(imageBlockSchema.key, (schemaCtx) => {
        const schema = previousImageBlockSchema(schemaCtx);
        return {
          ...schema,
          attrs: {
            ...schema.attrs,
            alignment: { default: "center", validate: "string" },
          },
          parseMarkdown: {
            match: ({ type }) => type === "image-block",
            runner: (state, node, type) => {
              const { ratio, alignment } = parseImageLayoutMetadata(
                String(node.alt || "1"),
              );
              state.addNode(type, {
                src: String(node.url || ""),
                caption: String(node.title || ""),
                ratio,
                alignment,
              });
            },
          },
          toMarkdown: {
            match: (node) => node.type.name === "image-block",
            runner: (state, node) => {
              const alignment =
                node.attrs.alignment === "left" || node.attrs.alignment === "right"
                  ? node.attrs.alignment
                  : "center";
              state.openNode("paragraph");
              state.addNode("image", undefined, undefined, {
                title: node.attrs.caption,
                url: node.attrs.src,
                alt: serializeImageLayoutMetadata(Number(node.attrs.ratio), alignment),
              });
              state.closeNode();
            },
          },
        };
      });

      // remark-gfm retains `<br>` in table cells as inline HTML, but Milkdown's
      // GFM table parser drops those nodes. Register this transformer during
      // configuration (before the parser is built) so Rich mode receives
      // native hardbreaks. The serializer below writes them back as `<br>`.
      ctx.set(remarkPluginsCtx, [
        ...ctx.get(remarkPluginsCtx),
        {
          plugin: () => (tree: MarkdownAstNode) => restoreTableCellBreaks(tree),
          options: {},
        },
      ]);
      const prev = ctx.get(linkAttr.key);
      ctx.set(linkAttr.key, (mark) => {
        const base = prev ? prev(mark) : {};
        const href = (mark.attrs?.href as string | undefined) || "";
        // Internal wiki link → tag for styling + click routing. Glossary term
        // links get a distinct class (dotted underline, hover definition).
        const internal = parseTomeHref(href);
        if (internal) {
          if (internal.glossaryTerm) {
            const cls = [base.class, "tome-glossary-link"].filter(Boolean).join(" ");
            return { ...base, class: cls, "data-glossary-term": internal.glossaryTerm };
          }
          const cls = [base.class, "tome-link"].filter(Boolean).join(" ");
          return { ...base, class: cls };
        }
        const cite = classifyCitationHref(href);
        if (!cite) return base;
        const cls = [base.class, "md-citation", `md-citation-${cite.kind}`]
          .filter(Boolean)
          .join(" ");
        return {
          ...base,
          class: cls,
          "data-citation-kind": cite.kind,
          "data-citation-label": cite.label,
        };
      });

      // Keep table-cell line breaks portable as literal <br> HTML nodes in
      // Markdown, but render them as native breaks in the rich editor. The
      // default commonmark HTML node renders its source inside a <span>,
      // which leaves Shift+Enter looking like a no-op in a table cell.
      const previousHtmlSchema = ctx.get(htmlSchema.key);
      ctx.set(htmlSchema.key, (schemaCtx) => {
        const schema = previousHtmlSchema(schemaCtx);
        const previousToDOM = schema.toDOM;
        return {
          ...schema,
          parseDOM: [
            {
              tag: 'br[data-type="html"]',
              getAttrs: (dom) => ({ value: dom.dataset.value ?? "<br>" }),
            },
            ...(schema.parseDOM ?? []),
          ],
          toDOM: (node) => {
            const value = typeof node.attrs.value === "string" ? node.attrs.value : "";
            if (/^<br\s*\/?\s*>$/i.test(value.trim())) {
              return [
                "br",
                {
                  ...schemaCtx.get(htmlAttr.key)(node),
                  "data-type": "html",
                  "data-value": value,
                },
              ];
            }
            return previousToDOM?.(node) ?? ["span", { "data-type": "html" }, value];
          },
        };
      });

      // Use ProseMirror's native hardbreak node while editing so caret and
      // keyboard behavior stay correct. GFM tables flatten mdast `break`
      // nodes, so serialize hardbreaks as portable inline HTML instead.
      const previousHardbreakSchema = ctx.get(hardbreakSchema.key);
      ctx.set(hardbreakSchema.key, (schemaCtx) => {
        const schema = previousHardbreakSchema(schemaCtx);
        return {
          ...schema,
          toMarkdown: {
            match: (node) => node.type.name === "hardbreak",
            runner: (state) => state.addNode("html", undefined, "<br>"),
          },
        };
      });
    });

    let cancelled = false;
    crepe.create().then(() => {
      if (cancelled) return;
      crepe.setReadonly(readonly);
      readyRef.current = true;
    });
    return () => {
      cancelled = true;
      readyRef.current = false;
      crepe.destroy();
      crepeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    crepeRef.current?.setReadonly(readonly);
  }, [readonly]);

  // Code-block previews are sanitized by Crepe, which intentionally strips
  // iframes. Hydrate only the inert provider placeholders produced by our
  // allowlisted preview renderer, and re-validate before setting iframe.src.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const hydrate = () => hydrateEmbedPreviews(host);
    hydrate();
    const observer = new MutationObserver(hydrate);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Give image blocks explicit remove and proportional resize affordances.
  // Crepe's native handle changes height only; using its persisted `ratio`
  // attribute as scale keeps width and height together across editor modes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const decorate = () => {
      if (readonlyRef.current) return;
      host
        .querySelectorAll<HTMLElement>(".milkdown-image-block")
        .forEach((block) => {
          const crepe = crepeRef.current;

          if (!block.dataset.removeDecorated) {
            const alignment = crepe ? readImageAlignmentAtDom(crepe, block) : "center";
            block.dataset.removeDecorated = "true";
            if (crepe) applyMediaWidth(block, readImageWidthAtDom(crepe, block));
            applyMediaAlignment(block, alignment);
            const toolbar = document.createElement("div");
            toolbar.className = "tome-embed-toolbar";
            toolbar.insertAdjacentHTML(
              "beforeend",
              mediaAlignmentControlsMarkup(alignment),
            );
            const button = document.createElement("button");
            button.type = "button";
            button.className = "tome-image-remove";
            button.setAttribute("aria-label", "Remove image");
            button.innerHTML = '<span aria-hidden="true">✕</span><span>Remove image</span>';
            toolbar.appendChild(button);
            block.prepend(toolbar);
          }

          const imageWrapper = block.querySelector<HTMLElement>(".image-wrapper");
          if (imageWrapper && !imageWrapper.querySelector(".tome-image-resize")) {
            const resize = document.createElement("button");
            const width = crepe ? readImageWidthAtDom(crepe, block) : 100;
            applyMediaWidth(block, width);
            resize.type = "button";
            resize.className = "tome-media-resize tome-image-resize";
            resize.setAttribute("role", "slider");
            resize.setAttribute("aria-label", "Resize image");
            resize.setAttribute("aria-valuemin", "25");
            resize.setAttribute("aria-valuemax", "100");
            resize.setAttribute("aria-valuenow", String(width));
            resize.title = "Drag to resize image; use arrow keys for precise sizing";
            resize.innerHTML = [
              `<span class="tome-media-size-label" aria-hidden="true">${width}%</span>`,
              '<span class="tome-media-resize-icon" aria-hidden="true">↘</span>',
            ].join("");
            imageWrapper.append(resize);
          }
        });
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Dragging resizes against the available block width. Persist only at the
  // end of a gesture so pointer movement stays smooth and creates one undo
  // step. Arrow/Home/End keys provide the same operation without a pointer.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let removeDragListeners: (() => void) | null = null;

    const findMedia = (handle: Element) =>
      handle.closest<HTMLElement>(".tome-embed-preview, .milkdown-image-block");

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const handle = target?.closest?.(".tome-media-resize") as HTMLElement | null;
      if (!handle || readonlyRef.current || event.button !== 0) return;
      const media = findMedia(handle);
      const crepe = crepeRef.current;
      if (!media || !crepe) return;

      event.preventDefault();
      event.stopPropagation();
      const availableWidth = Math.max(
        media.parentElement?.getBoundingClientRect().width ?? 0,
        media.getBoundingClientRect().width,
        1,
      );
      const startWidth = Number(handle.getAttribute("aria-valuenow")) || 100;
      const startX = event.clientX;
      let nextWidth = startWidth;
      media.classList.add("tome-media-resizing");
      handle.setPointerCapture?.(event.pointerId);

      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        nextWidth = clampMediaWidth(
          startWidth + ((moveEvent.clientX - startX) / availableWidth) * 200,
        );
        applyMediaWidth(media, nextWidth);
      };
      const onPointerUp = (upEvent: PointerEvent) => {
        upEvent.preventDefault();
        media.classList.remove("tome-media-resizing");
        handle.releasePointerCapture?.(event.pointerId);
        removeDragListeners?.();
        removeDragListeners = null;
        persistMediaWidthAtDom(crepe, media, nextWidth);
      };
      removeDragListeners = () => {
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPointerUp, true);
        window.removeEventListener("pointercancel", onPointerUp, true);
      };
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerUp, true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      const handle = target?.closest?.(".tome-media-resize") as HTMLElement | null;
      if (!handle || readonlyRef.current) return;
      const media = findMedia(handle);
      const crepe = crepeRef.current;
      if (!media || !crepe) return;
      const current = Number(handle.getAttribute("aria-valuenow")) || 100;
      const step = event.shiftKey ? 10 : 5;
      let next: number | null = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = current - step;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") next = current + step;
      if (event.key === "Home") next = MIN_EMBED_WIDTH_PERCENT;
      if (event.key === "End") next = MAX_EMBED_WIDTH_PERCENT;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      const width = clampMediaWidth(next);
      applyMediaWidth(media, width);
      persistMediaWidthAtDom(crepe, media, width);
    };

    host.addEventListener("pointerdown", onPointerDown, true);
    host.addEventListener("keydown", onKeyDown, true);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown, true);
      host.removeEventListener("keydown", onKeyDown, true);
      removeDragListeners?.();
    };
  }, []);

  // Milkdown's image node view stops editor events for its hidden file input,
  // but not for the visible upload label. ProseMirror can therefore select and
  // re-render the node between pointerdown and the label's native click, making
  // the first click appear to do nothing. Open the picker during the original
  // user gesture and keep the label operable from the keyboard.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const findUploadControl = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const uploader = target.closest<HTMLLabelElement>(
        ".milkdown-image-block label.uploader",
      );
      if (!uploader) return null;
      const placeholder = uploader.closest(".placeholder");
      const input = placeholder?.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input || input.disabled) return null;
      return { input, uploader };
    };

    const decorate = () => {
      host
        .querySelectorAll<HTMLLabelElement>(
          ".milkdown-image-block label.uploader:not([data-tome-image-upload])",
        )
        .forEach((uploader) => {
          uploader.dataset.tomeImageUpload = "true";
          uploader.tabIndex = 0;
          uploader.setAttribute("role", "button");
          uploader.setAttribute("aria-label", "Upload image file");
        });
    };

    const openPicker = (event: Event, input: HTMLInputElement) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      input.click();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (readonlyRef.current || event.button > 0) return;
      const control = findUploadControl(event.target);
      if (!control) return;
      openPicker(event, control.input);
    };

    const onClick = (event: MouseEvent) => {
      if (readonlyRef.current) return;
      const control = findUploadControl(event.target);
      if (!control) return;
      // A pointer-generated click follows the pointerdown handled above. Block
      // the label's native second activation; detail=0 preserves assistive and
      // programmatic click activation.
      if (event.detail > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      openPicker(event, control.input);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (readonlyRef.current || (event.key !== "Enter" && event.key !== " ")) return;
      const control = findUploadControl(event.target);
      if (!control) return;
      openPicker(event, control.input);
    };

    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(host, { childList: true, subtree: true });
    host.addEventListener("pointerdown", onPointerDown, true);
    host.addEventListener("click", onClick, true);
    host.addEventListener("keydown", onKeyDown, true);
    return () => {
      observer.disconnect();
      host.removeEventListener("pointerdown", onPointerDown, true);
      host.removeEventListener("click", onClick, true);
      host.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // Stream new content into the live editor when liveUpdate is on. We
  // dedupe against the editor's current markdown to avoid no-op replaceAll
  // calls during user-typed edits.
  useEffect(() => {
    if (!liveUpdate) return;
    const crepe = crepeRef.current;
    if (!crepe || !readyRef.current) return;
    const current = crepe.getMarkdown();
    if (current === initialMarkdown) return;
    crepe.editor.action(replaceAll(initialMarkdown));
  }, [initialMarkdown, liveUpdate]);

  // Force all rendered links to open in a new tab. Crepe's default behavior
  // hijacks anchor clicks (link preview popup in editable; same-tab navigate
  // in readonly). We catch on the capture phase so we win before Crepe.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const alignmentButton = target?.closest?.("button.tome-media-align") as HTMLElement | null;
      if (alignmentButton) {
        e.preventDefault();
        e.stopPropagation();
        if (readonlyRef.current) return;
        const alignment = alignmentButton.dataset.align;
        if (alignment !== "left" && alignment !== "center" && alignment !== "right") return;
        const crepe = crepeRef.current;
        const block = alignmentButton.closest<HTMLElement>(
          ".tome-embed-preview, .milkdown-image-block",
        );
        if (!crepe || !block) return;
        applyMediaAlignment(block, alignment);
        persistMediaAlignmentAtDom(crepe, block, alignment);
        return;
      }
      const playlistToggle = target?.closest?.("button.tome-vidcast-playlist-toggle");
      if (playlistToggle) {
        e.preventDefault();
        e.stopPropagation();
        if (readonlyRef.current) return;
        const crepe = crepeRef.current;
        const block = playlistToggle.closest<HTMLElement>(".tome-embed-preview");
        if (!crepe || !block) return;
        const expanded = playlistToggle.getAttribute("aria-checked") !== "true";
        playlistToggle.setAttribute("aria-checked", String(expanded));
        persistVidcastPlaylistExpandedAtDom(crepe, block, expanded);
        return;
      }
      const removeButton = target?.closest?.("button.tome-embed-remove, button.tome-image-remove");
      if (removeButton) {
        e.preventDefault();
        e.stopPropagation();
        if (readonlyRef.current) return;
        const crepe = crepeRef.current;
        const block = removeButton.closest<HTMLElement>(
          ".tome-embed-preview, .tome-embed-error, .milkdown-image-block",
        );
        if (!crepe || !block) return;
        deleteTopLevelBlockAtDom(crepe, block);
        return;
      }
      const expandButton = target?.closest?.("button.tome-mermaid-expand");
      if (expandButton) {
        const svg = expandButton
          .closest(".tome-mermaid-preview")
          ?.querySelector<SVGSVGElement>(".tome-mermaid-canvas svg");
        if (!svg) return;
        e.preventDefault();
        e.stopPropagation();
        const viewBoxWidth = Number(svg.getAttribute("viewBox")?.split(/\s+/)[2]);
        const renderedWidth = svg.getBoundingClientRect().width;
        const width = Math.max(
          Number.isFinite(viewBoxWidth) ? viewBoxWidth : 0,
          renderedWidth,
          1200,
        );
        // The SVG has already passed through Crepe's DOMPurify sanitizer.
        setMermaidZoom(100);
        setExpandedMermaid({ svg: svg.outerHTML, width });
        return;
      }
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      // Internal wiki link → SPA navigation in the host, not a new tab.
      // A cross-project (@project) ref navigates to that project's wiki route.
      const internal = parseTomeHref(href);
      if (internal?.project) {
        e.preventDefault();
        e.stopPropagation();
        window.location.assign(wikiRoute(internal.project, internal.path));
        return;
      }
      if (internal && onNavigateRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onNavigateRef.current(internal.path);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      window.open(href, "_blank", "noopener,noreferrer");
    };
    host.addEventListener("click", onClick, true);
    return () => host.removeEventListener("click", onClick, true);
  }, []);

  // Glossary hover card. On hovering a glossary term link, look up its
  // definition (synchronous, from already-loaded pages) and float a card below
  // the link. Pure DOM — the link lives inside Milkdown's contenteditable.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let card: HTMLDivElement | null = null;
    // Per-mount cache so re-hovering a term doesn't re-resolve.
    const cache = new Map<string, GlossaryPreview | null>();

    const hide = () => {
      card?.remove();
      card = null;
    };
    const floatCard = (anchor: HTMLAnchorElement, build: (c: HTMLDivElement) => void) => {
      hide();
      card = document.createElement("div");
      card.className = "tome-glossary-card";
      build(card);
      document.body.appendChild(card);
      const r = anchor.getBoundingClientRect();
      const w = card.offsetWidth;
      card.style.top = `${r.bottom + 6}px`;
      card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    };
    const show = (anchor: HTMLAnchorElement, p: GlossaryPreview) =>
      floatCard(anchor, (c) => {
        const head = document.createElement("div");
        head.className = "tome-glossary-card-term";
        head.textContent = p.expansion ? `${p.term}: ${p.expansion}` : p.term;
        const def = document.createElement("div");
        def.className = "tome-glossary-card-def";
        if (p.definition) def.innerHTML = renderInlineMarkdown(p.definition);
        else def.textContent = "No definition yet.";
        c.append(head, def);
      });
    const showUnresolved = (anchor: HTMLAnchorElement) =>
      floatCard(anchor, (c) => {
        c.classList.add("tome-glossary-card-unresolved");
        const head = document.createElement("div");
        head.className = "tome-glossary-card-term";
        head.textContent = "Unresolved reference";
        const def = document.createElement("div");
        def.className = "tome-glossary-card-def";
        def.textContent = "This term doesn't resolve here. The link may point at the wrong project or a term that no longer exists.";
        c.append(head, def);
      });
    // Mark every link sharing this href as dangling (broken ref).
    const markDangling = (href: string) => {
      host.querySelectorAll<HTMLAnchorElement>("a.tome-glossary-link").forEach((a) => {
        if (a.getAttribute("href") === href) a.classList.add("tome-glossary-dangling");
      });
    };
    // Resolve a link's ref (cached). null = definitively unresolved → dangling;
    // a thrown error is transient and leaves the link unmarked.
    const resolve = (href: string): Promise<GlossaryPreview | null> => {
      const fn = glossaryPreviewRef.current;
      if (cache.has(href)) return Promise.resolve(cache.get(href) ?? null);
      if (!fn) return Promise.resolve(null);
      return Promise.resolve(fn(href)).then((p) => {
        cache.set(href, p ?? null);
        if (p === null) markDangling(href);
        return p ?? null;
      });
    };
    const onOver = (e: Event) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (!parseTomeHref(href)?.glossaryTerm) return;
      resolve(href)
        .then((p) => {
          if (!anchor.matches(":hover")) return;
          if (p) show(anchor, p);
          else showUnresolved(anchor);
        })
        .catch(() => {});
    };
    const onOut = (e: Event) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
      if (anchor) hide();
    };

    // Eager pass: resolve every glossary link so dangling ones are flagged
    // without needing a hover. Re-runs (debounced) as the rendered doc changes.
    let passTimer: ReturnType<typeof setTimeout> | null = null;
    const markPass = () => {
      host.querySelectorAll<HTMLAnchorElement>("a.tome-glossary-link").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!parseTomeHref(href)?.glossaryTerm) return;
        resolve(href)
          .then((p) => {
            if (p === null) a.classList.add("tome-glossary-dangling");
          })
          .catch(() => {});
      });
    };
    const schedulePass = () => {
      if (passTimer) clearTimeout(passTimer);
      passTimer = setTimeout(markPass, 250);
    };
    const observer = new MutationObserver(schedulePass);
    observer.observe(host, { childList: true, subtree: true });
    schedulePass();

    host.addEventListener("mouseover", onOver);
    host.addEventListener("mouseout", onOut);
    return () => {
      observer.disconnect();
      if (passTimer) clearTimeout(passTimer);
      host.removeEventListener("mouseover", onOver);
      host.removeEventListener("mouseout", onOut);
      hide();
    };
  }, []);

  // Anchor links on headings (GitHub/Docusaurus-style): a hover-only link icon
  // that copies the page URL with `#slug` and updates the URL bar, so a
  // heading can be deep-linked directly. Only wired in readonly mode — while
  // editing, heading text (and therefore its slug) is still in flux.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !readonly) return;

    const usedSlugs = new Set<string>();
    const decorate = () => {
      usedSlugs.clear();
      const headings = host.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6");
      headings.forEach((heading) => {
        const slug = uniqueHeadingSlug(heading.textContent || "", usedSlugs);
        if (!slug) return;
        heading.id = slug;
        heading.classList.add("tome-heading-anchor");
        if (heading.querySelector(".tome-heading-anchor-link")) return;
        const link = document.createElement("a");
        link.href = `#${slug}`;
        link.className = "tome-heading-anchor-link";
        link.setAttribute("aria-label", "Copy link to this heading");
        link.textContent = "#";
        heading.prepend(link);
      });
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const link = target.closest(".tome-heading-anchor-link");
      if (!(link instanceof HTMLAnchorElement)) return;
      e.preventDefault();
      const slug = link.getAttribute("href")?.slice(1);
      if (!slug) return;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${slug}`);
      void copyTextToClipboard(`${window.location.origin}${window.location.pathname}${window.location.search}#${slug}`).then(
        (ok) => toast(ok ? "Link copied" : "Could not copy link", ok ? "success" : "error"),
      );
    };

    decorate();
    // Headings render asynchronously (Crepe/Milkdown mounts after `create()`
    // resolves) and can change as content streams in — re-decorate on any
    // subtree mutation rather than once at mount.
    const observer = new MutationObserver(decorate);
    observer.observe(host, { childList: true, subtree: true });
    host.addEventListener("click", onClick);
    return () => {
      observer.disconnect();
      host.removeEventListener("click", onClick);
    };
  }, [readonly, toast]);

  // Give Tome's top-bar controls stable accessible names and native hover
  // hints. Crepe currently renders icon-only buttons without item labels.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const decorate = () => {
      const mediaIcon = host.querySelector("[data-tome-media-icon]");
      const mediaButton = mediaIcon?.closest("button");
      if (mediaButton) {
        mediaButton.setAttribute("aria-label", "Insert media");
        mediaButton.setAttribute("title", "Insert media (video, paper, or PDF)");
        mediaButton.setAttribute("data-tome-media-button", "true");
      }
      const columnsButton = host.querySelector("[data-tome-columns-icon]")?.closest("button");
      if (columnsButton) {
        columnsButton.setAttribute("aria-label", "Add columns");
        columnsButton.setAttribute("title", "Add a two- or three-column section");
      }
      const bulletIcon = host.querySelector("[data-tome-bullet-list-icon]");
      const bulletButton = bulletIcon?.closest("button");
      if (bulletButton) {
        bulletButton.setAttribute("aria-label", "Bulleted list");
        bulletButton.setAttribute(
          "title",
          "Bulleted list (inside a table, inserts a portable cell bullet)",
        );
        bulletButton.setAttribute("data-tome-bullet-list-button", "true");
      }
      const undoButton = host.querySelector("[data-tome-undo-icon]")?.closest("button");
      if (undoButton) {
        undoButton.setAttribute("aria-label", "Undo");
        undoButton.setAttribute("title", "Undo (Ctrl/⌘+Z)");
      }
      const redoButton = host.querySelector("[data-tome-redo-icon]")?.closest("button");
      if (redoButton) {
        redoButton.setAttribute("aria-label", "Redo");
        redoButton.setAttribute("title", "Redo (Ctrl/⌘+Shift+Z or Ctrl+Y)");
      }
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // GFM table cells cannot contain block-level lists or paragraphs. Preserve
  // rich cell formatting portably as inline bullets plus native hardbreaks.
  // Their custom serializer writes literal <br> so GFM does not flatten them.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onPointerDown = (event: PointerEvent) => {
      if (readonlyRef.current || !readyRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("[data-tome-bullet-list-button]")) return;
      const crepe = crepeRef.current;
      if (!crepe || !insertTableCellBullet(crepe)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (readonlyRef.current || !readyRef.current || event.key !== "Enter" || !event.shiftKey) {
        return;
      }
      const crepe = crepeRef.current;
      if (!crepe || !insertTableCellLineBreak(crepe)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    host.addEventListener("pointerdown", onPointerDown, true);
    host.addEventListener("keydown", onKeyDown, true);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown, true);
      host.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // Treat a supported URL pasted by itself as an embed. Mixed prose and
  // ordinary links deliberately keep Crepe's normal paste behavior.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onPaste = (event: ClipboardEvent) => {
      if (readonlyRef.current || !readyRef.current || event.clipboardData?.files.length) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".ProseMirror")) return;
      const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
      const match = matchTomeEmbedUrl(clipboardText);
      const crepe = crepeRef.current;
      if (!crepe) return;
      if (match) {
        event.preventDefault();
        event.stopPropagation();
        crepe.editor.action(insert(match.markdown));
        const label =
          match.provider === "youtube"
            ? "YouTube"
            : match.provider === "vidcast"
              ? "Vidcast"
              : match.provider === "arxiv"
                ? "arXiv"
                : "PDF";
        toast(`${label} link converted to an embed`, "success");
        return;
      }

      // Keep a multiline plain-text paste inside one cell. Tabs and HTML
      // tables remain delegated to Crepe's native multi-cell paste handling.
      const targetCell = target.closest(".ProseMirror td, .ProseMirror th");
      const clipboardHtml = event.clipboardData?.getData("text/html") ?? "";
      if (
        !targetCell ||
        !/\r?\n/.test(clipboardText) ||
        clipboardText.includes("\t") ||
        /<table\b/i.test(clipboardHtml)
      ) {
        return;
      }
      if (!insertTableCellLines(crepe, clipboardText.replace(/\r\n?/g, "\n").split("\n"))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    host.addEventListener("paste", onPaste, true);
    return () => host.removeEventListener("paste", onPaste, true);
  }, [toast]);

  // Deep-linking: scroll to the heading named by the URL hash once it exists.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !readonly) return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    let cancelled = false;
    const tryScroll = () => {
      if (cancelled) return;
      const el = host.querySelector(`#${CSS.escape(hash)}`);
      if (el) {
        el.scrollIntoView({ block: "start" });
        return true;
      }
      return false;
    };
    if (tryScroll()) return;
    const observer = new MutationObserver(() => {
      if (tryScroll()) observer.disconnect();
    });
    observer.observe(host, { childList: true, subtree: true });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [readonly]);

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () =>
        normalizeMarkdown(crepeRef.current?.getMarkdown() ?? initialMarkdown),
      setMarkdown: (md: string) => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current) return;
        crepe.editor.action(replaceAll(md));
      },
      insertMarkdown: (md: string) => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current) return;
        crepe.editor.action(insert(md));
      },
      getSelectedText: () => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current) return "";
        let selected = "";
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = getPendingAiSelection(view) ?? view.state.selection;
          selected = view.state.doc.textBetween(from, to, "\n");
        });
        return selected;
      },
      captureSelection: () => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current) return;
        crepe.editor.action((ctx) => {
          capturePendingAiSelection(ctx.get(editorViewCtx));
        });
      },
      restoreSelection: () => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current) return;
        crepe.editor.action((ctx) => {
          restorePendingAiSelection(ctx.get(editorViewCtx));
        });
      },
      replaceSelection: (md: string) => {
        const crepe = crepeRef.current;
        if (!crepe || !readyRef.current) return;
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = getPendingAiSelection(view) ?? view.state.selection;
          const slice = markdownToSlice(md)(ctx);
          const transaction = view.state.tr.replace(from, to, slice);
          const cursorPosition = Math.min(
            transaction.mapping.map(to),
            transaction.doc.content.size,
          );
          view.dispatch(
            transaction
              .setSelection(
                TextSelection.near(transaction.doc.resolve(cursorPosition), -1),
              )
              .setMeta(pendingAiSelectionKey, null)
              .scrollIntoView(),
          );
          view.focus();
        });
      },
    }),
    [initialMarkdown],
  );

  return (
    <>
      <div
        ref={hostRef}
        className={hideHtmlComments ? "milkdown-host milkdown-hide-comments" : "milkdown-host"}
      />
      <TomeMediaInsertDialog
        open={mediaOpen}
        onOpenChange={setMediaOpen}
        onInsert={(markdown) => {
          const crepe = crepeRef.current;
          if (!crepe || !readyRef.current) return;
          crepe.editor.action(insert(markdown));
        }}
      />
      <Dialog open={columnsOpen} onOpenChange={setColumnsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add columns</DialogTitle>
            <DialogDescription>
              Choose a page layout. Columns stack vertically on narrow screens.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {[2, 3].map((count) => (
              <Button
                key={count}
                type="button"
                variant="outline"
                className="h-auto flex-col gap-3 py-4"
                onClick={() => {
                  const crepe = crepeRef.current;
                  if (!crepe || !readyRef.current) return;
                  crepe.editor.action(insert(serializeTomeColumns(count)));
                  setColumnsOpen(false);
                }}
              >
                <span className="flex w-full gap-1" aria-hidden="true">
                  {Array.from({ length: count }, (_, index) => (
                    <span key={index} className="h-10 flex-1 rounded border bg-muted/50" />
                  ))}
                </span>
                {count} columns
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={expandedMermaid !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExpandedMermaid(null);
            setMermaidZoom(100);
          }
        }}
      >
        <DialogContent className="tome-mermaid-lightbox">
          <div className="tome-mermaid-lightbox-header">
            <DialogHeader>
              <DialogTitle>Mermaid diagram</DialogTitle>
              <DialogDescription>
                Zoom the diagram, then scroll to inspect it.
              </DialogDescription>
            </DialogHeader>
            <div
              className="tome-mermaid-zoom-controls"
              role="group"
              aria-label="Mermaid diagram zoom controls"
            >
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Zoom out Mermaid diagram"
                title="Zoom out"
                disabled={mermaidZoom === MERMAID_ZOOM_MIN}
                onClick={() =>
                  setMermaidZoom((zoom) => Math.max(MERMAID_ZOOM_MIN, zoom - MERMAID_ZOOM_STEP))
                }
              >
                <Minus aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="tome-mermaid-zoom-value"
                aria-label="Reset Mermaid zoom"
                title="Reset zoom"
                onClick={() => setMermaidZoom(100)}
              >
                {mermaidZoom}%
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Zoom in Mermaid diagram"
                title="Zoom in"
                disabled={mermaidZoom === MERMAID_ZOOM_MAX}
                onClick={() =>
                  setMermaidZoom((zoom) => Math.min(MERMAID_ZOOM_MAX, zoom + MERMAID_ZOOM_STEP))
                }
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div
            className="tome-mermaid-lightbox-canvas"
            style={
              {
                "--tome-mermaid-expanded-width": `${
                  ((expandedMermaid?.width ?? 1200) * mermaidZoom) / 100
                }px`,
              } as CSSProperties
            }
            dangerouslySetInnerHTML={{ __html: expandedMermaid?.svg ?? "" }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
});

/**
 * GitHub-style heading slug: lowercase, strip punctuation, spaces → hyphens.
 * `usedSlugs` disambiguates repeats within one render pass (`foo`, `foo-1`,
 * `foo-2`, ...) — mutated in place, same as GitHub/Docusaurus/remark-slug.
 */
function uniqueHeadingSlug(text: string, usedSlugs: Set<string>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
  if (!base) return "";
  let slug = base;
  let n = 1;
  while (usedSlugs.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  usedSlugs.add(slug);
  return slug;
}

/**
 * Undo two over-eager round-trip artifacts from Milkdown's remark serializer:
 *
 *  1. **Setext → ATX heading conversion.** `## Heading` round-trips to
 *     `Heading\n--------`. We walk back to the previous blank line so
 *     multi-line setext headings split into ATX heading + paragraph body
 *     (ATX can't span lines).
 *  2. **Bracket escaping.** `[#213]` and `[commit abc]` round-trip to
 *     `\[#213]` and `\[commit abc\]` because remark sees `[…]` as
 *     potentially-link syntax. Our citations always use literal brackets,
 *     so unescape them.
 */
function normalizeMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    const isSetextH1 = /^={3,}\s*$/.test(next);
    const isSetextH2 = /^-{3,}\s*$/.test(next);

    if ((isSetextH1 || isSetextH2) && line.trim()) {
      // Multi-line setext: pull all preceding non-blank lines off `out` to
      // assemble the full heading body, then split into ATX heading + paragraph.
      const headingLines: string[] = [line];
      while (out.length > 0 && out[out.length - 1].trim() !== "") {
        headingLines.unshift(out.pop() as string);
      }
      const prefix = isSetextH1 ? "# " : "## ";
      const headText = headingLines[0].replace(/\\$/, "").trim();
      out.push(prefix + headText);
      if (headingLines.length > 1) {
        out.push("");
        for (const l of headingLines.slice(1)) {
          out.push(l.replace(/\\$/, ""));
        }
      }
      i += 2;
      continue;
    }
    out.push(line);
    i += 1;
  }

  let result = out.join("\n");
  result = result.replace(/\\([[\]])/g, "$1");
  return normalizeMarkdownCodeFences(result);
}
