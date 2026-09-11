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

  it("keeps a chat write's body edits while restoring the kind", async () => {
    // A steward asking the agent to rewrite the page is human-directed, so
    // the body lands; only the relabelling is undone. (The same write on an
    // ingest run is refused outright — see the stable-page guard below.)
    const { POST } = await import("../route");
    await POST(
      postRequest({
        path: "roadmap.md",
        body: "---\ntitle: Roadmap\nkind: dynamic\norder: 3\n---\n# Roadmap\n\nQ4 milestones.\n",
        actor_sub: "steward-sub-456",
      }),
      ctx(),
    );

    const written = mockWritePage.mock.calls[0][2] as string;
    expect(written).toContain("kind: stable");
    expect(written).toContain("Q4 milestones.");
  });

  it("leaves a write that keeps the stored kind byte-identical", async () => {
    // Frontmatter-only, body untouched: the code-owned template-binding stamp.
    const incoming = PINNED.replace("order: 3", "order: 3\ntemplate_version: 10");
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

describe("internal pages POST — stable pages are never edited by the agent", () => {
  const STABLE = "---\ntitle: Charter\nkind: stable\n---\n# Charter\n\nOur problem statement.\n";
  const REWRITTEN = "---\ntitle: Charter\nkind: stable\n---\n# Charter\n\nRewritten by the agent.\n";
  const REPORT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let mockWritePage: jest.Mock;
  let mockFindOne: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.TOME_AGENT_TOKEN = "agent-tok";
    mockRequireAgentToken.mockReturnValue(undefined);
    mockResolveProject.mockResolvedValue(PROJECT);
    mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockReadPage.mockResolvedValue(STABLE);
    mockGetPageStore.mockResolvedValue({
      writePage: mockWritePage,
      readPage: mockReadPage,
    });
    mockFindOne = jest.fn().mockResolvedValue({ dispatch: { skipReview: false } });
    mockGetTomeIngestRunsCollection.mockResolvedValue({ findOne: mockFindOne });
    mockGetExperiment.mockResolvedValue(null);
    mockGetExperimentArtifact.mockResolvedValue(null);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  });

  it("refuses an ingest write that rewrites a stable page's body", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "charter.md", body: REWRITTEN, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "STABLE_PAGE_READ_ONLY" });
    expect(mockWritePage).not.toHaveBeenCalled();
  });

  it("refuses an append, not just a wholesale rewrite", async () => {
    // The production case: a new section appended to a page pinned stable
    // nine minutes earlier.
    const appended = STABLE.replace(
      "Our problem statement.",
      "Our problem statement.\n\n**Milestone 7:** appended by the agent.",
    );
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "charter.md", body: appended, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(409);
    expect(mockWritePage).not.toHaveBeenCalled();
  });

  it("refuses even when the agent relabels the page dynamic in the same write", async () => {
    // The kind guard restores `stable` first, so the relabel cannot be used
    // to buy write access to the body.
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "charter.md",
        body: REWRITTEN.replace("kind: stable", "kind: dynamic"),
        report_id: REPORT,
      }),
      ctx(),
    );

    expect(res.status).toBe(409);
    expect(mockWritePage).not.toHaveBeenCalled();
  });

  it("allows a chat write — a steward asking for the change", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "charter.md", body: REWRITTEN, actor_sub: "steward-sub-456" }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "charter.md",
      REWRITTEN,
      expect.anything(),
    );
  });

  it("allows a greenfield run the team opted into stable-page seeding on", async () => {
    mockFindOne.mockResolvedValue({
      greenfield: true,
      dispatch: { skipReview: false, seedStablePages: true },
    });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "charter.md", body: REWRITTEN, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalled();
  });

  it("refuses seedStablePages on a NON-greenfield run", async () => {
    // The reingest route accepts `seedStablePages` on any run and
    // `createRunRecord` stores it verbatim; only the agent request is clamped
    // to `isGreenfield && seedStablePages`. That clamp governs what the agent
    // is told, not what this route authorizes — so a plain reingest carrying
    // the flag must not license stable-page edits.
    mockFindOne.mockResolvedValue({
      greenfield: false,
      dispatch: { skipReview: false, seedStablePages: true },
    });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "charter.md", body: REWRITTEN, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "STABLE_PAGE_READ_ONLY" });
    expect(mockWritePage).not.toHaveBeenCalled();
  });

  it("refuses seedStablePages when the run does not record greenfield at all", async () => {
    mockFindOne.mockResolvedValue({ dispatch: { skipReview: false, seedStablePages: true } });

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "charter.md", body: REWRITTEN, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(409);
    expect(mockWritePage).not.toHaveBeenCalled();
  });

  it("allows a frontmatter-only ingest write on a stable page", async () => {
    // The code-owned template-binding stamp. Blocking this breaks every run.
    const stamped = STABLE.replace(
      "kind: stable",
      "kind: stable\ntemplate_scope: top-level\ntemplate_path: charter.md\ntemplate_version: 10",
    );
    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "charter.md", body: stamped, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith("proj-1", "charter.md", stamped, expect.anything());
  });

  it("still lets the agent rewrite a dynamic page", async () => {
    mockReadPage.mockResolvedValue("---\nkind: dynamic\n---\n# Activity\n\nOld.\n");
    const incoming = "---\nkind: dynamic\n---\n# Activity\n\nFresh.\n";

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "activity.md", body: incoming, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith("proj-1", "activity.md", incoming, expect.anything());
  });

  it("still lets the agent append to its own hidden memory page", async () => {
    mockReadPage.mockResolvedValue("---\nkind: hidden\n---\n# Memory\n\n## Ingest 1\n");
    const incoming = "---\nkind: hidden\n---\n# Memory\n\n## Ingest 1\n\n## Ingest 2\n";

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "memory.md", body: incoming, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalled();
  });

  it("still lets the agent create a page it invented", async () => {
    mockReadPage.mockRejectedValue(new Error("page not found"));
    const incoming = "---\ntitle: TBAC\ntype: glossary\nkind: dynamic\n---\n# TBAC";

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "glossary/tbac.md", body: incoming, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalled();
  });

  it("still lets the agent edit a page that declares no kind", async () => {
    // Decision records, meeting notes and glossary terms the agent authored
    // often carry no `kind`. Treating those as human-owned would lock it out
    // of its own work.
    mockReadPage.mockResolvedValue("# Decision\n\nOld.\n");
    const incoming = "# Decision\n\nNew.\n";

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({ path: "decisions/local-slm.md", body: incoming, report_id: REPORT }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mockWritePage).toHaveBeenCalled();
  });
});

describe("internal pages POST — \"unless asked\" on stable pages", () => {
  const STABLE = "---\ntitle: Charter\nkind: stable\n---\n# Charter\n\nOur problem statement.\n";
  const REWRITTEN = "---\ntitle: Charter\nkind: stable\n---\n# Charter\n\nCorrected.\n";
  const REPORT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let mockWritePage: jest.Mock;
  let mockFindOne: jest.Mock;

  const run = (over: Record<string, unknown>) => ({
    triggered_by: "manual",
    dispatch: { endpoint: "/ingest", skipReview: false, ...(over.dispatch ?? {}) },
    ...over,
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.TOME_AGENT_TOKEN = "agent-tok";
    mockRequireAgentToken.mockReturnValue(undefined);
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "none" });
    mockWritePage = jest.fn().mockResolvedValue(undefined);
    mockReadPage.mockResolvedValue(STABLE);
    mockGetPageStore.mockResolvedValue({ writePage: mockWritePage, readPage: mockReadPage });
    mockFindOne = jest.fn();
    mockGetTomeIngestRunsCollection.mockResolvedValue({ findOne: mockFindOne });
    mockGetExperiment.mockResolvedValue(null);
    mockGetExperimentArtifact.mockResolvedValue(null);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  });

  async function post() {
    const { POST } = await import("../route");
    return POST(postRequest({ path: "charter.md", body: REWRITTEN, report_id: REPORT }), ctx());
  }

  it("allows a human quick edit that names the correction", async () => {
    // `tome_reingest` with mode "quick" and a seed: the ingest prompt calls
    // this "the team asked for one targeted correction".
    mockFindOne.mockResolvedValue(
      run({ dispatch: { mode: "quick", seed: "the charter is wrong about the ICP, fix it" } }),
    );

    expect((await post()).status).toBe(200);
    expect(mockWritePage).toHaveBeenCalled();
  });

  it("refuses the scheduler's quick run, which carries no seed", async () => {
    // The Webex meeting-series scheduler dispatches mode "quick" too, with
    // seed: null and triggered_by "auto". Nobody asked.
    mockFindOne.mockResolvedValue(
      run({ triggered_by: "auto", dispatch: { mode: "quick", seed: null } }),
    );

    expect((await post()).status).toBe(409);
    expect(mockWritePage).not.toHaveBeenCalled();
  });

  it("refuses an auto-triggered run even if it somehow carries a seed", async () => {
    mockFindOne.mockResolvedValue(
      run({ triggered_by: "auto", dispatch: { mode: "quick", seed: "refresh" } }),
    );

    expect((await post()).status).toBe(409);
  });

  it("refuses a full reingest with a steering seed", async () => {
    // A seed on a full refresh is a hint for the sweep, not a request to
    // rewrite one human-owned page.
    mockFindOne.mockResolvedValue(
      run({ dispatch: { mode: "full", seed: "focus on the new repo" } }),
    );

    expect((await post()).status).toBe(409);
  });

  it("refuses a quick run whose seed is blank", async () => {
    mockFindOne.mockResolvedValue(run({ dispatch: { mode: "quick", seed: "   " } }));

    expect((await post()).status).toBe(409);
  });

  it("refuses a routine scheduled ingest", async () => {
    mockFindOne.mockResolvedValue(run({ triggered_by: "auto", dispatch: {} }));

    expect((await post()).status).toBe(409);
  });

  it("refuses when the run record cannot be found", async () => {
    mockFindOne.mockResolvedValue(null);

    expect((await post()).status).toBe(409);
  });

  it("still drafts an asked-for edit under stable-only review", async () => {
    // "Asked" grants permission to write, not permission to publish
    // unreviewed. The page is stable, so the default review mode holds it.
    mockResolveProject.mockResolvedValue({ ...PROJECT, review_mode: "stable_only" });
    mockFindOne.mockResolvedValue(
      run({ dispatch: { mode: "quick", seed: "fix the ICP section" } }),
    );

    expect((await post()).status).toBe(200);
    expect(mockWritePage).toHaveBeenCalledWith(
      "proj-1",
      "charter.md",
      REWRITTEN,
      expect.objectContaining({ status: "draft" }),
    );
  });
});

describe("internal pages POST — run lookup is project-scoped", () => {
  const REPORT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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
    mockGetExperiment.mockResolvedValue(null);
    mockGetExperimentArtifact.mockResolvedValue(null);
  });

  it("matches the run on project as well as report id", async () => {
    const findOne = jest.fn().mockResolvedValue({ dispatch: { skipReview: false } });
    mockGetTomeIngestRunsCollection.mockResolvedValue({ findOne });

    const { POST } = await import("../route");
    await POST(
      postRequest({ path: "activity.md", body: "# A", report_id: REPORT }),
      ctx(),
    );

    expect(findOne).toHaveBeenCalledWith({ report_id: REPORT, project_id: "proj-1" });
  });

  it("treats a run from another project as absent, not as authorization", async () => {
    // A scoped miss returns null, and `wasAskedFor(null)` is false — so the
    // stable-page guard stays on rather than being waved through.
    const findOne = jest.fn().mockResolvedValue(null);
    mockGetTomeIngestRunsCollection.mockResolvedValue({ findOne });
    mockReadPage.mockResolvedValue("---\nkind: stable\n---\n# Charter\n\nOurs.\n");

    const { POST } = await import("../route");
    const res = await POST(
      postRequest({
        path: "charter.md",
        body: "---\nkind: stable\n---\n# Charter\n\nRewritten.\n",
        report_id: REPORT,
      }),
      ctx(),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "STABLE_PAGE_READ_ONLY" });
  });
});
