"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { AlertTriangle, ArrowLeftRight, ChevronDown, ImagePlus, Loader2, X } from "lucide-react";

import {
  MARKDOWN_DOCUMENT_EDITOR_MODES,
  MarkdownEditorModeToggle,
  type MarkdownDocumentEditorMode,
} from "@/components/shared/MarkdownEditorModeToggle";
import { MarkdownRenderer } from "@/components/shared/timeline/MarkdownRenderer";
import { AiAssistButton } from "@/components/ai-assist";
import {
  RichCodeEditor,
  type ReactCodeMirrorRef,
} from "@/components/skills/workspace/RichCodeEditor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CrepeEditor, type CrepeEditorHandle } from "@/components/tome/CrepeEditor";
import { TomeMediaInsertDialog } from "@/components/tome/TomeMediaInsertDialog";
import type { GlossaryResolver } from "@/lib/tome/tome-links";
import { GlossaryFields } from "@/components/tome/GlossaryFields";
import { EdgeFields } from "@/components/tome/EdgeFields";
import { TrackedEntityFields } from "@/components/tome/TrackedEntityFields";
import { KindBadge } from "@/components/tome/KindBadge";
import { ViewOnlyTooltip } from "@/components/tome/ViewOnlyTooltip";
import { WikiExportMenu } from "@/components/tome/WikiExportMenu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
  FM_RELATION,
  FM_SOURCE,
  FM_SOURCE_PATH,
  FM_SOURCE_REPO,
  FM_TARGET,
  FM_TEMPLATE_PATH,
  FM_TEMPLATE_SCOPE,
  FM_TEMPLATE_VERSION,
  FM_TERM,
  FM_TITLE,
  isEdge,
  isGlossaryTerm,
  isMirrorPage,
  isTrackedEntity,
  parseFrontmatter,
  serializeFrontmatter,
  SPEC_BY_PATH,
  type FrontmatterValue,
} from "@/lib/tome/schema";
import { cn } from "@/lib/utils";
import { diagnoseTomeMarkdown } from "@/lib/tome/markdown-diagnostics";
import { matchTomeEmbedUrl } from "@/lib/tome/embeds";
import type { PageKind } from "@/types/tome";

/** User-flippable kinds (report is system-managed via path). */
const FLIPPABLE_KINDS: { key: PageKind; label: string }[] = [
  { key: "stable", label: "Stable" },
  { key: "dynamic", label: "Dynamic" },
  { key: "hidden", label: "Hidden" },
];

interface Props {
  slug: string;
  path: string;
  /** Current page markdown (frontmatter + body). */
  markdown: string;
  onWrite: (
    path: string,
    markdown: string,
    message: string,
    options?: { baseRevisionId?: string | null; force?: boolean },
  ) => Promise<void>;
  onReload: () => void | Promise<void>;
  /** When provided, renders a close (×) button — used by the artifact pane. */
  onClose?: () => void;
  /** When provided, renders a History button opening the revision diff view. */
  onOpenHistory?: () => void;
  /** When true, an ingest is rewriting the wiki — render read-only. */
  locked?: boolean;
  /** When true, `locked` is because a draft is awaiting review (not an active
   * ingest) — same read-only effect, different banner copy. */
  awaitingReview?: boolean;
  /** Navigate to another wiki page (internal `tome://` link click). */
  onNavigate?: (path: string) => void;
  /** Resolve a glossary term slug to its definition for the hover card. */
  glossaryPreview?: GlossaryResolver;
  /** Rename this page to a new path. When provided, the header path is editable. */
  onRename?: (oldPath: string, newPath: string) => Promise<void>;
  /** OpenFGA steward/admin decision for all write affordances. */
  canEdit?: boolean;
  /** Current project paths used to flag broken wiki links in source mode. */
  knownPaths?: ReadonlySet<string>;
  /** Open a just-created page directly in editing mode. */
  autoStartEditing?: boolean;
  onAutoStartEditing?: () => void;
}

/**
 * A single wiki page: header (title + kind badge + kind toggle + edit/save) and
 * the Milkdown editor. Read-only until Edit. Used both as the main wiki view
 * and as the chat artifact pane.
 *
 * When `markdown` changes from the outside (e.g. the agent edits the page) and
 * the user isn't mid-edit, the editor remounts so the change is visible live.
 */
export function WikiPageView({
  slug,
  path,
  markdown,
  onWrite,
  onReload,
  onClose,
  onOpenHistory,
  locked = false,
  awaitingReview = false,
  onNavigate,
  glossaryPreview,
  onRename,
  canEdit = true,
  knownPaths,
  autoStartEditing = false,
  onAutoStartEditing,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editorMode, setEditorMode] = useState<MarkdownDocumentEditorMode>("rich");
  const [wideReading, setWideReading] = useState(false);
  const [rawDraft, setRawDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  // The markdown body fed into CrepeEditor on mount; updated when switching
  // back from raw mode so unsaved raw edits survive the remount.
  const [richInitialBody, setRichInitialBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [inlineAiOpen, setInlineAiOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    currentRevisionId: string | null;
    currentMarkdown: string;
    currentAuthor: string | null;
    currentCreatedAt: string | null;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const editorRef = useRef<CrepeEditorHandle>(null);
  const sourceEditorRef = useRef<ReactCodeMirrorRef | null>(null);
  const sourceAiSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const previewMode = editorMode === "preview";

  // Last revision — fetched once per page, used for the "Updated X ago by Y" line.
  const [lastRevision, setLastRevision] = useState<{
    id: string;
    author: string;
    created_at: string;
  } | null>(null);
  useEffect(() => {
    setLastRevision(null);
    let cancelled = false;
    fetch(`/api/tome/projects/${slug}/history/${path}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setLastRevision(j?.data?.revisions?.[0] ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [slug, path]);

  const { frontmatter, body, kind, title } = useMemo(() => {
    const [fm, b] = parseFrontmatter(markdown);
    const f = fm as Record<string, FrontmatterValue>;
    const k = (typeof f.kind === "string"
      ? f.kind
      : (SPEC_BY_PATH.get(path)?.kind ?? "stable")) as PageKind;
    const t =
      typeof f.title === "string"
        ? f.title
        : (SPEC_BY_PATH.get(path)?.title ?? path);
    return { frontmatter: f, body: b, kind: k, title: t };
  }, [markdown, path]);
  const [draftFrontmatter, draftBody] = useMemo(() => {
    const [fm, draftBodyValue] = parseFrontmatter(rawDraft);
    return [fm as Record<string, FrontmatterValue>, draftBodyValue] as const;
  }, [rawDraft]);

  const isGlossary = useMemo(() => isGlossaryTerm(frontmatter), [frontmatter]);
  const isEdgeEntry = useMemo(() => isEdge(frontmatter), [frontmatter]);
  const isTrackedEntry = useMemo(() => isTrackedEntity(frontmatter), [frontmatter]);
  const isMirror = useMemo(() => isMirrorPage(frontmatter), [frontmatter]);
  const filename = useMemo(() => path.split("/").pop() || path, [path]);

  // Template binding (#488/#508): passive, zero-extra-fetch badge read
  // straight off this page's own frontmatter (code-stamped by the ingest
  // persist hook, never agent-authored). Only says whether/at-what-version
  // this page is bound to a template; whether that version is stale and
  // whether its content has drifted is the "Check for template drift"
  // report (Templates tab), not repeated on every page load.
  const templateBinding = useMemo(() => {
    const scope = frontmatter[FM_TEMPLATE_SCOPE];
    if (!scope || scope === "null") return null;
    const templatePath = frontmatter[FM_TEMPLATE_PATH];
    const version = frontmatter[FM_TEMPLATE_VERSION];
    return {
      scope: String(scope),
      templatePath: templatePath ? String(templatePath) : null,
      version: typeof version === "number" ? version : null,
    };
  }, [frontmatter]);

  // Editable copy of the frontmatter for structured (glossary/edge) entries.
  // Kept in sync with the page's frontmatter whenever we're not mid-edit (page
  // switch / external agent edit); the Edit→Save flow mutates this draft.
  const [fmDraft, setFmDraft] = useState<Record<string, FrontmatterValue>>(frontmatter);
  useEffect(() => {
    if (!isEditing) setFmDraft(frontmatter);
  }, [frontmatter, isEditing]);

  // Switching pages resets edit state.
  useEffect(() => {
    setIsEditing(false);
    setEditorMode("rich");
    setError(null);
    setRenaming(false);
    setDraftStatus(null);
    setDraftSavedAt(null);
  }, [path]);

  const draftStorageKey = useMemo(
    () => `tome:draft:${slug}:${path}`,
    [path, slug],
  );

  useEffect(() => {
    if (!isEditing) return;
    const timer = window.setTimeout(() => {
      const updatedAt = new Date().toISOString();
      window.localStorage.setItem(
        draftStorageKey,
        JSON.stringify({
          body: serializeFrontmatter(fmDraft, draftBody),
          baseRevisionId,
          updatedAt,
        }),
      );
      setDraftStatus("Draft saved locally");
      setDraftSavedAt(updatedAt);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [baseRevisionId, draftBody, draftStorageKey, fmDraft, isEditing]);

  // Track content changes that landed while this page was open (an out-of-band
  // edit picked up by the polling in TomeWiki) — surfaced as a badge on the
  // History button. Reset on page switch or once the user opens History
  // (they've now seen it). `openedMarkdownRef` anchors "since open" to the
  // first markdown seen for this path, not every render.
  const openedMarkdownRef = useRef(markdown);
  const [changesSinceOpen, setChangesSinceOpen] = useState(0);
  useEffect(() => {
    // Path change: re-anchor to whatever markdown this render has. Reacting
    // to `markdown` here too would re-arm on every content change instead
    // of only on a page switch, so it's deliberately left out of deps.
    openedMarkdownRef.current = markdown;
    setChangesSinceOpen(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => {
    if (markdown !== openedMarkdownRef.current) {
      openedMarkdownRef.current = markdown;
      setChangesSinceOpen((n) => n + 1);
    }
  }, [markdown]);

  const startRename = useCallback(() => {
    setPathDraft(filename);
    setRenaming(true);
  }, [filename]);

  const commitRename = useCallback(async () => {
    const nextFilename = pathDraft.trim().split(/[\\/]/).pop()?.trim() ?? "";
    const parentPath = path.slice(0, path.lastIndexOf("/") + 1);
    const next = `${parentPath}${nextFilename}`;
    setRenaming(false);
    if (!nextFilename || next === path || !onRename) return;
    try {
      await onRename(path, next);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [pathDraft, path, onRename]);

  // External change (agent edit) while not editing → remount to show it live.
  useEffect(() => {
    if (!isEditing) setEditorEpoch((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown]);

  // Ingest started mid-edit → drop to read-only (the agent now owns the page).
  useEffect(() => {
    if (locked && isEditing) {
      setIsEditing(false);
      setEditorMode("rich");
      setEditorEpoch((n) => n + 1);
    }
  }, [locked, isEditing]);

  const handleSave = useCallback(async () => {
    if (editorMode === "rich" && !editorRef.current) return;
    setSaving(true);
    setError(null);
    try {
      let fmToWrite = { ...fmDraft };
      if (isGlossary) {
        fmToWrite = { ...fmDraft };
        const term = String(fmToWrite[FM_TERM] ?? "").trim();
        if (term) fmToWrite[FM_TITLE] = term;
      } else if (isEdgeEntry) {
        fmToWrite = { ...fmDraft };
        const relation = String(fmToWrite[FM_RELATION] ?? "").trim();
        const source = String(fmToWrite[FM_SOURCE] ?? "").trim();
        const target = String(fmToWrite[FM_TARGET] ?? "").trim();
        if (relation && source && target) {
          fmToWrite[FM_TITLE] = `${source} ${relation} ${target}`;
        }
      } else if (isTrackedEntry) {
        fmToWrite = { ...fmDraft };
      }
      const bodyContent = editorMode === "rich"
        ? editorRef.current?.getMarkdown() ?? draftBody
        : draftBody;
      const md = serializeFrontmatter(fmToWrite, bodyContent);
      await onWrite(path, md, `edit ${path}`, { baseRevisionId });
      void fetch(`/api/tome/projects/${slug}/history/${path}`)
        .then((response) => response.json())
        .then((payload) => setLastRevision(payload?.data?.revisions?.[0] ?? null))
        .catch(() => {});
      window.localStorage.removeItem(draftStorageKey);
      setIsEditing(false);
      setEditorMode("rich");
      setDraftStatus(null);
      setDraftSavedAt(null);
      setEditorEpoch((n) => n + 1);
    } catch (e) {
      const saveError = e as Error & {
        code?: string;
        currentRevisionId?: string | null;
        currentMarkdown?: string;
        currentAuthor?: string | null;
        currentCreatedAt?: string | null;
      };
      if (saveError.code === "PAGE_EDIT_CONFLICT") {
        setConflict({
          currentRevisionId: saveError.currentRevisionId ?? null,
          currentMarkdown: saveError.currentMarkdown ?? "",
          currentAuthor: saveError.currentAuthor ?? null,
          currentCreatedAt: saveError.currentCreatedAt ?? null,
        });
      } else {
        setError(String(saveError?.message ?? e));
      }
    } finally {
      setSaving(false);
    }
  }, [baseRevisionId, draftBody, draftStorageKey, editorMode, isGlossary, isEdgeEntry, isTrackedEntry, fmDraft, onWrite, path, slug]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditorMode("rich");
    window.localStorage.removeItem(draftStorageKey);
    setDraftStatus(null);
    setDraftSavedAt(null);
    setEditorEpoch((n) => n + 1);
  }, [draftStorageKey]);

  const handleModeChange = useCallback((nextMode: MarkdownDocumentEditorMode) => {
    if (editorMode === "rich") {
      setRawDraft(serializeFrontmatter(fmDraft, editorRef.current?.getMarkdown() ?? draftBody));
    }
    if (nextMode === "rich" && editorMode !== "rich") {
      setFmDraft(draftFrontmatter);
      setRichInitialBody(draftBody);
      setEditorEpoch((n) => n + 1);
    }
    setEditorMode(nextMode);
  }, [draftBody, draftFrontmatter, editorMode, fmDraft]);

  const insertMediaMarkdown = useCallback((embedMarkdown: string) => {
    if (editorMode === "rich") {
      editorRef.current?.insertMarkdown(embedMarkdown);
      return;
    }
    const view = sourceEditorRef.current?.view;
    if (view) {
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: embedMarkdown },
        selection: { anchor: selection.from + embedMarkdown.length },
      });
      view.focus();
    } else {
      setRawDraft((current) => `${current}${embedMarkdown}`);
    }
  }, [editorMode]);

  const handleSourcePaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (event.clipboardData.files.length) return;
      const match = matchTomeEmbedUrl(event.clipboardData.getData("text/plain"));
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      insertMediaMarkdown(match.markdown);
    },
    [insertMediaMarkdown],
  );

  const handleInlineAiOpenChange = useCallback((open: boolean) => {
    if (open) {
      if (editorMode === "source") {
        const selection = sourceEditorRef.current?.view?.state.selection.main;
        sourceAiSelectionRef.current = selection
          ? { from: selection.from, to: selection.to }
          : null;
      } else {
        editorRef.current?.captureSelection();
      }
    } else if (editorMode === "source") {
      const view = sourceEditorRef.current?.view;
      const selection = sourceAiSelectionRef.current;
      sourceAiSelectionRef.current = null;
      if (view && selection) {
        view.dispatch({ selection: { anchor: selection.from, head: selection.to } });
        view.focus();
      }
    } else {
      editorRef.current?.restoreSelection();
    }
    setInlineAiOpen(open);
  }, [editorMode]);

  const inlineAiContext = useCallback(() => {
    let selected = "";
    let documentBody = draftBody;
    if (editorMode === "source") {
      const view = sourceEditorRef.current?.view;
      if (view) {
        const { from, to } = sourceAiSelectionRef.current ?? view.state.selection.main;
        selected = view.state.sliceDoc(from, to);
      }
    } else {
      selected = editorRef.current?.getSelectedText() ?? "";
      documentBody = editorRef.current?.getMarkdown() ?? draftBody;
    }
    const excerpt = documentBody.length > 3000
      ? `${documentBody.slice(0, 3000)}\n…`
      : documentBody;
    return {
      current_value: selected,
      extra_context: `Page: ${path}\nDocument excerpt:\n${excerpt}`,
    };
  }, [draftBody, editorMode, path]);

  const applyInlineAi = useCallback((markdown: string) => {
    if (editorMode === "source") {
      const view = sourceEditorRef.current?.view;
      if (!view) return;
      const { from, to } = sourceAiSelectionRef.current ?? view.state.selection.main;
      sourceAiSelectionRef.current = null;
      view.dispatch({
        changes: { from, to, insert: markdown },
        selection: { anchor: from + markdown.length },
      });
      view.focus();
      return;
    }
    editorRef.current?.replaceSelection(markdown);
  }, [editorMode]);

  const startEditing = useCallback(() => {
    let initialMarkdown = markdown;
    let initialBase = lastRevision?.id ?? null;
    setDraftStatus(null);
    setDraftSavedAt(null);
    try {
      const stored = window.localStorage.getItem(draftStorageKey);
      if (stored) {
        const recovered = JSON.parse(stored) as {
          body?: unknown;
          baseRevisionId?: unknown;
          updatedAt?: unknown;
        };
        if (typeof recovered.body === "string" && recovered.body !== markdown) {
          initialMarkdown = recovered.body;
          initialBase = typeof recovered.baseRevisionId === "string" ? recovered.baseRevisionId : initialBase;
          setDraftStatus("Recovered local draft");
          if (
            typeof recovered.updatedAt === "string" &&
            Number.isFinite(Date.parse(recovered.updatedAt))
          ) {
            setDraftSavedAt(recovered.updatedAt);
          }
        }
      }
    } catch {
      window.localStorage.removeItem(draftStorageKey);
    }
    const [recoveredFrontmatter, recoveredBody] = parseFrontmatter(initialMarkdown);
    setRawDraft(initialMarkdown);
    setFmDraft(recoveredFrontmatter as Record<string, FrontmatterValue>);
    setRichInitialBody(recoveredBody);
    setBaseRevisionId(initialBase);
    setEditorMode("rich");
    setEditorEpoch((n) => n + 1);
    setIsEditing(true);
  }, [draftStorageKey, lastRevision?.id, markdown]);

  useEffect(() => {
    if (!autoStartEditing || isEditing || !canEdit || locked) return;
    startEditing();
    onAutoStartEditing?.();
  }, [autoStartEditing, canEdit, isEditing, locked, onAutoStartEditing, startEditing]);

  const forceSave = useCallback(async () => {
    if (!conflict) return;
    setSaving(true);
    try {
      const bodyContent = editorMode === "rich"
        ? editorRef.current?.getMarkdown() ?? draftBody
        : draftBody;
      await onWrite(
        path,
        serializeFrontmatter(fmDraft, bodyContent),
        `resolve edit conflict on ${path}`,
        { baseRevisionId: conflict.currentRevisionId, force: true },
      );
      window.localStorage.removeItem(draftStorageKey);
      setConflict(null);
      setIsEditing(false);
      setEditorMode("rich");
      setDraftStatus(null);
      setDraftSavedAt(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }, [conflict, draftBody, draftStorageKey, editorMode, fmDraft, onWrite, path]);

  const handleChangeKind = useCallback(
    async (newKind: PageKind) => {
      if (newKind === kind) return;
      setError(null);
      try {
        const md = serializeFrontmatter({ ...frontmatter, kind: newKind }, body);
        await onWrite(path, md, `set kind=${newKind} on ${path}`);
        await onReload();
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    },
    [kind, frontmatter, body, onWrite, onReload, path],
  );

  const dynamicWarning =
    kind === "dynamic" && isEditing
      ? "Heads up: the agent rewrites this page on every reingest. Your edits go in as context for the next rewrite, but they may not survive verbatim."
      : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        {onClose && (
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2" data-testid="tome-page-title-row">
            <h2 className="min-w-0 truncate text-base font-semibold leading-tight">{title}</h2>
            {isEditing && draftStatus && (
              <p
                className="min-w-0 truncate rounded bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300"
                data-testid="tome-draft-status"
              >
                <span>{draftStatus}</span>
                {draftSavedAt && (
                  <>
                    {" · Last saved "}
                    <time dateTime={draftSavedAt}>
                      {new Date(draftSavedAt).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </time>
                  </>
                )}
              </p>
            )}
            {dynamicWarning && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="shrink-0 cursor-help gap-1 border-amber-300 bg-amber-50 text-[10px] font-medium normal-case text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
                    data-testid="tome-dynamic-warning"
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    Agent rewrites on ingest
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-80 whitespace-normal text-[11px]">
                  {dynamicWarning}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {renaming ? (
              <input
                autoFocus
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenaming(false);
                  }
                }}
                onBlur={() => setRenaming(false)}
                className="block w-full max-w-md rounded border border-input bg-background px-1 py-0.5 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Rename page file name (Enter to save, Esc to cancel)"
              />
            ) : onRename && canEdit && !locked ? (
              <button
                type="button"
                onClick={startRename}
                title="Rename page file name"
                className="min-w-0 truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                {filename}
              </button>
            ) : (
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {filename}
              </span>
            )}
            {lastRevision && onOpenHistory && !isEditing && (
              <>
                <span className="shrink-0 text-[11px] text-muted-foreground/40">·</span>
                <button
                  type="button"
                  onClick={() => {
                    setChangesSinceOpen(0);
                    onOpenHistory();
                  }}
                  className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  title="Open revision history"
                >
                  {changesSinceOpen > 0 && (
                    <span className="mr-1 inline-block rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                      {changesSinceOpen} new
                    </span>
                  )}
                  Updated {relativeTime(lastRevision.created_at)} by {lastRevision.author}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  "cursor-default text-[10px] font-medium normal-case",
                  templateBinding
                    ? "border-muted-foreground/30 text-muted-foreground"
                    : "border-muted-foreground/20 text-muted-foreground/60",
                )}
              >
                {templateBinding ? `template v${templateBinding.version ?? "?"}` : "not from a template"}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64 whitespace-normal text-[11px]">
              {templateBinding ? (
                <>
                  Seeded from the <code>{templateBinding.scope}</code> template&apos;s{" "}
                  <code>{templateBinding.templatePath}</code> at version {templateBinding.version ?? "unknown"}.
                  Run &quot;Check for template drift&quot; (Templates tab) to see whether it&apos;s current.
                </>
              ) : (
                "This page isn't bound to a page template (a manual addition, or it hasn't been re-ingested since template binding shipped)."
              )}
            </TooltipContent>
          </Tooltip>
          {isMirror && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="cursor-default text-[10px] font-medium uppercase tracking-wide border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/30 dark:text-amber-300"
                >
                  mirror
                </Badge>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="flex w-64 flex-col gap-1 whitespace-normal text-[11px] font-normal normal-case leading-relaxed"
              >
                <span className="text-xs font-semibold">Verbatim mirror</span>
                <span className="opacity-70">
                  Copied byte-for-byte from{" "}
                  <code>{String(frontmatter[FM_SOURCE_REPO] ?? "")}</code>
                  {"'s "}
                  <code>{String(frontmatter[FM_SOURCE_PATH] ?? "")}</code>. Re-mirrored
                  every ingest: edits here don&apos;t stick unless the source file
                  changes.
                </span>
              </TooltipContent>
            </Tooltip>
          )}
          {canEdit && !locked && !isMirror && (
            <KindToggle currentKind={kind} onChange={handleChangeKind} />
          )}
          {!isEditing && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setWideReading((v) => !v)}
                    aria-pressed={wideReading}
                    className={cn(
                      "rounded-md border border-border p-1.5 transition-colors hover:bg-muted hover:text-foreground",
                      wideReading ? "bg-muted text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {wideReading ? "Narrow reading width" : "Wide reading width"}
                </TooltipContent>
              </Tooltip>
              <WikiExportMenu
                slug={slug}
                path={path}
                triggerClassName="border border-border p-1.5"
              />
            </>
          )}
          {isEditing ? (
            <div className="flex items-center gap-1">
              <MarkdownEditorModeToggle
                value={editorMode}
                options={MARKDOWN_DOCUMENT_EDITOR_MODES}
                onChange={handleModeChange}
                disabled={saving}
                ariaLabel="Tome editor mode"
                testId="tome-editor-mode-toggle"
              />
              {editorMode !== "preview" && (
                <AiAssistButton
                  task="tome-inline-markdown"
                  label="AI"
                  getContext={inlineAiContext}
                  onApply={applyInlineAi}
                  presets={[
                    "Continue writing here",
                    "Make the selection concise",
                    "Add a supporting bullet list",
                  ]}
                  disabled={saving}
                  triggerTestId="tome-inline-ai"
                  open={inlineAiOpen}
                  onOpenChange={handleInlineAiOpenChange}
                />
              )}
              {editorMode === "source" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => setMediaOpen(true)}
                  disabled={saving}
                >
                  <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                  Media
                </Button>
              )}
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          ) : (
            <ViewOnlyTooltip viewOnly={!canEdit}>
              <button
                type="button"
                onClick={startEditing}
                disabled={locked || !canEdit || isMirror}
                title={
                  isMirror
                    ? "Verbatim mirror of the source repo's .tome/pages file: edit it there instead, this copy is overwritten on every ingest"
                    : canEdit && locked
                      ? awaitingReview
                        ? "A draft is awaiting review: approve or reject it before editing"
                        : "Ingest in progress: the wiki is read-only"
                      : undefined
                }
                className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                Edit
              </button>
            </ViewOnlyTooltip>
          )}
        </div>
      </div>

      {locked && (
        <p className="flex items-center gap-2 border-b bg-amber-500/10 px-5 py-2 text-sm text-amber-600 dark:text-amber-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {awaitingReview
            ? "A draft is awaiting review: the wiki is read-only until it's approved or rejected."
            : "Ingest in progress: the wiki is read-only until it finishes."}
        </p>
      )}

      {error && (
        <p className="border-b bg-destructive/10 px-5 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {isGlossary && (
        <>
          <GlossaryFields
            value={isEditing ? fmDraft : frontmatter}
            editing={isEditing && !previewMode}
            onChange={setFmDraft}
          />
          <div className="px-5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Definition
          </div>
        </>
      )}

      {isEdgeEntry && (
        <>
          <EdgeFields
            value={isEditing ? fmDraft : frontmatter}
            editing={isEditing && !previewMode}
            onChange={setFmDraft}
          />
          <div className="px-5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Explanation
          </div>
        </>
      )}

      {isTrackedEntry && (
        <>
          <TrackedEntityFields
            value={isEditing ? fmDraft : frontmatter}
            editing={isEditing && !previewMode}
            onChange={setFmDraft}
          />
          <div className="px-5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Context and evidence
          </div>
        </>
      )}

      <ScrollArea
        className={cn(
          "flex-1 transition-shadow",
          isEditing &&
            "ring-2 ring-inset ring-amber-400/70 dark:ring-amber-700/60",
        )}
      >
        <div
          className={cn(
            isEditing && editorMode === "rich" && "tome-rich-editor-full-width",
            !isEditing && wideReading && "wide-reading",
          )}
        >
          {isEditing && editorMode === "source" ? (
            <div
              className="h-full min-h-[28rem] p-3"
              onPasteCapture={handleSourcePaste}
            >
              <RichCodeEditor
                editorRef={sourceEditorRef}
                value={rawDraft}
                onChange={(nextMarkdown) => {
                  setRawDraft(nextMarkdown);
                  const [nextFrontmatter] = parseFrontmatter(nextMarkdown);
                  setFmDraft(nextFrontmatter as Record<string, FrontmatterValue>);
                }}
                filename={path}
                language="markdown"
                wrap
                fillContainer
                lintSource={(value) => diagnoseTomeMarkdown(value, { knownPaths })}
                className="h-full"
              />
            </div>
          ) : isEditing && previewMode ? (
            <MarkdownRenderer
              content={draftBody}
              variant="final"
              className="tome-document-preview px-8 py-6"
              onInternalLink={onNavigate}
              glossaryPreview={glossaryPreview}
              enableExternalEmbeds
              enableTomeColumns
            />
          ) : !isEditing ? (
            <MarkdownRenderer
              content={body}
              variant="final"
              className="tome-document-preview px-8 py-6"
              onInternalLink={onNavigate}
              glossaryPreview={glossaryPreview}
              enableExternalEmbeds
              enableTomeColumns
            />
          ) : (
            <CrepeEditor
              key={`${slug}-${path}-${editorEpoch}`}
              ref={editorRef}
              initialMarkdown={richInitialBody}
              readonly={false}
              onChange={(nextBody) => setRawDraft(serializeFrontmatter(fmDraft, nextBody))}
              onNavigate={onNavigate}
              glossaryPreview={glossaryPreview}
              hideHtmlComments
              onInsertMedia={() => setMediaOpen(true)}
              onEnhanceSelection={() => handleInlineAiOpenChange(true)}
              enableColumns
            />
          )}
        </div>
      </ScrollArea>
      <TomeMediaInsertDialog
        open={mediaOpen}
        onOpenChange={setMediaOpen}
        onInsert={insertMediaMarkdown}
      />
      <Dialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Resolve editing conflict</DialogTitle>
            <DialogDescription>
              {conflict?.currentAuthor
                ? `${conflict.currentAuthor} saved a newer revision while you were editing.`
                : "A newer revision was saved while you were editing."}
              {" "}Review both versions before choosing which one should become the next revision.
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[55vh] gap-3 overflow-auto md:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Your draft</p>
              <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">{rawDraft}</pre>
            </div>
            <div className="min-w-0">
              <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Latest saved version</p>
              <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">{conflict?.currentMarkdown}</pre>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConflict(null);
                handleCancel();
                void onReload();
              }}
            >
              Reload latest
            </Button>
            <Button type="button" onClick={() => void forceSave()} disabled={saving}>
              Keep my version as new revision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Popover to flip the page kind among stable / dynamic / hidden. */
function KindToggle({
  currentKind,
  onChange,
}: {
  currentKind: PageKind;
  onChange: (kind: PageKind) => void;
}) {
  const [open, setOpen] = useState(false);
  if (currentKind === "report") return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium capitalize text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Change page kind"
        >
          {currentKind}
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <p className="mb-2 px-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          Change kind
        </p>
        <div className="grid gap-1">
          {FLIPPABLE_KINDS.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
              className={cn(
                "flex items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted",
                o.key === currentKind && "bg-muted",
              )}
            >
              <span className="flex items-center gap-2">
                <KindBadge kind={o.key} iconOnly />
                <span>{o.label}</span>
              </span>
              {o.key === currentKind && (
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  current
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
