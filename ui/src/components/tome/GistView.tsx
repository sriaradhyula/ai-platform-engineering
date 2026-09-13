"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ImagePlus,
  Info,
  Link2,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CrepeEditor, type CrepeEditorHandle } from "@/components/tome/CrepeEditor";
import { TomeLoading } from "@/components/tome/TomeLoading";
import { TomeMediaInsertDialog } from "@/components/tome/TomeMediaInsertDialog";
import { WikiExportMenu } from "@/components/tome/WikiExportMenu";
import { matchTomeEmbedUrl } from "@/lib/tome/embeds";
import { defaultGistFilename, normalizeGistFilename } from "@/lib/tome/gists";
import { diagnoseTomeMarkdown } from "@/lib/tome/markdown-diagnostics";
import { readJsonOrError } from "@/lib/safe-json";
import { cn } from "@/lib/utils";
import type { GistRecord } from "@/types/tome";

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

type GistApiResponse = {
  data?: { gist?: GistRecord };
  error?: { message?: string };
};

async function readGistResponse(
  response: Response,
  fallbackMessage: string,
): Promise<GistRecord> {
  const parsed = await readJsonOrError<GistApiResponse>(response);
  if (!parsed.ok) {
    if (response.status === 413) {
      throw new Error(
        "This gist is too large to save. Remove an embedded image or use a smaller image, then try again.",
      );
    }
    throw new Error(
      `${fallbackMessage} (${response.status}). The server returned an unexpected response.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      parsed.data.error?.message || `${fallbackMessage} (${response.status})`,
    );
  }
  const gist = parsed.data.data?.gist;
  if (!gist) {
    throw new Error(`${fallbackMessage}: the server response did not include the gist.`);
  }
  return gist;
}

/** A gist read or edited in the same full-page Markdown workspace as a wiki page. */
export function GistView({
  slug,
  id,
  canEdit,
  onBack,
  onCreated,
}: {
  slug: string;
  /** Omit for the dedicated new-gist editor. */
  id?: string;
  canEdit: boolean;
  onBack: () => void;
  onCreated?: (id: string) => void;
}) {
  const creating = id === undefined;
  const [gist, setGist] = useState<GistRecord | null>(null);
  const [loading, setLoading] = useState(!creating);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(creating);
  const [editorMode, setEditorMode] = useState<MarkdownDocumentEditorMode>("rich");
  const [wideContent, setWideContent] = useState(true);
  const [rawDraft, setRawDraft] = useState("");
  const [richInitialBody, setRichInitialBody] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [title, setTitle] = useState("");
  const [filename, setFilename] = useState("gist.md");
  const [filenameDraft, setFilenameDraft] = useState("gist.md");
  const [filenameCustomized, setFilenameCustomized] = useState(false);
  const [renamingFilename, setRenamingFilename] = useState(false);
  const [filenameSaving, setFilenameSaving] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [inlineAiOpen, setInlineAiOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const editorRef = useRef<CrepeEditorHandle>(null);
  const sourceEditorRef = useRef<ReactCodeMirrorRef | null>(null);
  const sourceAiSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const draftStorageKey = useMemo(
    () => `tome:gist-draft:${slug}:${id ?? "new"}`,
    [id, slug],
  );

  const loadEditorDraft = useCallback((source?: GistRecord) => {
    let nextTitle = source?.title ?? "";
    let nextFilename = source?.filename ?? defaultGistFilename(nextTitle);
    let nextBody = source?.body ?? "";
    let nextTags = source?.tags ?? [];
    let recoveredFilename = false;
    setDraftStatus(null);
    setDraftSavedAt(null);
    try {
      const stored = window.localStorage.getItem(draftStorageKey);
      if (stored) {
        const recovered = JSON.parse(stored) as {
          title?: unknown;
          filename?: unknown;
          body?: unknown;
          tags?: unknown;
          updatedAt?: unknown;
        };
        if (typeof recovered.title === "string") nextTitle = recovered.title;
        if (typeof recovered.filename === "string") {
          nextFilename = recovered.filename;
          recoveredFilename = true;
        }
        if (typeof recovered.body === "string") nextBody = recovered.body;
        if (Array.isArray(recovered.tags)) {
          nextTags = recovered.tags.filter((tag): tag is string => typeof tag === "string");
        }
        setDraftStatus("Recovered local draft");
        if (
          typeof recovered.updatedAt === "string" &&
          Number.isFinite(Date.parse(recovered.updatedAt))
        ) {
          setDraftSavedAt(recovered.updatedAt);
        }
      }
    } catch {
      window.localStorage.removeItem(draftStorageKey);
    }
    setTitle(nextTitle);
    setFilename(nextFilename);
    setFilenameDraft(nextFilename);
    setFilenameCustomized(Boolean(source?.filename) || recoveredFilename);
    setRenamingFilename(false);
    setRawDraft(nextBody);
    setRichInitialBody(nextBody);
    setTags(nextTags);
    setTagDraft("");
    setError(null);
    setEditorMode("rich");
    setEditorEpoch((current) => current + 1);
    setEditing(true);
  }, [draftStorageKey]);

  useEffect(() => {
    if (creating && editing && !filenameCustomized) {
      const derived = defaultGistFilename(title);
      setFilename(derived);
      setFilenameDraft(derived);
    }
  }, [creating, editing, filenameCustomized, title]);

  useEffect(() => {
    let cancelled = false;
    setGist(null);
    setError(null);
    setDeleting(false);
    setEditorMode("rich");
    setDraftStatus(null);
    setDraftSavedAt(null);

    if (!id) {
      setLoading(false);
      loadEditorDraft();
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setEditing(false);
    fetch(`/api/tome/projects/${slug}/gists/${id}`)
      .then(async (response) => {
        return readGistResponse(response, "Failed to load gist");
      })
      .then((loadedGist) => {
        if (!cancelled) setGist(loadedGist);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, loadEditorDraft, slug]);

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      const updatedAt = new Date().toISOString();
      window.localStorage.setItem(
        draftStorageKey,
        JSON.stringify({ title, filename, body: rawDraft, tags, updatedAt }),
      );
      setDraftStatus("Draft saved locally");
      setDraftSavedAt(updatedAt);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draftStorageKey, editing, filename, rawDraft, tags, title]);

  const beginEditing = useCallback(() => {
    if (gist) loadEditorDraft(gist);
  }, [gist, loadEditorDraft]);

  const cancelEditing = useCallback(() => {
    window.localStorage.removeItem(draftStorageKey);
    setDraftStatus(null);
    setDraftSavedAt(null);
    setTagDraft("");
    setRenamingFilename(false);
    setError(null);
    setEditorMode("rich");
    setEditorEpoch((current) => current + 1);
    if (creating) {
      onBack();
    } else {
      setEditing(false);
    }
  }, [creating, draftStorageKey, onBack]);

  const handleModeChange = useCallback((nextMode: MarkdownDocumentEditorMode) => {
    if (editorMode === "rich") {
      setRawDraft(editorRef.current?.getMarkdown() ?? rawDraft);
    }
    if (nextMode === "rich" && editorMode !== "rich") {
      setRichInitialBody(rawDraft);
      setEditorEpoch((current) => current + 1);
    }
    setEditorMode(nextMode);
  }, [editorMode, rawDraft]);

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
    let documentBody = rawDraft;
    if (editorMode === "source") {
      const view = sourceEditorRef.current?.view;
      if (view) {
        const { from, to } = sourceAiSelectionRef.current ?? view.state.selection.main;
        selected = view.state.sliceDoc(from, to);
      }
    } else {
      selected = editorRef.current?.getSelectedText() ?? "";
      documentBody = editorRef.current?.getMarkdown() ?? rawDraft;
    }
    const excerpt = documentBody.length > 3000
      ? `${documentBody.slice(0, 3000)}\n…`
      : documentBody;
    return {
      current_value: selected,
      extra_context: `Gist: ${title.trim() || "Untitled gist"}\nDocument excerpt:\n${excerpt}`,
    };
  }, [editorMode, rawDraft, title]);

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

  const commitTagDraft = useCallback(() => {
    const tag = tagDraft.trim();
    setTagDraft("");
    if (tag && !tags.includes(tag)) setTags((current) => [...current, tag]);
  }, [tagDraft, tags]);

  const startFilenameRename = useCallback(() => {
    const current = editing
      ? filename
      : gist?.filename ?? defaultGistFilename(gist?.title ?? title);
    setFilename(current);
    setFilenameDraft(current);
    setRenamingFilename(true);
  }, [editing, filename, gist, title]);

  const commitFilenameRename = useCallback(async () => {
    let nextFilename: string;
    try {
      nextFilename = normalizeGistFilename(filenameDraft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }

    const currentFilename = editing
      ? filename
      : gist?.filename ?? defaultGistFilename(gist?.title ?? title);
    if (nextFilename === currentFilename) {
      setRenamingFilename(false);
      return;
    }
    if (creating || !id) {
      setFilename(nextFilename);
      setFilenameCustomized(true);
      setRenamingFilename(false);
      return;
    }

    setFilenameSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/tome/projects/${slug}/gists/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: nextFilename }),
      });
      const updatedGist = await readGistResponse(response, "Failed to rename gist");
      const updatedFilename = updatedGist.filename ?? defaultGistFilename(updatedGist.title);
      setGist(updatedGist);
      setFilename(updatedFilename);
      setFilenameDraft(updatedFilename);
      setFilenameCustomized(true);
      setRenamingFilename(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFilenameSaving(false);
    }
  }, [creating, editing, filename, filenameDraft, gist, id, slug, title]);

  const save = useCallback(async () => {
    if (!title.trim()) return;
    let normalizedFilename: string;
    try {
      normalizedFilename = normalizeGistFilename(filename);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    const body = editorMode === "rich"
      ? editorRef.current?.getMarkdown() ?? rawDraft
      : rawDraft;
    if (!body.trim()) return;
    const pendingTag = tagDraft.trim();
    const nextTags = pendingTag && !tags.includes(pendingTag) ? [...tags, pendingTag] : tags;
    setSaving(true);
    setError(null);
    try {
      const endpoint = creating
        ? `/api/tome/projects/${slug}/gists`
        : `/api/tome/projects/${slug}/gists/${id}`;
      const response = await fetch(endpoint, {
        method: creating ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          filename: normalizedFilename,
          body,
          tags: nextTags,
        }),
      });
      const savedGist = await readGistResponse(
        response,
        `Failed to ${creating ? "create" : "update"} gist`,
      );
      const savedFilename = savedGist.filename ?? defaultGistFilename(savedGist.title);
      window.localStorage.removeItem(draftStorageKey);
      setGist(savedGist);
      setFilename(savedFilename);
      setFilenameDraft(savedFilename);
      setEditing(false);
      setEditorMode("rich");
      setTagDraft("");
      setDraftStatus(null);
      setDraftSavedAt(null);
      setEditorEpoch((current) => current + 1);
      if (creating) onCreated?.(savedGist.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [creating, draftStorageKey, editorMode, filename, id, onCreated, rawDraft, slug, tagDraft, tags, title]);

  const remove = useCallback(async () => {
    if (!gist || !id) return;
    if (!window.confirm(`Delete gist "${gist.title}"?`)) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/tome/projects/${slug}/gists/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Delete failed (${response.status})`);
      }
      onBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDeleting(false);
    }
  }, [gist, id, onBack, slug]);

  const canChange = creating || canEdit;

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-2 border-b px-4 py-2.5"
        data-testid="gist-editor-header"
      >
        <Button variant="ghost" size="sm" className="h-auto gap-1.5 px-2 py-1" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          Gists
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {gist && !editing && id && (
            <>
              <CopyButton
                value={() => `${window.location.origin}/projects/${slug}/tome/gists/${id}`}
                label="Share"
                copiedLabel="Link copied"
                icon={Link2}
                size="sm"
                className="h-auto px-2 py-1 text-muted-foreground"
              >
                Share
              </CopyButton>
              <CopyButton
                value={() => gist.body}
                label="Copy page"
                copiedLabel="Copied"
                size="sm"
                className="h-auto px-2 py-1 text-muted-foreground"
              >
                Copy page
              </CopyButton>
              <WikiExportMenu
                slug={slug}
                gist={{ id, title: gist.title, filename: gist.filename }}
                triggerClassName="border border-border p-1.5"
              />
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setWideContent((current) => !current)}
                aria-label={wideContent ? "Use narrow content width" : "Use wide content width"}
                aria-pressed={wideContent}
                className={cn(
                  "rounded-md border border-border p-1.5 transition-colors hover:bg-muted hover:text-foreground",
                  wideContent ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {wideContent ? "Narrow content width" : "Wide content width"}
            </TooltipContent>
          </Tooltip>
          {editing ? (
            <>
              <MarkdownEditorModeToggle
                value={editorMode}
                options={MARKDOWN_DOCUMENT_EDITOR_MODES}
                onChange={handleModeChange}
                disabled={saving}
                ariaLabel="Gist editor mode"
                testId="gist-editor-mode-toggle"
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
                  triggerTestId="gist-inline-ai"
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
                onClick={cancelEditing}
                disabled={saving}
                className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || filenameSaving || !title.trim() || !rawDraft.trim()}
                className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? "Saving…" : creating ? "Create gist" : "Save"}
              </button>
            </>
          ) : gist && canChange ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto gap-1.5 px-2 py-1 text-muted-foreground"
                onClick={beginEditing}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto gap-1.5 px-2 py-1 text-muted-foreground hover:text-destructive"
                disabled={deleting}
                onClick={() => void remove()}
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {error && (
        <p className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</p>
      )}

      <ScrollArea
        className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!flex [&_[data-radix-scroll-area-viewport]>div]:min-h-full [&_[data-radix-scroll-area-viewport]>div]:flex-col"
        data-testid="gist-scroll-area"
      >
        {loading ? (
          <TomeLoading />
        ) : !gist && !creating ? (
          <div className="p-8 text-sm text-muted-foreground">Gist not found.</div>
        ) : (
          <div
            className={cn(
              "flex min-h-full w-full flex-1 flex-col transition-[max-width]",
              !wideContent && "mx-auto max-w-[65rem]",
            )}
            data-testid="gist-content-layout"
          >
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3"
              data-testid="gist-title-tags-row"
            >
              <div className="min-w-48 flex-1">
                {editing && editorMode !== "preview" ? (
                  <Input
                    aria-label="Gist title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Untitled gist"
                    className="h-auto w-full border-0 px-0 py-0 text-2xl font-semibold leading-tight shadow-none focus-visible:ring-0"
                    autoFocus
                  />
                ) : (
                  <h1 className="truncate text-2xl font-semibold leading-tight">
                    {editing ? title.trim() || "Untitled gist" : gist?.title}
                  </h1>
                )}
                <div
                  className="mt-0.5 flex min-w-0 items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"
                  data-testid="gist-author-meta"
                >
                  {renamingFilename ? (
                    <input
                      autoFocus
                      value={filenameDraft}
                      onChange={(event) => setFilenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitFilenameRename();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setFilenameDraft(
                            editing
                              ? filename
                              : gist?.filename ?? defaultGistFilename(gist?.title ?? title),
                          );
                          setRenamingFilename(false);
                        }
                      }}
                      onBlur={() => void commitFilenameRename()}
                      disabled={filenameSaving}
                      className="block w-full max-w-md rounded border border-input bg-background px-1 py-0.5 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Rename gist filename (Enter to save, Esc to cancel)"
                    />
                  ) : canChange ? (
                    <button
                      type="button"
                      onClick={startFilenameRename}
                      disabled={filenameSaving}
                      title="Rename gist filename"
                      className="min-w-0 truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline disabled:opacity-60"
                    >
                      {editing
                        ? filename
                        : gist?.filename ?? defaultGistFilename(gist?.title ?? title)}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                      {gist?.filename ?? defaultGistFilename(gist?.title ?? title)}
                    </span>
                  )}
                  {filenameSaving && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                  )}
                  {creating ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>New gist · saved outside the curated wiki</span>
                    </>
                  ) : gist ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{gist.author}</span>
                      <span aria-hidden="true">·</span>
                      <span>modified {timeLabel(gist.updated_at ?? gist.created_at)}</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="View gist creation and modification details"
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Info className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          className="w-80 max-w-[calc(100vw-2rem)] whitespace-normal p-3 text-left"
                        >
                          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                            <dt className="font-medium text-muted-foreground">Created</dt>
                            <dd>{timeLabel(gist.created_at)}</dd>
                            <dt className="font-medium text-muted-foreground">Created by</dt>
                            <dd className="break-all">{gist.author}</dd>
                            <dt className="font-medium text-muted-foreground">Last modified</dt>
                            <dd>
                              {gist.updated_at
                                ? timeLabel(gist.updated_at)
                                : "Not modified since creation"}
                            </dd>
                            {gist.updated_at && (
                              <>
                                <dt className="font-medium text-muted-foreground">Modified by</dt>
                                <dd className="break-all">{gist.updated_by ?? gist.author}</dd>
                              </>
                            )}
                          </dl>
                        </TooltipContent>
                      </Tooltip>
                    </>
                  ) : null}
                </div>
              </div>
              {editing && draftStatus && (
                <p
                  className="min-w-0 truncate rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300"
                  data-testid="gist-draft-status"
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
              {editing && editorMode !== "preview" ? (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="gap-1 pr-1 text-xs">
                      {tag}
                      <button
                        type="button"
                        onClick={() => setTags((current) => current.filter((value) => value !== tag))}
                        className="rounded-full hover:bg-muted"
                        aria-label={`Remove tag ${tag}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  <Input
                    aria-label="Add tag"
                    placeholder="Add tag, press Enter"
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === ",") {
                        event.preventDefault();
                        commitTagDraft();
                      }
                    }}
                    onBlur={commitTagDraft}
                    className="h-7 w-36 border-none px-1 shadow-none focus-visible:ring-0"
                  />
                </div>
              ) : (editing ? tags : gist?.tags)?.length ? (
                <div className="ml-auto flex flex-wrap justify-end gap-1.5">
                  {(editing ? tags : gist?.tags ?? []).map((tag) => (
                    <Badge key={tag} variant="outline">{tag}</Badge>
                  ))}
                </div>
              ) : null}
            </div>

            <div
              className={cn(
                "min-h-[28rem] flex-1 text-sm transition-shadow",
                editing && "ring-2 ring-inset ring-amber-400/70 dark:ring-amber-700/60",
                editing && editorMode === "rich" && wideContent && "tome-rich-editor-full-width",
              )}
              data-testid="gist-editor-canvas"
            >
              {editing && editorMode === "source" ? (
                <div className="h-full min-h-[28rem] p-3" onPasteCapture={handleSourcePaste}>
                  <RichCodeEditor
                    editorRef={sourceEditorRef}
                    value={rawDraft}
                    onChange={setRawDraft}
                    filename={filename}
                    language="markdown"
                    wrap
                    fillContainer
                    lintSource={diagnoseTomeMarkdown}
                    className="h-full"
                  />
                </div>
              ) : editing && editorMode === "preview" ? (
                <MarkdownRenderer
                  content={rawDraft}
                  variant="final"
                  className="tome-document-preview px-8 py-6"
                  enableExternalEmbeds
                  enableTomeColumns
                />
              ) : editing ? (
                <CrepeEditor
                  key={`${slug}-${id ?? "new"}-${editorEpoch}`}
                  ref={editorRef}
                  initialMarkdown={richInitialBody}
                  onChange={setRawDraft}
                  onInsertMedia={() => setMediaOpen(true)}
                  onEnhanceSelection={() => handleInlineAiOpenChange(true)}
                  enableColumns
                />
              ) : gist ? (
                <MarkdownRenderer
                  content={gist.body}
                  variant="final"
                  className="tome-document-preview px-8 py-6"
                  enableExternalEmbeds
                  enableTomeColumns
                />
              ) : null}
            </div>
          </div>
        )}
      </ScrollArea>
      <TomeMediaInsertDialog
        open={mediaOpen}
        onOpenChange={setMediaOpen}
        onInsert={insertMediaMarkdown}
      />
    </div>
  );
}
