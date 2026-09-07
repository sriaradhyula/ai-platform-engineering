/** @jest-environment node */

import { NextRequest } from "next/server";

const mockLoadTomeProject = jest.fn();
const mockRequireTomeEditor = jest.fn();
const mockAddTracker = jest.fn();
const mockListTrackedLabels = jest.fn();
const mockReadLabelSettings = jest.fn();

jest.mock("@/lib/tome/tome-api", () => ({
  loadTomeProject: (...args: unknown[]) => mockLoadTomeProject(...args),
  requireTomeEditor: (...args: unknown[]) => mockRequireTomeEditor(...args),
}));
jest.mock("@/lib/tome/issue-tracker-store", () => ({
  addTomeCustomIssueTracker: (...args: unknown[]) => mockAddTracker(...args),
  listTomeTrackedIssueLabels: (...args: unknown[]) => mockListTrackedLabels(...args),
  readTomeIssueLabelSettings: (...args: unknown[]) => mockReadLabelSettings(...args),
}));

import { GET, POST } from "../route";

const endpoint = "http://example.test/api/tome/projects/example-project/issue-trackers";
const context = { params: Promise.resolve({ slug: "example-project" }) };

describe("TOME issue trackers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadTomeProject.mockResolvedValue({ projectId: "project-1", canEdit: true });
    mockReadLabelSettings.mockResolvedValue({
      use_prefix: true,
      labels: {
        critical: { title: "Critical", suffix: "critical" },
        "needs-attention": { title: "Needs Attention", suffix: "needs attention" },
        decision: { title: "Decisions", suffix: "decision" },
      },
      legacy_labels: {},
    });
    mockListTrackedLabels.mockResolvedValue([
      { id: "critical", label: "tome:critical", title: "Critical" },
      { id: "needs-attention", label: "tome:needs attention", title: "Needs Attention" },
      { id: "decision", label: "tome:decision", title: "Decisions" },
      { id: "security-review", label: "tome:security-review", title: "Security Review" },
    ]);
  });

  it("returns project-wide custom trackers to readable users", async () => {
    const response = await GET(new NextRequest(endpoint), context);

    expect(mockListTrackedLabels).toHaveBeenCalledWith(["project-1"]);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        trackers: expect.arrayContaining([{
          id: "critical",
          label: "tome:critical",
          title: "Critical",
        }]),
        prefix: "tome:",
      },
    });
  });

  it("creates a tracker from an unprefixed suffix", async () => {
    const response = await POST(new NextRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suffix: "security-review" }),
    }), context);

    expect(mockRequireTomeEditor).toHaveBeenCalled();
    expect(mockAddTracker).toHaveBeenCalledWith("project-1", "tome:security-review");
    expect(mockListTrackedLabels).toHaveBeenCalledWith(["project-1"]);
    expect(response.status).toBe(200);
  });

  it("rejects prefixes and unsupported label characters", async () => {
    const response = await POST(new NextRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suffix: "tome:security review" }),
    }), context);

    expect(response.status).toBe(400);
    expect(mockAddTracker).not.toHaveBeenCalled();
  });

  it("creates an unprefixed custom tracker when the admin setting disables the prefix", async () => {
    mockReadLabelSettings.mockResolvedValue({
      use_prefix: false,
      labels: {
        critical: { title: "Critical", suffix: "critical" },
        "needs-attention": { title: "Needs Attention", suffix: "needs attention" },
        decision: { title: "Decisions", suffix: "decision" },
      },
      legacy_labels: {},
    });

    const response = await POST(new NextRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suffix: "security-review" }),
    }), context);

    expect(response.status).toBe(200);
    expect(mockAddTracker).toHaveBeenCalledWith("project-1", "security-review");
    await expect(response.json()).resolves.toMatchObject({
      data: { prefix: "" },
    });
  });
});
