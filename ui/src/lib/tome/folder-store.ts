import { createHash, randomUUID } from "crypto";

import { getTomeFoldersCollection } from "@/lib/tome/mongo-collections";
import type { TomeFolder } from "@/types/tome";

const MAX_FOLDER_NAME = 120;
let indexesReady: Promise<unknown> | null = null;

export class FolderValidationError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 400,
  ) {
    super(message);
    this.name = "FolderValidationError";
  }
}

function validateName(value: string): string {
  const name = value.trim();
  if (!name) throw new FolderValidationError("Folder name is required.", "FOLDER_NAME_REQUIRED");
  if (name.length > MAX_FOLDER_NAME) {
    throw new FolderValidationError(
      `Folder names must be ${MAX_FOLDER_NAME} characters or fewer.`,
      "FOLDER_NAME_TOO_LONG",
    );
  }
  if (/[\/\0]/.test(name) || name === "." || name === "..") {
    throw new FolderValidationError(
      "Folder names cannot contain slashes or path traversal segments.",
      "INVALID_FOLDER_NAME",
    );
  }
  return name;
}

function inferredFolderId(projectId: string, sourcePath: string): string {
  return `folder-${createHash("sha256").update(`${projectId}\0${sourcePath}`).digest("hex").slice(0, 24)}`;
}

function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

function titleFromPath(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  return leaf.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

async function collection() {
  const folders = await getTomeFoldersCollection();
  indexesReady ??= Promise.all([
    folders.createIndex({ project_id: 1, id: 1 }, { unique: true }),
    folders.createIndex({ project_id: 1, parent_id: 1, order: 1 }),
    folders.createIndex(
      { project_id: 1, source_path: 1 },
      { unique: true, partialFilterExpression: { source_path: { $type: "string" } } },
    ),
    folders.createIndex(
      { project_id: 1, parent_id: 1, name_key: 1 },
      { unique: true, partialFilterExpression: { name_key: { $type: "string" } } },
    ),
  ]);
  await indexesReady;
  return folders;
}

/** Lazily migrates path-derived folders without changing any page content or URL. */
export async function ensureFoldersForPages(
  projectId: string,
  pagePaths: readonly string[],
  actor: string,
): Promise<void> {
  const paths = new Set<string>();
  for (const pagePath of pagePaths) {
    const segments = pagePath.split("/").slice(0, -1);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      paths.add(segments.slice(0, depth).join("/"));
    }
  }
  if (paths.size === 0) return;

  const folders = await collection();
  const existing: TomeFolder[] = await folders.find({ project_id: projectId }).toArray();
  const bySourcePath = new Map(
    existing.flatMap((folder) => folder.source_path ? [[folder.source_path, folder]] : []),
  );
  for (const sourcePath of [...paths].sort(
    (left, right) => left.split("/").length - right.split("/").length,
  )) {
    if (bySourcePath.has(sourcePath)) continue;
    const parentPath = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : null;
    const parentId = parentPath ? bySourcePath.get(parentPath)?.id ?? null : null;
    const name = titleFromPath(sourcePath);
    const reusable = existing.find((folder) =>
      folder.parent_id === parentId &&
      folder.source_path === null &&
      (folder.name_key ?? nameKey(folder.name)) === nameKey(name),
    );
    const now = new Date();
    if (reusable) {
      await folders.updateOne(
        { project_id: projectId, id: reusable.id },
        { $set: { source_path: sourcePath, updated_at: now, updated_by: actor } },
      );
      reusable.source_path = sourcePath;
      bySourcePath.set(sourcePath, reusable);
      continue;
    }

    const id = inferredFolderId(projectId, sourcePath);
    const inferred: TomeFolder = {
      id,
      project_id: projectId,
      parent_id: parentId,
      name,
      name_key: nameKey(name),
      source_path: sourcePath,
      order: 999,
      owner_subject: actor,
      permission_scope: "project",
      created_at: now,
      updated_at: now,
      updated_by: actor,
    };
    await folders.updateOne(
      { project_id: projectId, id },
      { $setOnInsert: inferred },
      { upsert: true },
    );
    existing.push(inferred);
    bySourcePath.set(sourcePath, inferred);
  }
}

export async function listFolders(projectId: string): Promise<TomeFolder[]> {
  return (await collection())
    .find({ project_id: projectId })
    .sort({ parent_id: 1, order: 1, name: 1 })
    .toArray();
}

async function assertUniqueSiblingName(
  projectId: string,
  parentId: string | null,
  name: string,
  exceptId?: string,
): Promise<void> {
  const siblings = await (await collection()).find({ project_id: projectId, parent_id: parentId }).toArray();
  if (siblings.some((folder) => folder.id !== exceptId && folder.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
    throw new FolderValidationError(
      `A folder named “${name}” already exists here.`,
      "DUPLICATE_FOLDER_NAME",
      409,
    );
  }
}

export async function createFolder(input: {
  projectId: string;
  parentId: string | null;
  name: string;
  actor: string;
}): Promise<TomeFolder> {
  const name = validateName(input.name);
  const folders = await collection();
  if (input.parentId) {
    const parent = await folders.findOne({ project_id: input.projectId, id: input.parentId });
    if (!parent) throw new FolderValidationError("Parent folder was not found.", "FOLDER_PARENT_NOT_FOUND", 404);
  }
  await assertUniqueSiblingName(input.projectId, input.parentId, name);
  const siblings = await folders.find({ project_id: input.projectId, parent_id: input.parentId }).toArray();
  const now = new Date();
  const folder: TomeFolder = {
    id: `folder-${randomUUID()}`,
    project_id: input.projectId,
    parent_id: input.parentId,
    name,
    name_key: nameKey(name),
    source_path: null,
    order: Math.max(-1, ...siblings.map((sibling) => sibling.order)) + 1,
    owner_subject: input.actor,
    permission_scope: "project",
    created_at: now,
    updated_at: now,
    updated_by: input.actor,
  };
  await folders.insertOne(folder);
  return folder;
}

export function folderMoveWouldCycle(
  folderId: string,
  parentId: string | null,
  folders: readonly Pick<TomeFolder, "id" | "parent_id">[],
): boolean {
  if (!parentId) return false;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let cursor: string | null = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === folderId) return true;
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = byId.get(cursor)?.parent_id ?? null;
  }
  return false;
}

export async function updateFolder(input: {
  projectId: string;
  folderId: string;
  actor: string;
  name?: string;
  parentId?: string | null;
  order?: number;
}): Promise<TomeFolder> {
  const folders = await collection();
  const all = await folders.find({ project_id: input.projectId }).toArray();
  const current = all.find((folder) => folder.id === input.folderId);
  if (!current) throw new FolderValidationError("Folder was not found.", "FOLDER_NOT_FOUND", 404);

  const name = input.name === undefined ? current.name : validateName(input.name);
  const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
  if (parentId && !all.some((folder) => folder.id === parentId)) {
    throw new FolderValidationError("Parent folder was not found.", "FOLDER_PARENT_NOT_FOUND", 404);
  }
  if (folderMoveWouldCycle(current.id, parentId, all)) {
    throw new FolderValidationError(
      "A folder cannot be moved into itself or one of its descendants.",
      "FOLDER_MOVE_CYCLE",
      409,
    );
  }
  await assertUniqueSiblingName(input.projectId, parentId, name, current.id);

  const moving = parentId !== current.parent_id;
  const destinationSiblings = all.filter(
    (folder) => folder.parent_id === parentId && folder.id !== current.id,
  );
  const order = input.order === undefined
    ? moving
      ? Math.max(-1, ...destinationSiblings.map((folder) => folder.order)) + 1
      : current.order
    : input.order;
  if (!Number.isSafeInteger(order) || order < 0) {
    throw new FolderValidationError("Folder order must be a non-negative integer.", "INVALID_FOLDER_ORDER");
  }
  const now = new Date();
  await folders.updateOne(
    { project_id: input.projectId, id: current.id },
    {
      $set: {
        name,
        name_key: nameKey(name),
        parent_id: parentId,
        order,
        updated_at: now,
        updated_by: input.actor,
      },
    },
  );
  return {
    ...current,
    name,
    name_key: nameKey(name),
    parent_id: parentId,
    order,
    updated_at: now,
    updated_by: input.actor,
  };
}

export async function reorderFolder(input: {
  projectId: string;
  folderId: string;
  actor: string;
  direction: "up" | "down";
}): Promise<TomeFolder[]> {
  const folders = await collection();
  const current = await folders.findOne({ project_id: input.projectId, id: input.folderId });
  if (!current) throw new FolderValidationError("Folder was not found.", "FOLDER_NOT_FOUND", 404);

  const siblings = await folders
    .find({ project_id: input.projectId, parent_id: current.parent_id })
    .sort({ order: 1, name: 1, id: 1 })
    .toArray();
  const currentIndex = siblings.findIndex((folder) => folder.id === current.id);
  const targetIndex = input.direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= siblings.length) return siblings;

  [siblings[currentIndex], siblings[targetIndex]] = [siblings[targetIndex], siblings[currentIndex]];
  const now = new Date();
  await folders.bulkWrite(
    siblings.map((folder, order) => ({
      updateOne: {
        filter: { project_id: input.projectId, id: folder.id },
        update: { $set: { order, updated_at: now, updated_by: input.actor } },
      },
    })),
  );
  return siblings.map((folder, order) => ({
    ...folder,
    order,
    updated_at: now,
    updated_by: input.actor,
  }));
}

export async function deleteFolder(
  projectId: string,
  folderId: string,
  pagePaths: readonly string[],
): Promise<TomeFolder> {
  const folders = await collection();
  const folder = await folders.findOne({ project_id: projectId, id: folderId });
  if (!folder) throw new FolderValidationError("Folder was not found.", "FOLDER_NOT_FOUND", 404);
  const child = await folders.findOne({ project_id: projectId, parent_id: folderId });
  const hasPages = Boolean(
    folder.source_path && pagePaths.some((path) => path.startsWith(`${folder.source_path}/`)),
  );
  if (child || hasPages) {
    throw new FolderValidationError(
      "Move or delete this folder’s pages and child folders first.",
      "FOLDER_NOT_EMPTY",
      409,
    );
  }
  await folders.deleteOne({ project_id: projectId, id: folderId });
  return folder;
}
