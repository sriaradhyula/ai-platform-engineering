import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { PageHistoryView } from "../PageHistoryView";

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

jest.mock("react-diff-viewer-continued", () => ({
  __esModule: true,
  default: ({ leftTitle, rightTitle }: { leftTitle: string; rightTitle: string }) => (
    <div data-testid="diff" data-left-title={leftTitle} data-right-title={rightTitle} />
  ),
  DiffMethod: { WORDS: "WORDS" },
}));

jest.mock("@/components/tome/ViewOnlyTooltip", () => ({
  ViewOnlyTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const historyResponse = {
  data: {
    current_revision_id: "live-revision",
    revisions: [
      {
        id: "draft-revision",
        author: "agent@example.test",
        message: "draft update",
        created_at: "2026-09-04T13:34:21Z",
        report_id: null,
        status: "draft",
        deleted: false,
        reverted_from: null,
        draft_created_at: null,
        reviewed_at: null,
        reviewed_by: null,
        review_outcome: null,
      },
      {
        id: "live-revision",
        author: "editor@example.test",
        message: "published update",
        created_at: "2026-08-25T14:32:01Z",
        report_id: null,
        status: "live",
        deleted: false,
        reverted_from: null,
        draft_created_at: null,
        reviewed_at: null,
        reviewed_by: null,
        review_outcome: null,
      },
    ],
  },
};

describe("PageHistoryView", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/history/")) {
        return { ok: true, json: async () => historyResponse } as Response;
      }
      if (url.endsWith("/revisions/draft-revision")) {
        return { ok: true, json: async () => ({ data: { body: "# Draft" } }) } as Response;
      }
      if (url.endsWith("/revisions/live-revision")) {
        return { ok: true, json: async () => ({ data: { body: "# Published" } }) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as jest.Mock;
  });

  it("labels the actual live revision current and makes an orphan draft recoverable", async () => {
    render(
      <PageHistoryView
        slug="example"
        path="charter.md"
        canEdit
      />,
    );

    const draftRow = await screen.findByRole("button", { name: /agent@example\.test draft/i });
    const liveRow = screen.getByRole("button", { name: /editor@example\.test current/i });

    expect(within(draftRow).getByText("draft")).toBeInTheDocument();
    expect(within(draftRow).queryByText("current")).not.toBeInTheDocument();
    expect(within(liveRow).getByText("current")).toBeInTheDocument();
    expect(await screen.findByText(/Draft — not visible to wiki readers/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled();

    await waitFor(() => {
      expect(screen.getByTestId("diff")).toHaveAttribute(
        "data-left-title",
        expect.stringContaining("editor@example.test"),
      );
      expect(screen.getByTestId("diff")).toHaveAttribute(
        "data-right-title",
        expect.stringContaining("DRAFT"),
      );
    });
  });

  it("publishes an orphan draft against the live revision shown to the reviewer", async () => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/revisions/draft-revision/resolve")) {
        expect(init).toMatchObject({ method: "POST" });
        expect(JSON.parse(String(init?.body))).toEqual({
          action: "publish",
          base_revision_id: "live-revision",
        });
        return { ok: true, json: async () => ({ data: { ok: true } }) } as Response;
      }
      if (url.includes("/history/")) {
        return { ok: true, json: async () => historyResponse } as Response;
      }
      const body = url.endsWith("/revisions/draft-revision") ? "# Draft" : "# Published";
      return { ok: true, json: async () => ({ data: { body } }) } as Response;
    });

    render(<PageHistoryView slug="example" path="charter.md" canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "Publish draft" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tome/projects/example/revisions/draft-revision/resolve",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
