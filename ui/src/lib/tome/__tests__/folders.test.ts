jest.mock("@/lib/tome/mongo-collections", () => ({
  getTomeFoldersCollection: jest.fn(),
}));

import { folderMoveWouldCycle } from "@/lib/tome/folder-store";
import { buildTree } from "@/lib/tome/schema";
import type { TomeFolder, TomePagePlacement } from "@/types/tome";

function folder(input: Partial<TomeFolder> & Pick<TomeFolder, "id" | "name">): TomeFolder {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    project_id: "project-primary",
    parent_id: null,
    name_key: input.name.toLocaleLowerCase(),
    source_path: null,
    order: 0,
    owner_subject: "test-user@example.com",
    permission_scope: "project",
    created_at: now,
    updated_at: now,
    updated_by: "test-user@example.com",
    ...input,
  };
}

function placement(
  path: string,
  folderId: string | null,
  order: number,
): TomePagePlacement {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    project_id: "project-primary",
    path,
    folder_id: folderId,
    order,
    created_at: now,
    updated_at: now,
    updated_by: "test-user@example.com",
  };
}

describe("first-class Tome folders", () => {
  it("keeps a stable folder identity while its display name changes", () => {
    const pages = { "guides/start.md": "# Start\n" };
    const tree = buildTree(pages, [
      folder({ id: "folder-guides", name: "Handbook", source_path: "guides" }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      path: "guides",
      title: "Handbook",
      folderId: "folder-guides",
    });
    expect(tree[0].children[0]).toMatchObject({ path: "guides/start.md", title: "Start" });
  });

  it("renders empty folders and persisted hierarchy independently of page paths", () => {
    const tree = buildTree(
      { "guides/start.md": "# Start\n" },
      [
        folder({ id: "folder-planning", name: "Planning" }),
        folder({
          id: "folder-guides",
          name: "Guides",
          source_path: "guides",
          parent_id: "folder-planning",
        }),
        folder({ id: "folder-empty", name: "Empty folder", order: 1 }),
      ],
    );

    expect(tree.map((node) => node.title)).toEqual(["Planning", "Empty folder"]);
    expect(tree[0].children[0]).toMatchObject({ title: "Guides", folderId: "folder-guides" });
    expect(tree[0].children[0].children[0].path).toBe("guides/start.md");
  });

  it("rejects moves into the folder itself or a descendant", () => {
    const folders = [
      folder({ id: "folder-parent", name: "Parent" }),
      folder({ id: "folder-child", name: "Child", parent_id: "folder-parent" }),
      folder({ id: "folder-grandchild", name: "Grandchild", parent_id: "folder-child" }),
    ];

    expect(folderMoveWouldCycle("folder-parent", "folder-parent", folders)).toBe(true);
    expect(folderMoveWouldCycle("folder-parent", "folder-grandchild", folders)).toBe(true);
    expect(folderMoveWouldCycle("folder-child", null, folders)).toBe(false);
  });

  it("places and orders pages independently of their Markdown path", () => {
    const pages = {
      "alpha.md": "# Alpha\n",
      "bravo.md": "# Bravo\n",
    };
    const folders = [folder({ id: "folder-planning", name: "Planning", order: 1 })];
    const tree = buildTree(pages, folders, [
      placement("alpha.md", null, 2),
      placement("bravo.md", "folder-planning", 0),
    ]);

    expect(tree.map((node) => node.title)).toEqual(["Planning", "Alpha"]);
    expect(tree[0].children[0]).toMatchObject({
      path: "bravo.md",
      title: "Bravo",
      parentFolderId: "folder-planning",
    });
  });
});
