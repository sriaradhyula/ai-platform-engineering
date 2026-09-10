/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockRequireAgentToken = jest.fn();
const mockResolveProject = jest.fn();
const mockGetPageStore = jest.fn();
// Every agent write now reads the stored page first (page-kind guard, #369).
// Default: page does not exist yet, so the guard is a no-op.
const mockReadPage = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockGetTomeIngestRunsCollection = jest.fn();
const mockGetExperiment = jest.fn();
const mockGetExperimentArtifact = jest.fn();
const mockWriteExperimentArtifactPage = jest.fn();

jest.mock("@/lib/tome/internal-api", () => ({
  requireAgentToken: (...args: unknown[]) => mockRequireAgentToken(...args),
  resolveProject: (...args: unknown[]) => mockResolveProject(...args),
}));

jest.mock("@/lib/tome/page-store", () => ({
  getPageStore: () => mockGetPageStore(),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/tome/access", () => ({
  tomeDataObject: (project: { _id: string; type?: string }) =>
    `document:tome/${project.type ?? "project"}/${project._id}`,
}));

jest.mock("@/lib/tome/mongo-collections", () => ({
  getTomeIngestRunsCollection: () => mockGetTomeIngestRunsCollection(),
}));

jest.mock("@/lib/tome/evaluation-store", () => ({
  getExperiment: (...args: unknown[]) => mockGetExperiment(...args),
  getExperimentArtifact: (...args: unknown[]) => mockGetExperimentArtifact(...args),
  writeExperimentArtifactPage: (...args: unknown[]) => mockWriteExperimentArtifactPage(...args),
}));

const PROJECT = { _id: "proj-1", slug: "quantum", type: "project" };

function postRequest(body: Record<string, unknown>, token = "agent-tok"): NextRequest {
  return new NextRequest(
    new URL("/api/tome/api/internal/projects/proj-1/pages", "http://localhost:3000"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: "proj-1" }) };
}

describe("internal pages POST — FGA enforcement for chat-initiated writes", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.TOME_AGENT_TOKEN = "agent-tok";
    mockRequireAgentToken.mockReturnValue(undefined);
    mockResolveProject.mockResolvedValue(PROJECT);
    mockReadPage.mockRejectedValue(new Error("page not found"));
    mockGetPageStore.mockResolvedValue({
      writePage: jest.fn().mockResolvedValue(undefined),
      readPage: mockReadPage,
    });
    mockGetTomeIngestRunsCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
    });
    mockGetExperiment.mockResolvedValue(null);
    mockGetExperimentArtifact.mockResolvedValue(null);
    mockWriteExperimentArtifactPage.mockResolvedValue(undefined);
  });

  it("returns 403 when no actor_sub and no report_id (chat write, identity missing)", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "pages/test.md", body: "# Hello" }),
      ctx(),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("DATA_STEWARD_REQUIRED");
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
  });

  it("returns 403 when actor_sub is present but FGA denies can_write", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "pages/test.md",
        body: "# Hello",
        actor_sub: "viewer-sub-123",
      }),
      ctx(),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("DATA_STEWARD_REQUIRED");
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:viewer-sub-123",
      relation: "can_write",
      object: "document:tome/project/proj-1",
    });
  });

  it("publishes a chat write live when actor_sub has can_write", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    const mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "charter.md",
        body: "---\nkind: stable\n---\n# Charter",
        actor_sub: "steward-sub-456",
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "charter.md",
      "---\nkind: stable\n---\n# Charter",
      expect.objectContaining({ author: "tome-agent" }),
    );
    expect(mockWritePage.mock.calls[0][3]).not.toHaveProperty("status");
  });

  it("skips FGA check for ingest writes (report_id present)", async () => {
    const mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });
    mockGetTomeIngestRunsCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ dispatch: { skipReview: false } }),
    });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "pages/test.md",
        body: "# Hello",
        report_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        // no actor_sub — ingest writes don't carry it
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "pages/test.md",
      "# Hello",
      expect.objectContaining({ status: "draft" }),
    );
  });

  it("publishes ingest writes live when project review is disabled", async () => {
    const mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "none" });
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });
    mockGetTomeIngestRunsCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ dispatch: { skipReview: false } }),
    });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "charter.md",
        body: "# Charter",
        report_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "charter.md",
      "# Charter",
      expect.not.objectContaining({ status: "draft" }),
    );
  });

  it("publishes dynamic pages live in stable-only mode", async () => {
    const mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "stable_only" });
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "updates/example.md",
        body: "---\nkind: dynamic\n---\n# Update",
        report_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "updates/example.md",
      expect.any(String),
      expect.not.objectContaining({ status: "draft" }),
    );
  });

  it("drafts dynamic pages when all writes require review", async () => {
    const mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "all" });
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "updates/example.md",
        body: "---\nkind: dynamic\n---\n# Update",
        report_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "updates/example.md",
      expect.any(String),
      expect.objectContaining({ status: "draft" }),
    );
  });

  it("lets an ingest's explicit skip-review override publish live", async () => {
    const mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "all" });
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });
    mockGetTomeIngestRunsCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ dispatch: { skipReview: true } }),
    });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "charter.md",
        body: "# Charter",
        report_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "charter.md",
      "# Charter",
      expect.not.objectContaining({ status: "draft" }),
    );
  });

  it("keeps enforced-quality ingest writes in draft despite no-review settings", async () => {
    const mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "none" });
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });
    mockGetTomeIngestRunsCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        dispatch: { skipReview: true },
        quality_policy_mode: "enforce",
        quality_require_human_review: true,
      }),
    });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "charter.md",
        body: "# Charter",
        report_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "charter.md",
      "# Charter",
      expect.objectContaining({ status: "draft" }),
    );
  });

  it("isolates experiment writes from normal page revisions", async () => {
    mockGetExperiment.mockResolvedValue({ _id: "experiment-1", project_id: "proj-1" });
    mockGetExperimentArtifact.mockResolvedValue({
      _id: "artifact-1",
      experiment_id: "experiment-1",
      project_id: "proj-1",
    });
    const mockWritePage = jest.fn();
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });

    const { POST } = await import("../route");
    const res = await POST(postRequest({
      path: "overview.md",
      body: "# Candidate only",
      report_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      experiment_id: "experiment-1",
      artifact_id: "artifact-1",
    }), ctx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ isolated: true });
    expect(mockWriteExperimentArtifactPage).toHaveBeenCalledWith(
      "artifact-1",
      "overview.md",
      "# Candidate only",
    );
    expect(mockWritePage).not.toHaveBeenCalled();
  });

  it("rejects quick-evaluation writes outside the selected pages", async () => {
    mockGetExperiment.mockResolvedValue({
      _id: "experiment-1",
      project_id: "proj-1",
      config: {
        evaluation_mode: "quick",
        evaluation_page_scope: { mode: "selected", paths: ["overview.md"] },
      },
    });
    mockGetExperimentArtifact.mockResolvedValue({
      _id: "artifact-1",
      experiment_id: "experiment-1",
      project_id: "proj-1",
    });

    const { POST } = await import("../route");
    const res = await POST(postRequest({
      path: "status.md",
      body: "# Out of scope",
      experiment_id: "experiment-1",
      artifact_id: "artifact-1",
    }), ctx());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "QUICK_EVALUATION_PAGE_SCOPE",
    });
    expect(mockWriteExperimentArtifactPage).not.toHaveBeenCalled();
  });
});

describe("internal pages POST — page-kind guard (#369, #348)", () => {
  const PINNED = "---\ntitle: Roadmap\nkind: stable\norder: 3\n---\n# Roadmap\n\nBody.\n";
  const REPORT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let mockWritePage: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.TOME_AGENT_TOKEN = "agent-tok";
    mockRequireAgentToken.mockReturnValue(undefined);
    mockResolveProject.mockResolvedValue(PROJECT);
    mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockReadPage.mockResolvedValue(PINNED);
    mockGetPageStore.mockResolvedValue({
      writePage: mockWritePage,
      readPage: mockReadPage,
    });
    mockGetTomeIngestRunsCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ dispatch: { skipReview: false } }),
    });
    mockGetExperiment.mockResolvedValue(null);
    mockGetExperimentArtifact.mockResolvedValue(null);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  });

  it("restores the pinned kind on an ingest write that tries to flip it", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "roadmap.md",
        body: PINNED.replace("kind: stable", "kind: dynamic"),
        report_id: REPORT,
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ kind_change_blocked: true });
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "roadmap.md",
      PINNED,
      expect.anything(),
    );
  });

  it("restores the pinned kind on a chat write too", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "roadmap.md",
        body: PINNED.replace("kind: stable", "kind: dynamic"),
        actor_sub: "steward-sub-456",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage.mock.calls[0][2]).toContain("kind: stable");
  });

  it("still routes the de-pinning write through stable-page review", async () => {
    // Before the guard, the write that flipped stable -> dynamic was
    // classified by its own new frontmatter, so it read as a dynamic write
    // and published live — skipping the very review that should have caught
    // it. The gate must see the page's real (stored) kind.
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "stable_only" });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "roadmap.md",
        body: PINNED.replace("kind: stable", "kind: dynamic"),
        report_id: REPORT,
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "roadmap.md",
      PINNED,
      expect.objectContaining({ status: "draft" }),
    );
  });

  it("keeps body edits from the same write while restoring the kind", async () => {
    const { POST } = await import("../route");
    await POST(
      postRequest({
        path: "roadmap.md",
        body: "---\ntitle: Roadmap\nkind: dynamic\norder: 3\n---\n# Roadmap\n\nQ4 milestones.\n",
        report_id: REPORT,
      }),
      ctx(),
    );

    const written = mockWritePage.mock.calls[0][2] as string;
    expect(written).toContain("kind: stable");
    expect(written).toContain("Q4 milestones.");
  });

  it("leaves a write that keeps the stored kind byte-identical", async () => {
    const incoming = PINNED.replace("Body.", "Updated body.");
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "roadmap.md", body: incoming, report_id: REPORT }),
      ctx(),
    );

    await expect(res.json()).resolves.toMatchObject({ kind_change_blocked: false });
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "roadmap.md",
      incoming,
      expect.anything(),
    );
  });

  it("lets the agent set the kind on a page that does not exist yet", async () => {
    mockReadPage.mockRejectedValue(new Error("page not found"));
    const body = "---\ntitle: Activity\nkind: dynamic\n---\n# Activity";

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "activity.md", body, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ kind_change_blocked: false });
    expect(mockWritePage).toHaveBeenCalledWith("proj-1", "activity.md", body, expect.anything());
  });

  it("does not let a read failure block the write", async () => {
    mockReadPage.mockRejectedValue(new Error("mongo unavailable"));
    const body = "---\nkind: dynamic\n---\n# Activity";

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "activity.md", body, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalled();
  });

  it("never reads or guards an isolated experiment write", async () => {
    mockGetExperiment.mockResolvedValue({ _id: "experiment-1", project_id: "proj-1" });
    mockGetExperimentArtifact.mockResolvedValue({
      _id: "artifact-1",
      experiment_id: "experiment-1",
      project_id: "proj-1",
    });

    const { POST } = await import("../route");
    await POST(
      postRequest({
        path: "roadmap.md",
        body: "---\nkind: dynamic\n---\n# Candidate",
        report_id: REPORT,
        experiment_id: "experiment-1",
        artifact_id: "artifact-1",
      }),
      ctx(),
    );

    expect(mockReadPage).not.toHaveBeenCalled();
    expect(mockWritePage).not.toHaveBeenCalled();
  });
});
