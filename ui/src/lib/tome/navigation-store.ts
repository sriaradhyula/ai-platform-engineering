import {
  getTomeFoldersCollection,
  getTomePagePlacementsCollection,
} from "@/lib/tome/mongo-collections";
import { updateFolder } from "@/lib/tome/folder-store";
import { parseFrontmatter, SPEC_BY_PATH } from "@/lib/tome/schema";
import type { TomeFolder, TomePagePlacement } from "@/types/tome";

let placementIndexesReady: Promise<unknown> | null = null;

export type NavigationItemRef = {
  kind: "page" | "folder";
  id: string;
};

export type NavigationDropTarget =
  | { position: "root" }
  | { position: "inside" | "before" | "after"; item: NavigationItemRef };

export class NavigationValidationError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 400,
  ) {
    super(message);
    this.name = "NavigationValidationError";
  }
}

async function placementsCollection() {
  const placements = await getTomePagePlacementsCollection();
  placementIndexesReady ??= Promise.all([
    placements.createIndex({ project_id: 1, path: 1 }, { unique: true }),
    placements.createIndex({ project_id: 1, folder_id: 1, order: 1 }),
  ]);
  await placementIndexesReady;
  return placements;
}

function sourceDirectory(path: string): string | null {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
}

function initialOrder(path: string, markdown: string): number {
  const [frontmatter] = parseFrontmatter(markdown);
  if (typeof frontmatter.order === "number") return frontmatter.order;
  return SPEC_BY_PATH.get(path)?.order ?? 999;
}

/** Backfills durable placements while preserving placements already chosen by a user. */
export async function ensurePagePlacements(
  projectId: string,
  pages: Readonly<Record<string, string>>,
  folders: readonly TomeFolder[],
  actor: string,
): Promise<void> {
  const placements = await placementsCollection();
  const folderBySource = new Map(
    folders.flatMap((folder) => folder.source_path ? [[folder.source_path, folder.id]] : []),
  );
  const now = new Date();
  const entries = Object.entries(pages);
  const existing = await placements
    .find({ project_id: projectId }, { projection: { path: 1 } })
    .toArray();
  const existingPaths = new Set(existing.map((placement) => placement.path));
  const missing = entries.filter(([path]) => !existingPaths.has(path));
  if (missing.length > 0) {
    await placements.bulkWrite(missing.map(([path, markdown]) => ({
      updateOne: {
        filter: { project_id: projectId, path },
        update: {
          $setOnInsert: {
            project_id: projectId,
            path,
            folder_id: folderBySource.get(sourceDirectory(path) ?? "") ?? null,
            order: initialOrder(path, markdown),
            created_at: now,
            updated_at: now,
            updated_by: actor,
          },
        },
        upsert: true,
      },
    })));
  }
  const pagePaths = new Set(entries.map(([path]) => path));
  if (existing.some((placement) => !pagePaths.has(placement.path))) {
    if (entries.length > 0) {
      await placements.deleteMany({
        project_id: projectId,
        path: { $nin: entries.map(([path]) => path) },
      });
    } else {
      await placements.deleteMany({ project_id: projectId });
    }
  }
}

export async function listPagePlacements(projectId: string): Promise<TomePagePlacement[]> {
  return (await placementsCollection())
    .find({ project_id: projectId })
    .sort({ folder_id: 1, order: 1, path: 1 })
    .toArray();
}

type NavigationRecord = NavigationItemRef & {
  parentId: string | null;
  order: number;
};

function keyOf(item: NavigationItemRef): string {
  return `${item.kind}:${item.id}`;
}

function recordsFor(
  folders: readonly TomeFolder[],
  placements: readonly TomePagePlacement[],
): NavigationRecord[] {
  return [
    ...folders.map((folder) => ({
      kind: "folder" as const,
      id: folder.id,
      parentId: folder.parent_id,
      order: folder.order,
    })),
    ...placements.map((placement) => ({
      kind: "page" as const,
      id: placement.path,
      parentId: placement.folder_id,
      order: placement.order,
    })),
  ];
}

function sortedSiblings(records: readonly NavigationRecord[], parentId: string | null) {
  return records
    .filter((record) => record.parentId === parentId)
    .sort((left, right) => left.order - right.order || keyOf(left).localeCompare(keyOf(right)));
}

/** Move/reorder a page or folder while leaving page paths and Markdown untouched. */
export async function moveNavigationItem(input: {
  projectId: string;
  item: NavigationItemRef;
  target: NavigationDropTarget;
  actor: string;
}): Promise<void> {
  const folderCollection = await getTomeFoldersCollection();
  const placementCollection = await placementsCollection();
  const [folders, placements] = await Promise.all([
    folderCollection.find({ project_id: input.projectId }).toArray(),
    placementCollection.find({ project_id: input.projectId }).toArray(),
  ]);
  const records = recordsFor(folders, placements);
  const source = records.find((record) => keyOf(record) === keyOf(input.item));
  if (!source) {
    throw new NavigationValidationError("Navigation item was not found.", "NAVIGATION_ITEM_NOT_FOUND", 404);
  }

  let destinationParentId: string | null;
  let destination: NavigationRecord[];
  let insertionIndex: number;
  const dropTarget = input.target;
  if (dropTarget.position === "root") {
    destinationParentId = null;
    destination = sortedSiblings(records, null).filter((record) => keyOf(record) !== keyOf(source));
    insertionIndex = destination.length;
  } else {
    const target = records.find((record) => keyOf(record) === keyOf(dropTarget.item));
    if (!target) {
      throw new NavigationValidationError("Drop target was not found.", "NAVIGATION_TARGET_NOT_FOUND", 404);
    }
    if (keyOf(target) === keyOf(source)) return;
    if (dropTarget.position === "inside") {
      if (target.kind !== "folder") {
        throw new NavigationValidationError("Only folders can contain items.", "INVALID_NAVIGATION_TARGET");
      }
      destinationParentId = target.id;
      destination = sortedSiblings(records, target.id).filter((record) => keyOf(record) !== keyOf(source));
      insertionIndex = destination.length;
    } else {
      destinationParentId = target.parentId;
      destination = sortedSiblings(records, target.parentId).filter((record) => keyOf(record) !== keyOf(source));
      const targetIndex = destination.findIndex((record) => keyOf(record) === keyOf(target));
      insertionIndex = targetIndex + (dropTarget.position === "after" ? 1 : 0);
    }
  }

  if (source.kind === "folder") {
    await updateFolder({
      projectId: input.projectId,
      folderId: source.id,
      parentId: destinationParentId,
      actor: input.actor,
    });
  } else {
    await placementCollection.updateOne(
      { project_id: input.projectId, path: source.id },
      { $set: { folder_id: destinationParentId, updated_at: new Date(), updated_by: input.actor } },
    );
  }

  destination.splice(Math.max(0, insertionIndex), 0, {
    ...source,
    parentId: destinationParentId,
  });
  const oldSiblings = source.parentId === destinationParentId
    ? []
    : sortedSiblings(records, source.parentId).filter((record) => keyOf(record) !== keyOf(source));
  const siblingGroups = oldSiblings.length > 0 ? [oldSiblings, destination] : [destination];
  const now = new Date();
  const folderUpdates = siblingGroups.flatMap((group) => group.flatMap(
    (record, order) => record.kind === "folder" ? [{
      updateOne: {
        filter: { project_id: input.projectId, id: record.id },
        update: { $set: { order, updated_at: now, updated_by: input.actor } },
      },
    }] : [],
  ));
  const pageUpdates = siblingGroups.flatMap((group) => group.flatMap(
    (record, order) => record.kind === "page" ? [{
      updateOne: {
        filter: { project_id: input.projectId, path: record.id },
        update: { $set: { order, updated_at: now, updated_by: input.actor } },
      },
    }] : [],
  ));
  await Promise.all([
    folderUpdates.length > 0 ? folderCollection.bulkWrite(folderUpdates) : Promise.resolve(),
    pageUpdates.length > 0 ? placementCollection.bulkWrite(pageUpdates) : Promise.resolve(),
  ]);
}
