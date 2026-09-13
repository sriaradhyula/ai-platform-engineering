import { fireEvent, render, screen } from "@testing-library/react";

import { WikiSidebar } from "@/components/tome/WikiSidebar";
import type { PageTreeNode } from "@/types/tome";

const tree: PageTreeNode[] = [
  { path: "alpha.md", title: "Alpha", kind: "stable", order: 0, children: [] },
  { path: "bravo.md", title: "Bravo", kind: "stable", order: 1, children: [] },
];

describe("WikiSidebar drag and drop", () => {
  it("moves a page to the wiki root through its drag handle", () => {
    const onMoveItem = jest.fn();
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: (type: string, value: string) => values.set(type, value),
      getData: (type: string) => values.get(type) ?? "",
    };
    render(
      <WikiSidebar
        tree={tree}
        selectedPath={null}
        onSelect={jest.fn()}
        showHidden={false}
        onMoveItem={onMoveItem}
      />,
    );

    fireEvent.dragStart(screen.getByRole("button", { name: "Move Alpha" }), { dataTransfer });
    const rootTarget = screen.getByText("Drop here to move to wiki root");
    fireEvent.dragOver(rootTarget, { dataTransfer });
    fireEvent.drop(rootTarget, { dataTransfer });

    expect(onMoveItem).toHaveBeenCalledWith(
      { kind: "page", id: "alpha.md" },
      { position: "root" },
    );
  });

  it("offers a contextual new-page action for persisted folders", () => {
    const onCreatePage = jest.fn();
    const folder: PageTreeNode = {
      path: "@folder/folder-1",
      title: "Planning",
      kind: "folder",
      order: 0,
      folderId: "folder-1",
      children: [],
    };
    render(
      <WikiSidebar
        tree={[folder]}
        selectedPath={null}
        onSelect={jest.fn()}
        showHidden={false}
        onCreatePage={onCreatePage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New page in Planning" }));
    expect(onCreatePage).toHaveBeenCalledWith(folder);
    expect(screen.queryByRole("button", { name: "Move Planning up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Planning down" })).not.toBeInTheDocument();
  });
});
