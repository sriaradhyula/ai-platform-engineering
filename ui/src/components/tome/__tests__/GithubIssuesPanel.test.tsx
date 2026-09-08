import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/hooks/use-agentic-sdlc-stream", () => ({
  useAgenticSdlcStream: jest.fn(),
}));

import { GithubIssuesPanel } from "../GithubIssuesPanel";

const issue = {
  repo: "example/service",
  number: 42,
  title: "Tracked work",
  body: null,
  url: "https://github.com/example/service/issues/42",
  state: "open" as const,
  stateReason: null,
  displayStatus: "open" as const,
  priority: null,
  labels: ["tome:critical"],
  assignees: [],
  author: "test-user",
  milestone: null,
  updatedAt: "2026-08-27T00:00:00Z",
};

function issuesResponse(
  issues = [issue],
  overrides: Partial<{
    credentialConfigured: boolean;
    writeCredentialConfigured: boolean;
    availableIssues: typeof issue[];
  }> = {},
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        issues,
        credentialConfigured: true,
        writeCredentialConfigured: true,
        repos: ["example/service"],
        rollupProjectSlugs: ["example-project"],
        ...overrides,
      },
    }),
  };
}

describe("GithubIssuesPanel", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("searches only the tracked issues returned by the server", async () => {
    mockFetch.mockResolvedValue(issuesResponse([
      issue,
      { ...issue, number: 43, title: "Another tracked item" },
    ]));

    render(<GithubIssuesPanel slug="example-project" canEdit={false} />);

    expect(await screen.findByText("Tracked work")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search tracked issues"), {
      target: { value: "another" },
    });
    expect(screen.queryByText("Tracked work")).not.toBeInTheDocument();
    expect(screen.getByText("Another tracked item")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("requests the selected TOME label from the server", async () => {
    mockFetch.mockResolvedValue(issuesResponse());

    render(
      <GithubIssuesPanel
        slug="example-project"
        canEdit={false}
        initialLabel="tome:critical"
        title="Critical"
      />,
    );

    expect(await screen.findByText("Tracked work")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/tome/projects/example-project/github-issues?label=tome%3Acritical",
      undefined,
    );
    expect(screen.getByRole("heading", { name: "Critical issues" })).toBeInTheDocument();
  });

  it("warns non-stewards that issues are read-only without linking credentials", async () => {
    mockFetch.mockResolvedValue(issuesResponse([issue], {
      credentialConfigured: false,
    }));

    render(<GithubIssuesPanel slug="example-project" canEdit={false} />);

    expect(await screen.findByText(
      "Issues are read-only for you. Only this project's data steward can move or update issues.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/GitHub is not connected/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connected Credentials" })).not.toBeInTheDocument();
  });

  it("keeps the read-only warning even when GitHub is connected", async () => {
    mockFetch.mockResolvedValue(issuesResponse());

    render(<GithubIssuesPanel slug="example-project" canEdit={false} />);

    expect(await screen.findByText(
      "Issues are read-only for you. Only this project's data steward can move or update issues.",
    )).toBeInTheDocument();
  });

  it("adds and removes only TOME-owned tracked labels", async () => {
    const unlabelledIssue = { ...issue, labels: [] };
    const mutationResponse = (labels: string[]) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { issue: { ...unlabelledIssue, labels } },
      }),
    });
    mockFetch
      .mockResolvedValueOnce(issuesResponse([unlabelledIssue]))
      .mockResolvedValueOnce(mutationResponse(["tome:critical"]))
      .mockResolvedValueOnce(mutationResponse([]));

    render(<GithubIssuesPanel slug="example-project" canEdit />);
    expect(await screen.findByText("Tracked work")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Manage tracking labels for Tracked work" }));
    fireEvent.click(screen.getByRole("button", { name: "Add tome:critical" }));
    await waitFor(() => {
      expect(screen.getByRole("button", {
        name: "Manage tracking labels for Tracked work",
      })).not.toBeDisabled();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove tome:critical" }));

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/tome/projects/example-project/github-issues",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          repo: "example/service",
          number: 42,
          label: "tome:critical",
          operation: "add",
        }),
      }),
    );
    await waitFor(() => {
      expect(mockFetch).toHaveBeenNthCalledWith(
        3,
        "/api/tome/projects/example-project/github-issues",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            repo: "example/service",
            number: 42,
            label: "tome:critical",
            operation: "remove",
          }),
        }),
      );
    });
  });

  it("tracks an issue from an attached repository and mutates the panel data", async () => {
    const cachedIssue = {
      ...issue,
      number: 99,
      title: "Newly tracked work",
      labels: [],
      url: "https://github.com/example/service/issues/99",
    };
    const addedIssue = { ...cachedIssue, labels: ["tome:critical"] };
    mockFetch
      .mockResolvedValueOnce(issuesResponse([], { availableIssues: [cachedIssue] }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { issue: addedIssue },
        }),
      });

    render(<GithubIssuesPanel slug="example-project" canEdit />);
    await screen.findByLabelText("Search tracked issues");
    fireEvent.click(screen.getByRole("button", { name: "Add issue" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Issue" }));
    fireEvent.click(screen.getByRole("option", { name: /#99 Newly tracked work/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add / remove labels" }));

    expect(await screen.findByText("Newly tracked work")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/tome/projects/example-project/github-issues",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          repo: "example/service",
          number: 99,
          label: "tome:critical",
          operation: "add",
        }),
      }),
    );
  });

  it("uses CSS line clamping instead of truncating issue descriptions", async () => {
    const body = "A detailed issue description that should remain intact for line clamping.".repeat(8);
    mockFetch.mockResolvedValue(issuesResponse([{ ...issue, body }]));

    render(<GithubIssuesPanel slug="example-project" canEdit={false} />);

    const description = await screen.findByText(body);
    expect(description).toHaveClass("line-clamp-3");
  });

  it("uses semantic colors for tracked and status labels", async () => {
    mockFetch.mockResolvedValue(issuesResponse([{
      ...issue,
      labels: ["tome:critical", "tome:needs attention", "status:in-progress", "area:tome"],
    }]));

    render(<GithubIssuesPanel slug="example-project" canEdit={false} />);

    expect(await screen.findByText("Tracked work")).toBeInTheDocument();
    expect(screen.getByText("tome:critical")).toHaveClass("border-red-300");
    expect(screen.getByText("tome:needs attention")).toHaveClass("border-amber-300");
    expect(screen.getByText("status:in-progress")).toHaveClass("border-amber-300");
    expect(screen.getByText("area:tome")).toHaveClass("border-border");
  });
});
