import type { TomeFolder } from "@/types/tome";

type PageCreationFolder = Pick<
  TomeFolder,
  "id" | "parent_id" | "name" | "source_path"
>;

function normalizePagePath(rawPath: string): string {
  let path = rawPath.trim().replace(/^\/+/, "");
  if (path && !/\.(md|mdx)$/i.test(path)) path += ".md";
  return path;
}

function folderChain(
  folderId: string,
  folders: readonly PageCreationFolder[],
): PageCreationFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const chain: PageCreationFolder[] = [];
  const visited = new Set<string>();
  let cursor = byId.get(folderId);

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }

  return chain;
}

/** Resolve the storage path represented by a persisted navigation folder. */
export function resolveFolderPagePath(
  folderId: string,
  folders: readonly PageCreationFolder[],
): { path: string; breadcrumb: string } | null {
  const chain = folderChain(folderId, folders);
  if (chain.length === 0) return null;

  let path = "";
  for (const folder of chain) {
    // Imported/path-derived folders already own an authoritative source path.
    // UI-created descendants do not, so extend the nearest known path with
    // their exact names until their first page materializes that path.
    path = folder.source_path ?? [path, folder.name].filter(Boolean).join("/");
  }

  return {
    path,
    breadcrumb: chain.map((folder) => folder.name).join(" / "),
  };
}

export function resolvePageCreationPath(
  rawPath: string,
  folderId: string | null | undefined,
  folders: readonly PageCreationFolder[],
): { path: string; folderBreadcrumb: string | null } {
  const pagePath = normalizePagePath(rawPath);
  const folder = folderId ? resolveFolderPagePath(folderId, folders) : null;
  if (!folder || !pagePath) {
    return { path: pagePath, folderBreadcrumb: folder?.breadcrumb ?? null };
  }

  const prefix = `${folder.path}/`;
  return {
    path: pagePath.startsWith(prefix) ? pagePath : `${prefix}${pagePath}`,
    folderBreadcrumb: folder.breadcrumb,
  };
}

export function buildPageCreationAgentPrompt(input: {
  projectSlug: string;
  rawPath: string;
  folderId?: string | null;
  folders: readonly PageCreationFolder[];
}): string {
  const target = resolvePageCreationPath(
    input.rawPath,
    input.folderId,
    input.folders,
  );
  const folderContext = target.folderBreadcrumb
    ? ` The selected folder breadcrumb is \`${target.folderBreadcrumb}\`.`
    : "";

  return (
    `Help me create a new Tome wiki page in project \`${input.projectSlug}\` at the exact ` +
    `wiki-relative path \`${target.path}\`.` +
    folderContext +
    " The exact path is authoritative: do not shorten it, rename any segment, or infer a different path. " +
    "Ask what the page should contain, then draft it and write it only when I approve."
  );
}
