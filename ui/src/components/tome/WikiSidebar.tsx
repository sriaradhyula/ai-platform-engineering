"use client";

import { useState, type DragEvent } from "react";
import {
  ChevronRight,
  FilePlus2,
  FolderPlus,
  GripVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/components/credentials/provider-logo";
import { KindBadge } from "@/components/tome/KindBadge";
import type { PageKind, PageTreeNode } from "@/types/tome";

interface Props {
  tree: PageTreeNode[];
  selectedPath: string | null;
  selectedFolderId?: string | null;
  onSelect: (path: string) => void;
  onSelectFolder?: (folderId: string) => void;
  showHidden: boolean;
  /** Delete a page (hover-trash on rows). Omitted in read-only contexts. */
  onDelete?: (path: string) => void;
  onCreateFolder?: (parentId: string | null) => void;
  onCreatePage?: (folder: PageTreeNode) => void;
  onEditFolder?: (node: PageTreeNode) => void;
  onDeleteFolder?: (folderId: string) => void;
  onMoveItem?: (item: WikiNavigationItem, target: WikiNavigationTarget) => void;
}

export type WikiNavigationItem = { kind: "page" | "folder"; id: string };
export type WikiNavigationTarget =
  | { position: "root" }
  | { position: "inside" | "before" | "after"; item: WikiNavigationItem };

/** Recursive sidebar nav for the wiki page tree. */
export function WikiSidebar(props: Props) {
  const [dragging, setDragging] = useState(false);
  return (
    <nav className="text-sm">
      <NodeList
        {...props}
        nodes={props.tree}
        depth={0}
        onDraggingChange={setDragging}
      />
      {props.onMoveItem && dragging && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const item = draggedItem(event);
            if (item) props.onMoveItem?.(item, { position: "root" });
            setDragging(false);
          }}
          className="mx-2 mt-2 rounded border border-dashed border-primary/50 bg-primary/5 px-2 py-2 text-center text-[10px] font-medium text-primary"
        >
          Drop here to move to wiki root
        </div>
      )}
    </nav>
  );
}

// Left padding per nesting level. The caret/spacer slot (CARET_W) is rendered
// on every row, so a child clears its parent's *label* (not just its caret).
const STEP_PX = 12;
const BASE_PX = 8;

// Collection-root folders that start collapsed, so the rail leads with the
// top-level synthesis pages rather than per-source subtrees or the glossary.
const COLLAPSED_ROOTS = new Set([
  "repos",
  "webex",
  "confluence",
  "glossary",
  "edges",
  "issues",
  "decisions",
  "suggestions",
]);

// Root source folders get their provider's brand mark instead of a bare label.
const ROOT_PROVIDER: Record<string, string> = {
  repos: "github",
  confluence: "atlassian",
  webex: "webex",
};

function NodeList({
  nodes,
  depth,
  selectedPath,
  selectedFolderId,
  onSelect,
  onSelectFolder,
  showHidden,
  onDelete,
  onCreateFolder,
  onCreatePage,
  onEditFolder,
  onDeleteFolder,
  onMoveItem,
  onDraggingChange,
}: {
  nodes: PageTreeNode[];
  depth: number;
  onDraggingChange: (dragging: boolean) => void;
} & Omit<Props, "tree">) {
  return (
    <ul>
      {nodes
        .filter((n) => showHidden || n.kind !== "hidden")
        .map((node) => (
          <li key={node.path}>
            <TreeNode
              node={node}
              depth={depth}
              selectedPath={selectedPath}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
              onSelectFolder={onSelectFolder}
              showHidden={showHidden}
              onDelete={onDelete}
              onCreateFolder={onCreateFolder}
              onCreatePage={onCreatePage}
              onEditFolder={onEditFolder}
              onDeleteFolder={onDeleteFolder}
              onMoveItem={onMoveItem}
              onDraggingChange={onDraggingChange}
            />
          </li>
        ))}
    </ul>
  );
}

/** A single tree node: a collapsible folder header, or a selectable page row. */
function TreeNode({
  node,
  depth,
  selectedPath,
  selectedFolderId,
  onSelect,
  onSelectFolder,
  showHidden,
  onDelete,
  onCreateFolder,
  onCreatePage,
  onEditFolder,
  onDeleteFolder,
  onMoveItem,
  onDraggingChange,
}: {
  node: PageTreeNode;
  depth: number;
  onDraggingChange: (dragging: boolean) => void;
} & Omit<Props, "tree">) {
  const hasChildren = node.children.length > 0;
  const leaf = node.path.split("/").pop() ?? node.path;
  const [open, setOpen] = useState(!COLLAPSED_ROOTS.has(leaf));
  const [dropZone, setDropZone] = useState<"before" | "inside" | "after" | null>(null);
  const indent = { paddingLeft: `${depth * STEP_PX + BASE_PX}px` };
  const navigationItem: WikiNavigationItem | null = node.kind === "folder"
    ? node.folderId ? { kind: "folder", id: node.folderId } : null
    : { kind: "page", id: node.path };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!navigationItem || !onMoveItem) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / Math.max(bounds.height, 1);
    setDropZone(
      node.kind === "folder"
        ? ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside"
        : ratio < 0.5 ? "before" : "after",
    );
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const item = draggedItem(event);
    if (item && navigationItem && dropZone) {
      onMoveItem?.(item, { position: dropZone, item: navigationItem });
    }
    setDropZone(null);
    onDraggingChange(false);
  };

  const children = hasChildren && (
    <NodeList
      nodes={node.children}
      depth={depth + 1}
      selectedPath={selectedPath}
      selectedFolderId={selectedFolderId}
      onSelect={onSelect}
      onSelectFolder={onSelectFolder}
      showHidden={showHidden}
      onDelete={onDelete}
      onCreateFolder={onCreateFolder}
      onCreatePage={onCreatePage}
      onEditFolder={onEditFolder}
      onDeleteFolder={onDeleteFolder}
      onMoveItem={onMoveItem}
      onDraggingChange={onDraggingChange}
    />
  );

  // Folder = a collapsible section header (the caret toggles its children).
  if (node.kind === "folder") {
    const provider = depth === 0 ? ROOT_PROVIDER[leaf] : undefined;
    const selected = node.folderId === selectedFolderId;
    return (
      <>
        <div
          style={indent}
          onDragOver={handleDragOver}
          onDragLeave={() => setDropZone(null)}
          onDrop={handleDrop}
          className={cn(
            "group flex w-full items-center gap-1 rounded pr-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            selected && "bg-muted text-primary",
            dropZone === "inside" && "bg-primary/15 text-primary ring-1 ring-inset ring-primary/50",
            dropZone === "before" && "border-t-2 border-primary",
            dropZone === "after" && "border-b-2 border-primary",
          )}
        >
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.title}`}
            className="shrink-0"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
          <button
            type="button"
            onClick={() => node.folderId && onSelectFolder
              ? onSelectFolder(node.folderId)
              : setOpen((openState) => !openState)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            {provider && (
              <ProviderLogo provider={provider} className="h-3 w-3 shrink-0 object-contain" />
            )}
            <span className="truncate">{node.title}</span>
            {hasChildren && (
              <span className="ml-auto shrink-0 pl-2 text-[10px] font-normal tabular-nums text-muted-foreground/70 group-hover:hidden">
                {node.children.length}
              </span>
            )}
          </button>
          {node.folderId && (onCreatePage || onEditFolder || onMoveItem) && (
            <span className="hidden shrink-0 items-center gap-0.5 normal-case group-hover:flex">
              {onMoveItem && navigationItem && (
                <DragHandle
                  item={navigationItem}
                  label={`Move ${node.title}`}
                  onDraggingChange={onDraggingChange}
                />
              )}
              {onCreateFolder && (
                <FolderAction label={`New folder in ${node.title}`} onClick={() => onCreateFolder(node.folderId!)}>
                  <FolderPlus className="h-3 w-3" />
                </FolderAction>
              )}
              {onCreatePage && (
                <FolderAction label={`New page in ${node.title}`} onClick={() => onCreatePage(node)}>
                  <FilePlus2 className="h-3 w-3" />
                </FolderAction>
              )}
              {onEditFolder && (
                <FolderAction label={`Edit ${node.title}`} onClick={() => onEditFolder(node)}>
                  <Pencil className="h-3 w-3" />
                </FolderAction>
              )}
              {onDeleteFolder && (
                <FolderAction label={`Delete ${node.title}`} onClick={() => onDeleteFolder(node.folderId!)} destructive>
                  <Trash2 className="h-3 w-3" />
                </FolderAction>
              )}
            </span>
          )}
        </div>
        {open && children}
      </>
    );
  }

  const selected = node.path === selectedPath;
  return (
    <>
      {/* `group` row: title button, then the (always-visible) kind badge, then
          the hover-trash. Badge + trash are siblings of the button (a button
          can't nest a button); the trash keeps its layout slot via opacity so
          the badge sits at a stable position whether or not it shows. */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={() => setDropZone(null)}
        onDrop={handleDrop}
        className={cn(
          "group flex items-center gap-1.5 rounded pr-1.5 transition-colors hover:bg-muted",
          selected && "bg-muted font-medium text-primary",
          dropZone === "before" && "border-t-2 border-primary",
          dropZone === "after" && "border-b-2 border-primary",
        )}
      >
        <button
          type="button"
          style={indent}
          onClick={() => onSelect(node.path)}
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left"
        >
          {/* Empty caret slot keeps page labels aligned with folder labels at
              the same depth. */}
          <span className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{node.title}</span>
        </button>
        <span className="flex shrink-0 items-center">
          <KindBadge kind={node.kind as PageKind} iconOnly />
        </span>
        {onMoveItem && navigationItem && (
          <span className="hidden group-hover:inline-flex">
            <DragHandle
              item={navigationItem}
              label={`Move ${node.title}`}
              onDraggingChange={onDraggingChange}
            />
          </span>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path);
            }}
            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            aria-label={`Delete ${node.title}`}
            title={`Delete ${node.title}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {children}
    </>
  );
}

const DRAG_MIME = "application/x-tome-navigation-item";

function draggedItem(event: DragEvent<HTMLElement>): WikiNavigationItem | null {
  try {
    const encoded = event.dataTransfer.getData(DRAG_MIME) || event.dataTransfer.getData("text/plain");
    const value = JSON.parse(encoded) as WikiNavigationItem;
    return (value.kind === "page" || value.kind === "folder") && typeof value.id === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

function DragHandle({
  item,
  label,
  onDraggingChange,
}: {
  item: WikiNavigationItem;
  label: string;
  onDraggingChange: (dragging: boolean) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        const encoded = JSON.stringify(item);
        event.dataTransfer.setData(DRAG_MIME, encoded);
        event.dataTransfer.setData("text/plain", encoded);
        onDraggingChange(true);
      }}
      onDragEnd={() => onDraggingChange(false)}
      className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground active:cursor-grabbing"
      aria-label={label}
      title={`${label} — drag to reorder or move`}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  );
}

function FolderAction({
  label,
  onClick,
  destructive = false,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground",
        destructive && "hover:text-destructive",
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
