const mockFolderFind = jest.fn();
const mockFolderBulkWrite = jest.fn();
const mockPlacementFind = jest.fn();
const mockPlacementUpdateOne = jest.fn();
const mockPlacementBulkWrite = jest.fn();
const mockUpdateFolder = jest.fn();

jest.mock("@/lib/tome/mongo-collections", () => ({
  getTomeFoldersCollection: jest.fn(async () => ({
    find: (...args: unknown[]) => mockFolderFind(...args),
    bulkWrite: (...args: unknown[]) => mockFolderBulkWrite(...args),
  })),
  getTomePagePlacementsCollection: jest.fn(async () => ({
    createIndex: jest.fn().mockResolvedValue("index"),
    find: (...args: unknown[]) => mockPlacementFind(...args),
    updateOne: (...args: unknown[]) => mockPlacementUpdateOne(...args),
    bulkWrite: (...args: unknown[]) => mockPlacementBulkWrite(...args),
  })),
}));
jest.mock("@/lib/tome/folder-store", () => ({
  updateFolder: (...args: unknown[]) => mockUpdateFolder(...args),
}));

import { moveNavigationItem } from "@/lib/tome/navigation-store";

describe("Tome navigation placement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFolderFind.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    mockPlacementUpdateOne.mockResolvedValue({ acknowledged: true });
    mockPlacementBulkWrite.mockResolvedValue({ acknowledged: true });
    mockFolderBulkWrite.mockResolvedValue({ acknowledged: true });
  });

  it("reorders pages relative to another page without changing their paths", async () => {
    mockPlacementFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { project_id: "project-primary", path: "alpha.md", folder_id: null, order: 0 },
        { project_id: "project-primary", path: "bravo.md", folder_id: null, order: 1 },
        { project_id: "project-primary", path: "charlie.md", folder_id: null, order: 2 },
      ]),
    });

    await moveNavigationItem({
      projectId: "project-primary",
      item: { kind: "page", id: "alpha.md" },
      target: { position: "after", item: { kind: "page", id: "bravo.md" } },
      actor: "test-user@example.com",
    });

    expect(mockPlacementUpdateOne).toHaveBeenCalledWith(
      { project_id: "project-primary", path: "alpha.md" },
      { $set: expect.objectContaining({ folder_id: null }) },
    );
    const operations = mockPlacementBulkWrite.mock.calls[0][0] as Array<{
      updateOne: { filter: { path: string }; update: { $set: { order: number } } };
    }>;
    expect(operations.map((operation) => [
      operation.updateOne.filter.path,
      operation.updateOne.update.$set.order,
    ])).toEqual([
      ["bravo.md", 0],
      ["alpha.md", 1],
      ["charlie.md", 2],
    ]);
  });

  it("moves a page inside a folder while retaining its URL path", async () => {
    mockFolderFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { id: "folder-planning", project_id: "project-primary", parent_id: null, order: 0 },
      ]),
    });
    mockPlacementFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { project_id: "project-primary", path: "alpha.md", folder_id: null, order: 1 },
      ]),
    });

    await moveNavigationItem({
      projectId: "project-primary",
      item: { kind: "page", id: "alpha.md" },
      target: { position: "inside", item: { kind: "folder", id: "folder-planning" } },
      actor: "test-user@example.com",
    });

    expect(mockPlacementUpdateOne).toHaveBeenCalledWith(
      { project_id: "project-primary", path: "alpha.md" },
      { $set: expect.objectContaining({ folder_id: "folder-planning" }) },
    );
  });
});
