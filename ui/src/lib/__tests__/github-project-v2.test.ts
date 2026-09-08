/** @jest-environment node */

const mockGraphql = jest.fn();
const mockGetIssue = jest.fn();

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    graphql: mockGraphql,
    issues: { get: mockGetIssue },
  })),
}));

import { readGitHubProjectV2Issue } from "@/lib/github-project-v2";

describe("readGitHubProjectV2Issue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGraphql
      .mockResolvedValueOnce({
        item: {
          content: {
            __typename: "Issue",
            number: 42,
            repository: {
              databaseId: 123,
              nameWithOwner: "example/service",
            },
          },
          fieldValues: {
            nodes: [
              {
                optionId: "other-option",
                field: { id: "PVTSSF_other", name: "Priority" },
              },
              {
                optionId: "progress-option",
                name: "In Progress",
                field: { id: "PVTSSF_status", name: "Status" },
              },
            ],
          },
        },
        content: null,
      });
    mockGetIssue.mockResolvedValue({
      data: {
        number: 42,
        title: "Tracked issue",
        body: null,
        html_url: "https://github.com/example/service/issues/42",
        state: "open",
        labels: [{ name: "tome:critical" }],
        assignees: [],
        user: { login: "author" },
        milestone: null,
        updated_at: "2026-08-27T03:00:00Z",
      },
    });
  });

  it("resolves the issue and the selected Status option", async () => {
    await expect(
      readGitHubProjectV2Issue("project-token", {
        itemNodeId: "PVTI_item",
        contentNodeId: "I_issue",
        fieldNodeId: "PVTSSF_status",
      }),
    ).resolves.toMatchObject({
      repositoryId: 123,
      repositoryFullName: "example/service",
      projectStatus: "in_progress",
      projectStatusName: "In Progress",
      statusFieldChanged: true,
      issue: {
        number: 42,
        displayStatus: "open",
      },
    });
    expect(mockGetIssue).toHaveBeenCalledWith({
      owner: "example",
      repo: "service",
      issue_number: 42,
    });
  });
});
