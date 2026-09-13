/** @jest-environment node */

import { NextRequest } from "next/server";

const mockLoadTomeProject = jest.fn();
const mockRequireTomeEditor = jest.fn();
const mockGuardNotLocked = jest.fn();
const mockCreateFolder = jest.fn();
const mockUpdateFolder = jest.fn();
const mockReorderFolder = jest.fn();
const mockDeleteFolder = jest.fn();
const mockMoveNavigationItem = jest.fn();
const mockListPages = jest.fn();
const mockAuditTome = jest.fn();

jest.mock("@/lib/tome/tome-api", () => ({
  loadTomeProject: (...args: unknown[]) => mockLoadTomeProject(...args),
  requireTomeEditor: (...args: unknown[]) => mockRequireTomeEditor(...args),
  guardNotLocked: (...args: unknown[]) => mockGuardNotLocked(...args),
}));
jest.mock("@/lib/tome/folder-store", () => {
  class FolderValidationError extends Error {
    constructor(
      message: string,
      public code: string,
      public status = 400,
    ) {
      super(message);
    }
  }
  return {
    FolderValidationError,
    createFolder: (...args: unknown[]) => mockCreateFolder(...args),
    updateFolder: (...args: unknown[]) => mockUpdateFolder(...args),
    reorderFolder: (...args: unknown[]) => mockReorderFolder(...args),
    deleteFolder: (...args: unknown[]) => mockDeleteFolder(...args),
    ensureFoldersForPages: jest.fn(),
    listFolders: jest.fn().mockResolvedValue([]),
  };
});
jest.mock("@/lib/tome/page-store", () => ({
  getPageStore: jest.fn(async () => ({ listPages: mockListPages })),
}));
jest.mock("@/lib/tome/navigation-store", () => {
  class NavigationValidationError extends Error {
    constructor(
      message: string,
      public code: string,
      public status = 400,
    ) {
      super(message);
    }
  }
  return {
    NavigationValidationError,
    ensurePagePlacements: jest.fn(),
    moveNavigationItem: (...args: unknown[]) => mockMoveNavigationItem(...args),
  };
});
jest.mock("@/lib/tome/audit", () => ({
  auditTome: (...args: unknown[]) => mockAuditTome(...args),
  tomeActorFromAuth: jest.fn().mockReturnValue({ type: "user", id: "test-user" }),
}));

import { POST } from "../route";
import { DELETE, PATCH } from "../[folderId]/route";
import { PATCH as PATCH_NAVIGATION } from "../../navigation/route";

const collectionContext = { params: Promise.resolve({ slug: "example-project" }) };
const itemContext = {
  params: Promise.resolve({ slug: "example-project", folderId: "folder-primary" }),
};
const projectContext = {
  projectId: "project-primary",
  project: { locked: false },
  canEdit: true,
  user: { email: "test-user@example.com" },
  session: { sub: "test-user" },
};

describe("Tome folder APIs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadTomeProject.mockResolvedValue(projectContext);
    mockListPages.mockResolvedValue({ "guides/start.md": "# Start\n" });
  });

  it("creates a folder under an authorized project parent", async () => {
    mockCreateFolder.mockResolvedValue({
      id: "folder-new",
      name: "Planning",
      parent_id: "folder-primary",
    });
    const response = await POST(
      new NextRequest("http://example.test/api/tome/projects/example-project/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Planning", parent_id: "folder-primary" }),
      }),
      collectionContext,
    );

    expect(response.status).toBe(201);
    expect(mockRequireTomeEditor).toHaveBeenCalledWith(projectContext);
    expect(mockGuardNotLocked).toHaveBeenCalledWith("project-primary", false);
    expect(mockCreateFolder).toHaveBeenCalledWith({
      projectId: "project-primary",
      parentId: "folder-primary",
      name: "Planning",
      actor: "test-user@example.com",
    });
    expect(mockAuditTome).toHaveBeenCalledWith(expect.objectContaining({
      action: "tome.folder.create",
      projectSlug: "example-project",
    }));
  });

  it("returns a conflict for an invalid folder move", async () => {
    const FolderValidationError = jest.requireMock("@/lib/tome/folder-store")
      .FolderValidationError as new (message: string, code: string, status: number) => Error;
    mockUpdateFolder.mockRejectedValue(
      new FolderValidationError("Folder cycle", "FOLDER_MOVE_CYCLE", 409),
    );
    const response = await PATCH(
      new NextRequest("http://example.test/api/tome/projects/example-project/folders/folder-primary", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_id: "folder-child" }),
      }),
      itemContext,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "FOLDER_MOVE_CYCLE" });
    expect(mockAuditTome).not.toHaveBeenCalled();
  });

  it("reorders siblings through the explicit direction action", async () => {
    mockReorderFolder.mockResolvedValue([]);
    const response = await PATCH(
      new NextRequest("http://example.test/api/tome/projects/example-project/folders/folder-primary", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "down" }),
      }),
      itemContext,
    );

    expect(response.status).toBe(200);
    expect(mockReorderFolder).toHaveBeenCalledWith({
      projectId: "project-primary",
      folderId: "folder-primary",
      actor: "test-user@example.com",
      direction: "down",
    });
  });

  it("only deletes a folder after checking the current page set", async () => {
    mockDeleteFolder.mockResolvedValue({
      id: "folder-primary",
      name: "Planning",
      parent_id: null,
    });
    const response = await DELETE(
      new NextRequest("http://example.test/api/tome/projects/example-project/folders/folder-primary", {
        method: "DELETE",
      }),
      itemContext,
    );

    expect(response.status).toBe(200);
    expect(mockDeleteFolder).toHaveBeenCalledWith(
      "project-primary",
      "folder-primary",
      ["guides/start.md"],
    );
    expect(mockAuditTome).toHaveBeenCalledWith(expect.objectContaining({
      action: "tome.folder.delete",
    }));
  });

  it("moves a page through the navigation endpoint without changing its path", async () => {
    mockMoveNavigationItem.mockResolvedValue(undefined);
    const response = await PATCH_NAVIGATION(
      new NextRequest("http://example.test/api/tome/projects/example-project/navigation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: { kind: "page", id: "guides/start.md" },
          target: {
            position: "inside",
            item: { kind: "folder", id: "folder-primary" },
          },
        }),
      }),
      collectionContext,
    );

    expect(response.status).toBe(200);
    expect(mockMoveNavigationItem).toHaveBeenCalledWith({
      projectId: "project-primary",
      item: { kind: "page", id: "guides/start.md" },
      target: {
        position: "inside",
        item: { kind: "folder", id: "folder-primary" },
      },
      actor: "test-user@example.com",
    });
    expect(mockAuditTome).toHaveBeenCalledWith(expect.objectContaining({
      action: "tome.navigation.move",
      page: "guides/start.md",
    }));
  });
});
