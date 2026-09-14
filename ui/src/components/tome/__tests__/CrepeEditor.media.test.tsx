import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";

import { CrepeEditor, type CrepeEditorHandle } from "../CrepeEditor";

const mockToast = jest.fn();
const mockCreate = jest.fn().mockResolvedValue(undefined);
const mockDestroy = jest.fn();
const mockSetReadonly = jest.fn();
const mockEditorConfig = jest.fn();
const mockEditorAction = jest.fn();
const mockEditorUse = jest.fn();
const mockGetMarkdown = jest.fn(() => "# Example");
const mockCrepeConstructor = jest.fn();
const mockInsert = jest.fn((markdown: string) => ({ command: "insert", markdown }));
const mockMarkdownToSlice = jest.fn((markdown: string) => () => ({ markdown }));
const mockUndo = jest.fn();
const mockRedo = jest.fn();

type TestTopBarItem = {
  active: () => boolean;
  icon: string;
  onRun: (ctx: { get: (key: string) => unknown }) => void;
};

type TestTopBarGroup = {
  addItem: (key: string, item: TestTopBarItem) => TestTopBarGroup;
};

type CrepeOptions = {
  featureConfigs: Record<
    string,
    {
      buildTopBar?: (builder: {
        getGroup: (key: string) => TestTopBarGroup;
        addGroup: (key: string, label: string) => TestTopBarGroup;
      }) => void;
      buildToolbar?: (builder: {
        addGroup: (key: string, label: string) => TestTopBarGroup;
      }) => void;
      renderPreview?: unknown;
      previewLoading?: string;
      onUpload?: (file: File) => Promise<string>;
      bulletListIcon?: string;
    }
  >;
};

jest.mock("@milkdown/crepe", () => {
  class MockCrepe {
    static Feature = {
      CodeMirror: "code-mirror",
      ImageBlock: "image-block",
      TopBar: "top-bar",
      Toolbar: "toolbar",
    };

    on = jest.fn();

    editor = {
      config: mockEditorConfig,
      action: mockEditorAction,
      use: mockEditorUse,
    };

    constructor(options: CrepeOptions) {
      mockCrepeConstructor(options);
    }

    create = mockCreate;
    destroy = mockDestroy;
    setReadonly = mockSetReadonly;
    getMarkdown = mockGetMarkdown;
  }

  return { Crepe: MockCrepe };
});

jest.mock(
  "@milkdown/kit/prose/model",
  () => ({
    Fragment: { fromArray: jest.fn((nodes: unknown[]) => ({ nodes })) },
  }),
  { virtual: true },
);
jest.mock(
  "@milkdown/kit/preset/commonmark",
  () => ({
    hardbreakSchema: { key: "hardbreak-schema" },
    htmlAttr: { key: "html-attr" },
    htmlSchema: { key: "html-schema" },
    linkAttr: { key: "link-attr" },
  }),
  { virtual: true },
);
jest.mock(
  "@milkdown/kit/core",
  () => ({
    editorViewCtx: "editor-view-ctx",
    remarkPluginsCtx: "remark-plugins-ctx",
  }),
  { virtual: true },
);
jest.mock(
  "@milkdown/kit/component/image-block",
  () => ({ imageBlockSchema: { key: "image-block-schema" } }),
  { virtual: true },
);
jest.mock(
  "@milkdown/kit/prose/history",
  () => ({
    undo: (...args: unknown[]) => mockUndo(...args),
    redo: (...args: unknown[]) => mockRedo(...args),
  }),
  { virtual: true },
);
jest.mock(
  "@milkdown/kit/prose/state",
  () => ({
    Plugin: class MockPlugin {
      constructor(public spec: Record<string, unknown>) {}
    },
    PluginKey: class MockPluginKey {
      getState(state: { pendingAiSelection?: { from: number; to: number } | null }) {
        return state.pendingAiSelection ?? null;
      }
    },
    TextSelection: {
      create: jest.fn((_doc: unknown, from: number, to: number) => ({ from, to })),
      near: jest.fn((_position: unknown) => ({ cursor: true })),
    },
  }),
  { virtual: true },
);
jest.mock(
  "@milkdown/kit/prose/view",
  () => ({
    Decoration: { inline: jest.fn(), node: jest.fn() },
    DecorationSet: { create: jest.fn() },
  }),
  { virtual: true },
);
jest.mock(
  "@milkdown/utils",
  () => ({
    $prose: jest.fn((factory: () => unknown) => ({
      factory,
      plugin: "prose-plugin",
    })),
    insert: (markdown: string) => mockInsert(markdown),
    markdownToSlice: (markdown: string) => mockMarkdownToSlice(markdown),
    replaceAll: jest.fn(),
  }),
  { virtual: true },
);
jest.mock("@/lib/tome/citations", () => ({ classifyCitationHref: jest.fn() }));
jest.mock("@/components/shared/timeline/MarkdownRenderer", () => ({
  renderInlineMarkdown: jest.fn((value: string) => value),
}));
jest.mock("@/components/ui/copy-button", () => ({ copyTextToClipboard: jest.fn() }));
jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

describe("CrepeEditor media configuration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEditorAction.mockReset();
    mockCreate.mockResolvedValue(undefined);
    mockUndo.mockReset();
    mockRedo.mockReset();
  });

  it("wires Mermaid previews and persistent image uploads into Crepe", async () => {
    const { unmount } = render(
      <CrepeEditor initialMarkdown="# Example" readonly />,
    );

    await waitFor(() => expect(mockCrepeConstructor).toHaveBeenCalledTimes(1));
    const options = mockCrepeConstructor.mock.calls[0][0] as CrepeOptions;
    const codeMirror = options.featureConfigs["code-mirror"];
    const imageBlock = options.featureConfigs["image-block"];

    expect(codeMirror.renderPreview).toEqual(expect.any(Function));
    expect(codeMirror.previewLoading).toBe("Rendering Mermaid diagram…");
    expect(imageBlock.onUpload).toEqual(expect.any(Function));

    const file = new File(["image bytes"], "example.png", { type: "image/png" });
    await expect(imageBlock.onUpload?.(file)).resolves.toBe(
      "data:image/png;base64,aW1hZ2UgYnl0ZXM=",
    );
    expect(mockToast).not.toHaveBeenCalled();

    unmount();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("surfaces image validation failures through the editor toast", async () => {
    render(<CrepeEditor initialMarkdown="# Example" />);

    await waitFor(() => expect(mockCrepeConstructor).toHaveBeenCalledTimes(1));
    const options = mockCrepeConstructor.mock.calls[0][0] as CrepeOptions;
    const upload = options.featureConfigs["image-block"].onUpload;
    const file = new File(["not an image"], "example.txt", { type: "text/plain" });

    await expect(upload?.(file)).rejects.toThrow("Only image files");
    expect(mockToast).toHaveBeenCalledWith(
      "Only image files can be embedded.",
      "error",
    );
  });

  it("adds Media to Crepe's top toolbar and opens the host picker", async () => {
    const onInsertMedia = jest.fn();
    render(<CrepeEditor initialMarkdown="# Example" onInsertMedia={onInsertMedia} />);

    await waitFor(() => expect(mockCrepeConstructor).toHaveBeenCalledTimes(1));
    const options = mockCrepeConstructor.mock.calls[0][0] as CrepeOptions;
    const insertGroup = { addItem: jest.fn() } as unknown as TestTopBarGroup;
    (insertGroup.addItem as jest.Mock).mockReturnValue(insertGroup);
    const historyGroup = { addItem: jest.fn() } as unknown as TestTopBarGroup;
    (historyGroup.addItem as jest.Mock).mockReturnValue(historyGroup);
    options.featureConfigs["top-bar"].buildTopBar?.({
      getGroup: (key) => {
        expect(key).toBe("insert");
        return insertGroup;
      },
      addGroup: (key, label) => {
        expect([key, label]).toEqual(["history", "History"]);
        return historyGroup;
      },
    });

    expect(insertGroup.addItem).toHaveBeenCalledWith(
      "tome-media",
      expect.objectContaining({ icon: expect.stringContaining("data-tome-media-icon") }),
    );
    const item = (insertGroup.addItem as jest.Mock).mock.calls[0][1] as {
      onRun: () => void;
    };
    expect((insertGroup.addItem as jest.Mock).mock.calls[0][1].icon).toContain(
      'data-tome-media-play="true"',
    );
    item.onRun();
    expect(onInsertMedia).toHaveBeenCalledTimes(1);
  });

  it("inserts a portable two- or three-column section", async () => {
    render(<CrepeEditor initialMarkdown="# Example" enableColumns />);

    await waitFor(() => expect(mockSetReadonly).toHaveBeenCalled());
    const options = mockCrepeConstructor.mock.calls[0][0] as CrepeOptions;
    const insertGroup = { addItem: jest.fn() } as unknown as TestTopBarGroup;
    (insertGroup.addItem as jest.Mock).mockReturnValue(insertGroup);
    const historyGroup = { addItem: jest.fn() } as unknown as TestTopBarGroup;
    (historyGroup.addItem as jest.Mock).mockReturnValue(historyGroup);
    options.featureConfigs["top-bar"].buildTopBar?.({
      getGroup: () => insertGroup,
      addGroup: () => historyGroup,
    });

    const columnsCall = (insertGroup.addItem as jest.Mock).mock.calls.find(
      ([key]) => key === "tome-columns",
    );
    expect(columnsCall?.[1].icon).toContain("data-tome-columns-icon");
    act(() => columnsCall?.[1].onRun());

    fireEvent.click(await screen.findByRole("button", { name: "3 columns" }));
    const markdown = mockInsert.mock.calls.at(-1)?.[0] as string;
    expect(markdown.match(/> \[!column\]/g)).toHaveLength(3);
    expect(markdown).toContain("> ### Column 3");
    expect(mockEditorAction).toHaveBeenCalledWith({ command: "insert", markdown });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("repairs preserved empty lines between editable columns", async () => {
    render(<CrepeEditor initialMarkdown="# Example" enableColumns />);
    await waitFor(() => expect(mockEditorUse).toHaveBeenCalled());

    const marker = {
      nodeSize: 2,
      textContent: "[!column]",
      type: { name: "paragraph" },
    };
    const appendedContent = { childCount: 4 };
    const firstColumn = {
      content: { append: jest.fn(() => appendedContent) },
      copy: jest.fn(() => ({ repaired: true })),
      firstChild: marker,
      nodeSize: 10,
      textContent: "[!column]Column 1",
      type: { name: "blockquote" },
    };
    const separator = {
      content: { append: jest.fn() },
      firstChild: null,
      nodeSize: 2,
      textContent: "<br />",
      type: { name: "paragraph" },
    };
    const secondColumn = {
      content: { append: jest.fn() },
      firstChild: marker,
      nodeSize: 10,
      textContent: "[!column]Column 2",
      type: { name: "blockquote" },
    };
    const trailingSeparator = {
      ...separator,
      content: { append: jest.fn() },
    };
    const nodes = [firstColumn, separator, secondColumn, trailingSeparator];
    const positions = [0, 10, 12, 22];
    const transaction = {
      docChanged: false,
      replaceWith: jest.fn(function replaceWith() {
        this.docChanged = true;
        return this;
      }),
    };
    const state = {
      doc: {
        forEach: (callback: (node: unknown, position: number) => void) =>
          nodes.forEach((node, index) => callback(node, positions[index])),
      },
      tr: transaction,
    };
    const plugin = mockEditorUse.mock.calls
      .map(([extension]) => extension as { factory?: () => unknown })
      .filter((extension) => extension.factory)
      .map((extension) => extension.factory?.() as { spec?: Record<string, unknown> })
      .find((candidate) => candidate.spec?.appendTransaction);
    const appendTransaction = plugin?.spec?.appendTransaction as (
      transactions: Array<{ docChanged: boolean }>,
      oldState: unknown,
      nextState: typeof state,
    ) => typeof transaction | null;

    const result = appendTransaction([{ docChanged: true }], null, state);

    expect(firstColumn.content.append).toHaveBeenCalled();
    expect(firstColumn.copy).toHaveBeenCalledWith(appendedContent);
    expect(transaction.replaceWith).toHaveBeenCalledWith(0, 12, { repaired: true });
    expect(result).toBe(transaction);
  });

  it("adds toolbar controls that execute undo and redo history", async () => {
    render(<CrepeEditor initialMarkdown="# Example" />);

    await waitFor(() => expect(mockCrepeConstructor).toHaveBeenCalledTimes(1));
    const options = mockCrepeConstructor.mock.calls[0][0] as CrepeOptions;
    const insertGroup = { addItem: jest.fn() } as unknown as TestTopBarGroup;
    (insertGroup.addItem as jest.Mock).mockReturnValue(insertGroup);
    const historyGroup = { addItem: jest.fn() } as unknown as TestTopBarGroup;
    (historyGroup.addItem as jest.Mock).mockReturnValue(historyGroup);
    options.featureConfigs["top-bar"].buildTopBar?.({
      getGroup: () => insertGroup,
      addGroup: () => historyGroup,
    });

    const undoItem = (historyGroup.addItem as jest.Mock).mock.calls[0][1] as TestTopBarItem;
    const redoItem = (historyGroup.addItem as jest.Mock).mock.calls[1][1] as TestTopBarItem;
    expect((historyGroup.addItem as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
      "tome-undo",
      "tome-redo",
    ]);
    expect(undoItem.icon).toContain("data-tome-undo-icon");
    expect(redoItem.icon).toContain("data-tome-redo-icon");

    const view = { state: { doc: "current" }, dispatch: jest.fn(), focus: jest.fn() };
    const undoTransaction = { type: "undo" };
    const redoTransaction = { type: "redo" };
    mockUndo.mockImplementation((_state, dispatch) => {
      dispatch(undoTransaction);
      return true;
    });
    mockRedo.mockImplementation((_state, dispatch) => {
      dispatch(redoTransaction);
      return true;
    });
    const ctx = { get: () => view };

    undoItem.onRun(ctx);
    redoItem.onRun(ctx);

    expect(view.dispatch).toHaveBeenNthCalledWith(1, undoTransaction);
    expect(view.dispatch).toHaveBeenNthCalledWith(2, redoTransaction);
    expect(view.focus).toHaveBeenCalledTimes(2);
  });

  it("marks the bullet toolbar control for portable table-cell bullets", async () => {
    render(<CrepeEditor initialMarkdown="# Example" />);

    await waitFor(() => expect(mockCrepeConstructor).toHaveBeenCalledTimes(1));
    const options = mockCrepeConstructor.mock.calls[0][0] as CrepeOptions;

    expect(options.featureConfigs["top-bar"].bulletListIcon).toContain(
      'data-tome-bullet-list-icon="true"',
    );
  });

  it("adds Enhance with AI to the text-selection toolbar", async () => {
    const onEnhanceSelection = jest.fn();
    render(
      <CrepeEditor
        initialMarkdown="# Example"
        onEnhanceSelection={onEnhanceSelection}
      />,
    );

    await waitFor(() => expect(mockCrepeConstructor).toHaveBeenCalledTimes(1));
    const options = mockCrepeConstructor.mock.calls[0][0] as CrepeOptions;
    const aiGroup = { addItem: jest.fn() } as unknown as TestTopBarGroup;
    (aiGroup.addItem as jest.Mock).mockReturnValue(aiGroup);
    options.featureConfigs.toolbar.buildToolbar?.({
      addGroup: (key, label) => {
        expect([key, label]).toEqual(["tome-ai", "AI"]);
        return aiGroup;
      },
    });

    expect(aiGroup.addItem).toHaveBeenCalledWith(
      "tome-enhance-ai",
      expect.objectContaining({
        label: "Enhance with AI",
        icon: expect.stringContaining("data-tome-ai-icon"),
      }),
    );
    const transaction = { setMeta: jest.fn() };
    transaction.setMeta.mockReturnValue(transaction);
    const view = {
      state: { selection: { from: 3, to: 12 }, tr: transaction },
      dispatch: jest.fn(),
    };
    const item = (aiGroup.addItem as jest.Mock).mock.calls[0][1] as TestTopBarItem;
    item.onRun({ get: () => view });
    expect(transaction.setMeta).toHaveBeenCalledWith(
      expect.anything(),
      { from: 3, to: 12 },
    );
    expect(view.dispatch).toHaveBeenCalledWith(transaction);
    expect(onEnhanceSelection).toHaveBeenCalledTimes(1);
  });

  it("reads and restores the retained AI selection after focus leaves the editor", async () => {
    const transaction = {
      setSelection: jest.fn(),
      setMeta: jest.fn(),
    };
    transaction.setSelection.mockReturnValue(transaction);
    transaction.setMeta.mockReturnValue(transaction);
    const view = {
      state: {
        pendingAiSelection: { from: 3, to: 12 },
        selection: { from: 12, to: 12 },
        doc: {
          content: { size: 20 },
          textBetween: jest.fn(() => "Selected text"),
        },
        tr: transaction,
      },
      dispatch: jest.fn(),
      focus: jest.fn(),
    };
    mockEditorAction.mockImplementation((action: unknown) => {
      if (typeof action === "function") {
        (action as (ctx: { get: () => unknown }) => void)({ get: () => view });
      }
    });
    const editorRef = createRef<CrepeEditorHandle>();

    render(<CrepeEditor ref={editorRef} initialMarkdown="# Example" />);
    await waitFor(() => expect(mockSetReadonly).toHaveBeenCalled());

    expect(editorRef.current?.getSelectedText()).toBe("Selected text");
    expect(view.state.doc.textBetween).toHaveBeenCalledWith(3, 12, "\n");

    editorRef.current?.restoreSelection();
    expect(transaction.setSelection).toHaveBeenCalledWith({ from: 3, to: 12 });
    expect(transaction.setMeta).toHaveBeenCalledWith(expect.anything(), null);
    expect(view.dispatch).toHaveBeenCalledWith(transaction);
    expect(view.focus).toHaveBeenCalledTimes(1);
  });

  it("atomically replaces the retained range and collapses the AI selection", async () => {
    const transaction = {
      replace: jest.fn(),
      setSelection: jest.fn(),
      setMeta: jest.fn(),
      scrollIntoView: jest.fn(),
      mapping: { map: jest.fn(() => 11) },
      doc: {
        content: { size: 20 },
        resolve: jest.fn(() => ({ position: 11 })),
      },
    };
    transaction.replace.mockReturnValue(transaction);
    transaction.setSelection.mockReturnValue(transaction);
    transaction.setMeta.mockReturnValue(transaction);
    transaction.scrollIntoView.mockReturnValue(transaction);
    const view = {
      state: {
        pendingAiSelection: { from: 4, to: 10 },
        selection: { from: 10, to: 10 },
        doc: { content: { size: 20 } },
        tr: transaction,
      },
      dispatch: jest.fn(),
      focus: jest.fn(),
    };
    mockEditorAction.mockImplementation((action: unknown) => {
      if (typeof action === "function") {
        (action as (ctx: { get: () => unknown }) => void)({ get: () => view });
      }
    });
    const editorRef = createRef<CrepeEditorHandle>();

    render(<CrepeEditor ref={editorRef} initialMarkdown="# Example" />);
    await waitFor(() => expect(mockSetReadonly).toHaveBeenCalled());
    editorRef.current?.replaceSelection("Improved text");

    expect(mockMarkdownToSlice).toHaveBeenCalledWith("Improved text");
    expect(transaction.replace).toHaveBeenCalledWith(4, 10, {
      markdown: "Improved text",
    });
    expect(transaction.setSelection).toHaveBeenCalledWith({ cursor: true });
    expect(transaction.setMeta).toHaveBeenCalledWith(expect.anything(), null);
    expect(transaction.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(view.dispatch).toHaveBeenCalledWith(transaction);
    expect(view.focus).toHaveBeenCalledTimes(1);
  });

  it("converts a standalone supported URL pasted into Crepe", async () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    host.append(editor);

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: () => "https://www.youtube.com/watch?v=Od6M0AXpcxQ",
      },
    });

    const markdown = "\n\n```youtube\nurl: https://www.youtube.com/watch?v=Od6M0AXpcxQ\n```\n\n";
    expect(mockInsert).toHaveBeenCalledWith(markdown);
    expect(mockEditorAction).toHaveBeenCalledWith({ command: "insert", markdown });
    expect(mockToast).toHaveBeenCalledWith(
      "YouTube link converted to an embed",
      "success",
    );
  });

  it("leaves an ordinary pasted link to Crepe's default behavior", async () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    host.append(editor);

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: () => "https://example.com/article",
      },
    });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockEditorAction).not.toHaveBeenCalled();
  });

  it("preserves multiline plain text and Markdown bullets pasted into one table cell", async () => {
    const hardbreakNode = { name: "hardbreak-node" };
    const transaction = {
      deleteSelection: jest.fn(),
      replaceSelectionWith: jest.fn(),
      insertText: jest.fn(),
      scrollIntoView: jest.fn(),
    };
    transaction.deleteSelection.mockReturnValue(transaction);
    transaction.replaceSelectionWith.mockReturnValue(transaction);
    transaction.insertText.mockReturnValue(transaction);
    transaction.scrollIntoView.mockReturnValue(transaction);
    const view = {
      state: {
        selection: {
          $from: {
            depth: 2,
            node: (depth: number) => ({
              type: { name: depth === 1 ? "table_cell" : "paragraph" },
            }),
          },
        },
        schema: { nodes: { hardbreak: { create: jest.fn(() => hardbreakNode) } } },
        tr: transaction,
      },
      dispatch: jest.fn(),
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    await waitFor(() => expect(mockSetReadonly).toHaveBeenCalled());
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = '<div class="ProseMirror"><table><tbody><tr><td>Cell</td></tr></tbody></table></div>';
    const cell = host.querySelector("td") as HTMLTableCellElement;

    fireEvent.paste(cell, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "First\n- Second" : ""),
      },
    });

    expect(transaction.deleteSelection).toHaveBeenCalled();
    expect(transaction.replaceSelectionWith).toHaveBeenCalledWith(hardbreakNode);
    expect(transaction.insertText).toHaveBeenNthCalledWith(1, "First");
    expect(transaction.insertText).toHaveBeenNthCalledWith(2, "• Second");
    expect(view.dispatch).toHaveBeenCalledWith(transaction);
  });

  it("uses Shift+Enter for a lossless table-cell newline and continues a cell bullet", async () => {
    const hardbreakNode = { name: "hardbreak-node" };
    const transaction = {
      replaceSelectionWith: jest.fn(),
      insertText: jest.fn(),
      scrollIntoView: jest.fn(),
    };
    transaction.replaceSelectionWith.mockReturnValue(transaction);
    transaction.insertText.mockReturnValue(transaction);
    transaction.scrollIntoView.mockReturnValue(transaction);
    const view = {
      state: {
        selection: {
          $from: {
            depth: 2,
            parent: { textContent: "• First" },
            node: (depth: number) => ({
              type: { name: depth === 1 ? "table_cell" : "paragraph" },
            }),
          },
        },
        schema: { nodes: { hardbreak: { create: jest.fn(() => hardbreakNode) } } },
        tr: transaction,
      },
      dispatch: jest.fn(),
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    await waitFor(() => expect(mockSetReadonly).toHaveBeenCalled());
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = '<div class="ProseMirror"><table><tbody><tr><td>• First</td></tr></tbody></table></div>';
    const editor = host.querySelector(".ProseMirror") as HTMLDivElement;

    // ProseMirror dispatches keyboard events from its contenteditable root;
    // the document selection, not the DOM event target, identifies the cell.
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(transaction.replaceSelectionWith).toHaveBeenCalledWith(hardbreakNode);
    expect(transaction.insertText).toHaveBeenCalledWith("• ");
    expect(view.dispatch).toHaveBeenCalledWith(transaction);
  });

  it("renders portable HTML table breaks as native rich-editor line breaks", async () => {
    render(<CrepeEditor initialMarkdown="# Example" />);

    await waitFor(() => expect(mockEditorConfig).toHaveBeenCalledTimes(1));
    const configure = mockEditorConfig.mock.calls[0][0] as (ctx: {
      get: (key: string) => unknown;
      set: (key: string, value: unknown) => void;
    }) => void;
    const defaultToDOM = jest.fn(() => ["span", { "data-type": "html" }, "<mark>"]);
    const values = new Map<string, unknown>([
      ["remark-plugins-ctx", []],
      ["link-attr", jest.fn(() => ({}))],
      ["html-attr", jest.fn(() => ({ class: "portable-html" }))],
      [
        "image-block-schema",
        jest.fn(() => ({
          attrs: {
            src: { default: "" },
            caption: { default: "" },
            ratio: { default: 1 },
          },
        })),
      ],
      [
        "hardbreak-schema",
        jest.fn(() => ({
          toMarkdown: {
            match: jest.fn(),
            runner: jest.fn(),
          },
        })),
      ],
      [
        "html-schema",
        jest.fn(() => ({
          parseDOM: [{ tag: 'span[data-type="html"]' }],
          toDOM: defaultToDOM,
        })),
      ],
    ]);
    const ctx = {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    };

    configure(ctx);
    const remarkPlugins = values.get("remark-plugins-ctx") as Array<{
      plugin: () => (tree: unknown) => void;
    }>;
    const tree = {
      type: "root",
      children: [
        {
          type: "tableCell",
          children: [
            { type: "text", value: "• one" },
            { type: "html", value: "<br>" },
            { type: "text", value: "• two" },
          ],
        },
        { type: "paragraph", children: [{ type: "html", value: "<br>" }] },
      ],
    };
    remarkPlugins[0].plugin()(tree);
    expect(tree.children[0].children).toEqual([
      { type: "text", value: "• one" },
      { type: "break" },
      { type: "text", value: "• two" },
    ]);
    expect(tree.children[1].children).toEqual([{ type: "html", value: "<br>" }]);

    const schemaFactory = values.get("html-schema") as (schemaCtx: typeof ctx) => {
      parseDOM: Array<{ tag: string }>;
      toDOM: (node: { attrs: { value: string } }) => unknown[];
    };
    const schema = schemaFactory(ctx);

    expect(schema.toDOM({ attrs: { value: "<br>" } })).toEqual([
      "br",
      {
        class: "portable-html",
        "data-type": "html",
        "data-value": "<br>",
      },
    ]);
    expect(schema.parseDOM[0].tag).toBe('br[data-type="html"]');

    expect(schema.toDOM({ attrs: { value: "<mark>" } })).toEqual([
      "span",
      { "data-type": "html" },
      "<mark>",
    ]);
    expect(defaultToDOM).toHaveBeenCalledTimes(1);

    const hardbreakSchemaFactory = values.get("hardbreak-schema") as (
      schemaCtx: typeof ctx,
    ) => {
      toMarkdown: {
        runner: (state: { addNode: jest.Mock }) => void;
      };
    };
    const addNode = jest.fn();
    hardbreakSchemaFactory(ctx).toMarkdown.runner({ addNode });
    expect(addNode).toHaveBeenCalledWith("html", undefined, "<br>");

    const imageSchemaFactory = values.get("image-block-schema") as (
      schemaCtx: typeof ctx,
    ) => {
      attrs: Record<string, unknown>;
      parseMarkdown: {
        runner: (
          state: { addNode: jest.Mock },
          node: { alt?: string; title?: string; url?: string },
          type: string,
        ) => void;
      };
      toMarkdown: {
        runner: (
          state: { openNode: jest.Mock; addNode: jest.Mock; closeNode: jest.Mock },
          node: {
            attrs: Record<string, unknown>;
            type: { name: string };
          },
        ) => void;
      };
    };
    const imageSchema = imageSchemaFactory(ctx);
    expect(imageSchema.attrs.alignment).toEqual({
      default: "center",
      validate: "string",
    });
    const imageParseState = { addNode: jest.fn() };
    imageSchema.parseMarkdown.runner(
      imageParseState,
      {
        alt: "0.65|right",
        title: "Example image",
        url: "https://example.com/example.png",
      },
      "image-block",
    );
    expect(imageParseState.addNode).toHaveBeenCalledWith("image-block", {
      alignment: "right",
      caption: "Example image",
      ratio: 0.65,
      src: "https://example.com/example.png",
    });
    const imageSerializeState = {
      addNode: jest.fn(),
      closeNode: jest.fn(),
      openNode: jest.fn(),
    };
    imageSchema.toMarkdown.runner(imageSerializeState, {
      attrs: {
        alignment: "left",
        caption: "Example image",
        ratio: 0.65,
        src: "https://example.com/example.png",
      },
      type: { name: "image-block" },
    });
    expect(imageSerializeState.addNode).toHaveBeenCalledWith(
      "image",
      undefined,
      undefined,
      {
        alt: "0.65|left",
        title: "Example image",
        url: "https://example.com/example.png",
      },
    );
  });

  it("serializes language display names as portable Markdown fence identifiers", () => {
    mockGetMarkdown.mockReturnValueOnce(
      ["```C++", "int main() { return 0; }", "```"].join("\n"),
    );
    const editorRef = createRef<CrepeEditorHandle>();

    render(<CrepeEditor ref={editorRef} initialMarkdown="" />);

    expect(editorRef.current?.getMarkdown()).toBe(
      ["```cpp", "int main() { return 0; }", "```"].join("\n"),
    );
  });

  it("uses the existing bullet toolbar control for an inline table-cell bullet", async () => {
    const transaction = {
      insertText: jest.fn(),
      scrollIntoView: jest.fn(),
    };
    transaction.insertText.mockReturnValue(transaction);
    transaction.scrollIntoView.mockReturnValue(transaction);
    const view = {
      state: {
        selection: {
          from: 3,
          $from: {
            depth: 2,
            node: (depth: number) => ({
              type: { name: depth === 1 ? "table_cell" : "paragraph" },
            }),
          },
        },
        tr: transaction,
      },
      dispatch: jest.fn(),
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    await waitFor(() => expect(mockSetReadonly).toHaveBeenCalled());
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = '<button data-tome-bullet-list-button="true"><svg data-tome-bullet-list-icon="true"></svg></button>';
    const button = host.querySelector("button") as HTMLButtonElement;

    expect(fireEvent.pointerDown(button)).toBe(false);

    expect(transaction.insertText).toHaveBeenCalledWith("• ", 3);
    expect(view.dispatch).toHaveBeenCalledWith(transaction);
  });

  it("applies portable bullets to every selected line in a table cell", async () => {
    const paragraph = {
      content: { size: 15 },
      forEach: (callback: (node: { type: { name: string }; nodeSize: number }, offset: number) => void) => {
        callback({ type: { name: "text" }, nodeSize: 3 }, 0);
        callback({ type: { name: "hardbreak" }, nodeSize: 1 }, 3);
        callback({ type: { name: "text" }, nodeSize: 5 }, 4);
        callback({ type: { name: "hardbreak" }, nodeSize: 1 }, 9);
        callback({ type: { name: "text" }, nodeSize: 5 }, 10);
      },
      textBetween: jest.fn((from: number) => ({ 0: "On", 4: "- ", 10: "Th" })[from] ?? ""),
    };
    const transaction = {
      insertText: jest.fn(),
      scrollIntoView: jest.fn(),
    };
    transaction.insertText.mockReturnValue(transaction);
    transaction.scrollIntoView.mockReturnValue(transaction);
    const tableCellPosition = {
      depth: 2,
      parent: paragraph,
      parentOffset: 0,
      start: jest.fn().mockReturnValue(5),
      node: (depth: number) => ({
        type: { name: depth === 1 ? "table_cell" : "paragraph" },
      }),
    };
    const view = {
      state: {
        selection: {
          empty: false,
          from: 5,
          to: 20,
          $from: tableCellPosition,
          $to: { ...tableCellPosition, parentOffset: 15 },
        },
        tr: transaction,
      },
      dispatch: jest.fn(),
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    await waitFor(() => expect(mockSetReadonly).toHaveBeenCalled());
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = '<button data-tome-bullet-list-button="true"></button>';

    fireEvent.pointerDown(host.querySelector("button") as HTMLButtonElement);

    expect(transaction.insertText).toHaveBeenNthCalledWith(1, "• ", 15);
    expect(transaction.insertText).toHaveBeenNthCalledWith(2, "• ", 9, 11);
    expect(transaction.insertText).toHaveBeenNthCalledWith(3, "• ", 5);
    expect(view.dispatch).toHaveBeenCalledWith(transaction);
  });

  it("opens an accessible lightbox for a rendered Mermaid diagram", async () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" readonly />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="tome-mermaid-preview">',
      '<button type="button" class="tome-mermaid-expand" aria-label="Expand Mermaid diagram">Expand</button>',
      '<div class="tome-mermaid-canvas">',
      '<svg viewBox="0 0 1800 600" aria-label="Example diagram"></svg>',
      "</div>",
      "</div>",
    ].join("");

    fireEvent.click(screen.getByRole("button", { name: "Expand Mermaid diagram" }));

    const dialog = await screen.findByRole("dialog", { name: "Mermaid diagram" });
    expect(dialog).toBeVisible();
    expect(dialog.querySelector(".tome-mermaid-lightbox-canvas svg")).toHaveAttribute(
      "aria-label",
      "Example diagram",
    );
    const canvas = dialog.querySelector(".tome-mermaid-lightbox-canvas") as HTMLDivElement;
    const zoomOut = screen.getByRole("button", { name: "Zoom out Mermaid diagram" });
    const zoomReset = screen.getByRole("button", { name: "Reset Mermaid zoom" });
    const zoomIn = screen.getByRole("button", { name: "Zoom in Mermaid diagram" });

    expect(zoomReset).toHaveTextContent("100%");
    expect(canvas).toHaveStyle("--tome-mermaid-expanded-width: 1800px");

    fireEvent.click(zoomOut);
    expect(zoomReset).toHaveTextContent("75%");
    expect(canvas).toHaveStyle("--tome-mermaid-expanded-width: 1350px");

    fireEvent.click(zoomIn);
    expect(zoomReset).toHaveTextContent("100%");
    expect(canvas).toHaveStyle("--tome-mermaid-expanded-width: 1800px");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("hydrates sanitized external placeholders into allowlisted iframes", async () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" readonly />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="tome-embed-preview tome-youtube-preview"',
      ' data-embed-provider="youtube"',
      ' data-embed-src="https://www.youtube-nocookie.com/embed/M7lc1UVf-VE"',
      ' data-embed-title="Example video">',
      '<div class="tome-embed-frame tome-video-frame"></div>',
      "</div>",
    ].join("");

    const iframe = await waitFor(() => {
      const value = host.querySelector("iframe");
      expect(value).toBeInTheDocument();
      return value as HTMLIFrameElement;
    });
    expect(iframe).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE",
    );
    expect(iframe).toHaveAttribute("title", "Example video");
  });

  it("persists the Vidcast playlist expansion toggle in the embed Markdown", () => {
    const dispatch = jest.fn();
    const replacement = { name: "updated-playlist-node" };
    const replaceTr = { name: "replace-playlist-tr" };
    const node = {
      nodeSize: 8,
      type: {
        name: "code_block",
        create: jest.fn().mockReturnValue(replacement),
      },
      attrs: { language: "vidcast" },
      marks: [],
      textContent: `url: https://app.vidcast.io/playlists/daa5d80c-9272-4587-989b-91d6c5f35b93`,
    };
    const tr = { replaceWith: jest.fn().mockReturnValue(replaceTr) };
    const view = {
      posAtDOM: jest.fn().mockReturnValue(10),
      state: {
        doc: {
          resolve: jest.fn().mockReturnValue({ depth: 0, nodeAfter: node }),
        },
        schema: { text: jest.fn((value: string) => ({ value })) },
        tr,
      },
      dispatch,
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="tome-embed-preview tome-vidcast-preview">',
      '<button type="button" class="tome-vidcast-playlist-toggle" role="switch"',
      ' aria-label="Show playlist videos" aria-checked="true"></button>',
      "</div>",
    ].join("");

    fireEvent.click(screen.getByRole("switch", { name: "Show playlist videos" }));

    expect(node.type.create).toHaveBeenCalledWith(
      node.attrs,
      {
        value:
          "url: https://app.vidcast.io/playlists/daa5d80c-9272-4587-989b-91d6c5f35b93?expand=0",
      },
      node.marks,
    );
    expect(tr.replaceWith).toHaveBeenCalledWith(10, 18, replacement);
    expect(dispatch).toHaveBeenCalledWith(replaceTr);
  });

  it("persists an embed alignment selection in Markdown", () => {
    const dispatch = jest.fn();
    const replacement = { name: "aligned-embed-node" };
    const replaceTr = { name: "align-embed-tr" };
    const node = {
      nodeSize: 8,
      type: {
        name: "code_block",
        create: jest.fn().mockReturnValue(replacement),
      },
      attrs: { language: "youtube" },
      marks: [],
      textContent: "url: https://youtu.be/M7lc1UVf-VE\nwidth: 60%",
    };
    const tr = { replaceWith: jest.fn().mockReturnValue(replaceTr) };
    const view = {
      posAtDOM: jest.fn().mockReturnValue(10),
      state: {
        doc: {
          resolve: jest.fn().mockReturnValue({ depth: 0, nodeAfter: node }),
        },
        schema: { text: jest.fn((value: string) => ({ value })) },
        tr,
      },
      dispatch,
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="tome-embed-preview tome-youtube-preview" data-media-align="center">',
      '<div class="tome-media-alignment" role="group" aria-label="Media alignment">',
      '<button type="button" class="tome-media-align" data-align="left" aria-label="Align media left" aria-pressed="false"></button>',
      '<button type="button" class="tome-media-align" data-align="center" aria-label="Align media center" aria-pressed="true"></button>',
      '<button type="button" class="tome-media-align" data-align="right" aria-label="Align media right" aria-pressed="false"></button>',
      "</div>",
      "</div>",
    ].join("");

    fireEvent.click(screen.getByRole("button", { name: "Align media right" }));

    expect(host.querySelector(".tome-embed-preview")).toHaveAttribute(
      "data-media-align",
      "right",
    );
    expect(screen.getByRole("button", { name: "Align media right" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(node.type.create).toHaveBeenCalledWith(
      node.attrs,
      { value: "url: https://youtu.be/M7lc1UVf-VE\nwidth: 60%\nalign: right" },
      node.marks,
    );
    expect(tr.replaceWith).toHaveBeenCalledWith(10, 18, replacement);
    expect(dispatch).toHaveBeenCalledWith(replaceTr);
  });

  it("deletes the underlying block when an embed's remove button is clicked in edit mode", () => {
    const dispatch = jest.fn();
    const node = { nodeSize: 4 };
    const deleteTr = { name: "delete-tr" };
    const tr = { delete: jest.fn().mockReturnValue(deleteTr) };
    const view = {
      posAtDOM: jest.fn().mockReturnValue(10),
      state: {
        doc: {
          resolve: jest.fn().mockReturnValue({
            depth: 1,
            before: jest.fn().mockReturnValue(5),
            node: jest.fn().mockReturnValue(node),
          }),
        },
        tr,
      },
      dispatch,
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="tome-embed-preview tome-youtube-preview">',
      '<button type="button" class="tome-embed-remove" aria-label="Remove YouTube embed"></button>',
      "</div>",
    ].join("");

    fireEvent.click(screen.getByRole("button", { name: "Remove YouTube embed" }));

    expect(view.posAtDOM).toHaveBeenCalled();
    expect(tr.delete).toHaveBeenCalledWith(5, 9);
    expect(dispatch).toHaveBeenCalledWith(deleteTr);
  });

  it("deletes an image node whose wrapper maps to a document boundary", async () => {
    const dispatch = jest.fn();
    const node = { nodeSize: 2 };
    const deleteTr = { name: "delete-image-tr" };
    const tr = { delete: jest.fn().mockReturnValue(deleteTr) };
    const view = {
      posAtDOM: jest.fn().mockReturnValue(10),
      state: {
        doc: {
          resolve: jest.fn().mockReturnValue({
            depth: 0,
            nodeAfter: node,
          }),
        },
        tr,
      },
      dispatch,
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = '<div class="milkdown-image-block"></div>';

    fireEvent.click(await screen.findByRole("button", { name: "Remove image" }));

    expect(view.posAtDOM).toHaveBeenCalled();
    expect(tr.delete).toHaveBeenCalledWith(10, 12);
    expect(dispatch).toHaveBeenCalledWith(deleteTr);
  });

  it("opens the image file picker on the first pointer interaction", async () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="milkdown-image-block">',
      '<div class="image-edit"><div class="link-importer"><div class="placeholder">',
      '<input class="hidden" id="image-upload" type="file" accept="image/*">',
      '<label class="uploader" for="image-upload"><span>Upload file</span></label>',
      "</div></div></div>",
      "</div>",
    ].join("");

    const uploader = await screen.findByRole("button", { name: "Upload image file" });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const click = jest.spyOn(input, "click");

    expect(fireEvent.pointerDown(uploader, { button: 0 })).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);

    // The subsequent browser click must not activate the label a second time.
    fireEvent.click(uploader, { detail: 1 });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("keeps the image upload control keyboard accessible", async () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="milkdown-image-block">',
      '<div class="placeholder">',
      '<input class="hidden" id="image-upload" type="file" accept="image/*">',
      '<label class="uploader" for="image-upload"><span>Upload file</span></label>',
      "</div>",
      "</div>",
    ].join("");

    const uploader = await screen.findByRole("button", { name: "Upload image file" });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const click = jest.spyOn(input, "click");

    expect(uploader).toHaveAttribute("tabindex", "0");
    expect(fireEvent.keyDown(uploader, { key: "Enter" })).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("adds resizing after an empty image block finishes loading", async () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    const block = document.createElement("div");
    block.className = "milkdown-image-block";
    block.innerHTML = '<div class="image-edit">Upload file</div>';
    host.append(block);

    await screen.findByRole("button", { name: "Remove image" });
    expect(screen.queryByRole("slider", { name: "Resize image" })).not.toBeInTheDocument();

    block.querySelector(".image-edit")?.remove();
    const wrapper = document.createElement("div");
    wrapper.className = "image-wrapper";
    wrapper.innerHTML = '<img src="data:image/png;base64,example" alt="Example">';
    block.append(wrapper);

    expect(await screen.findByRole("slider", { name: "Resize image" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(block.querySelectorAll(".tome-embed-toolbar")).toHaveLength(1);
  });

  it("resizes an image proportionally with keyboard controls", async () => {
    const dispatch = jest.fn();
    const resizedTr = { name: "resize-image-tr" };
    const tr = {
      setNodeAttribute: jest.fn().mockReturnValue(resizedTr),
    };
    const node = {
      type: { name: "image-block" },
      attrs: { ratio: 0.8 },
    };
    const view = {
      posAtDOM: jest.fn().mockReturnValue(10),
      state: {
        doc: {
          resolve: jest.fn().mockReturnValue({ depth: 0, nodeAfter: node }),
        },
        tr,
      },
      dispatch,
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="milkdown-image-block">',
      '<div class="image-wrapper"><img src="https://example.com/example.png"></div>',
      "</div>",
    ].join("");

    const handle = await screen.findByRole("slider", { name: "Resize image" });
    expect(handle).toHaveAttribute("aria-valuenow", "80");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(handle).toHaveAttribute("aria-valuenow", "75");
    expect(handle.closest(".milkdown-image-block")).toHaveStyle(
      "--tome-media-width: 75%",
    );
    expect(tr.setNodeAttribute).toHaveBeenCalledWith(10, "ratio", 0.75);
    expect(dispatch).toHaveBeenCalledWith(resizedTr);
  });

  it("persists image alignment as a node attribute", async () => {
    const dispatch = jest.fn();
    const alignedTr = { name: "align-image-tr" };
    const tr = {
      setNodeAttribute: jest.fn().mockReturnValue(alignedTr),
    };
    const node = {
      type: { name: "image-block" },
      attrs: { alignment: "center", ratio: 0.8 },
    };
    const view = {
      posAtDOM: jest.fn().mockReturnValue(10),
      state: {
        doc: {
          resolve: jest.fn().mockReturnValue({ depth: 0, nodeAfter: node }),
        },
        tr,
      },
      dispatch,
    };
    mockEditorAction.mockImplementation((fn: (ctx: { get: () => unknown }) => void) =>
      fn({ get: () => view }),
    );

    const { container } = render(<CrepeEditor initialMarkdown="# Example" />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="milkdown-image-block">',
      '<div class="image-wrapper"><img src="https://example.com/example.png"></div>',
      "</div>",
    ].join("");

    const rightButton = await screen.findByRole("button", {
      name: "Align media right",
    });
    fireEvent.click(rightButton);

    expect(rightButton.closest(".milkdown-image-block")).toHaveAttribute(
      "data-media-align",
      "right",
    );
    expect(tr.setNodeAttribute).toHaveBeenCalledWith(10, "alignment", "right");
    expect(dispatch).toHaveBeenCalledWith(alignedTr);
  });

  it("does not delete an embed's block when clicked in read-only view mode", () => {
    const { container } = render(<CrepeEditor initialMarkdown="# Example" readonly />);
    const host = container.querySelector(".milkdown-host") as HTMLDivElement;
    host.innerHTML = [
      '<div class="tome-embed-preview tome-youtube-preview">',
      '<button type="button" class="tome-embed-remove" aria-label="Remove YouTube embed"></button>',
      "</div>",
    ].join("");

    fireEvent.click(screen.getByRole("button", { name: "Remove YouTube embed" }));

    expect(mockEditorAction).not.toHaveBeenCalled();
  });
});
