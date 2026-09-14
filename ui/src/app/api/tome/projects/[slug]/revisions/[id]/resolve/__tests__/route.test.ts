/** @jest-environment node */

import { NextRequest } from "next/server";

const mockLoadTomeProject = jest.fn();
const mockRequireTomeEditor = jest.fn();
const mockGuardNotLocked = jest.fn();
const mockReadRevision = jest.fn();
const mockPageHistory = jest.fn();
const mockResolveOrphanDraft = jest.fn();
const mockAuditTome = jest.fn();

class MockApiError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

jest.mock("@/lib/api-middleware", () => ({
  ApiError: MockApiError,
  successResponse: (data: unknown) => Response.json({ data }),
  withErrorHandler: (handler: unknown) => handler,
}));

jest.mock("@/lib/tome/tome-api", () => ({
  loadTomeProject: (...args: unknown[]) => mockLoadTomeProject(...args),
  requireTomeEditor: (...args: unknown[]) => mockRequireTomeEditor(...args),
  guardNotLocked: (...args: unknown[]) => mockGuardNotLocked(...args),
}));

jest.mock("@/lib/tome/page-store", () => ({
  getPageStore: async () => ({
    readRevision: mockReadRevision,
    pageHistory: mockPageHistory,
    resolveOrphanDraft: mockResolveOrphanDraft,
  }),
}));

jest.mock("@/lib/tome/audit", () => ({
  auditTome: (...args: unknown[]) => mockAuditTome(...args),
  tomeActorFromAuth: () => ({ type: "user", id: "steward@example.test" }),
}));

const ctx = { params: Promise.resolve({ slug: "example", id: "draft-revision" }) };

function request(action: "publish" | "reject", baseRevisionId: string | null = "live-revision") {
  return new NextRequest(
    "http://localhost/api/tome/projects/example/revisions/draft-revision/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, base_revision_id: baseRevisionId }),
    },
  );
}

describe("orphan draft resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadTomeProject.mockResolvedValue({
      projectId: "project-example",
      project: { locked: false },
      user: { email: "steward@example.test" },
      session: {},
    });
    mockReadRevision.mockResolvedValue({
      _id: "draft-revision",
      project_id: "project-example",
      path: "charter.md",
      markdown: "# Draft",
      status: "draft",
      created_at: new Date("2026-09-04T13:34:21Z"),
    });
    mockPageHistory.mockResolvedValue([
      { _id: "draft-revision", status: "draft" },
      { _id: "live-revision", status: "live" },
    ]);
    mockResolveOrphanDraft.mockResolvedValue({
      _id: "draft-revision",
      path: "charter.md",
      status: "live",
    });
  });

  it("publishes an orphan draft with revision conflict protection and audit metadata", async () => {
    const { POST } = await import("../route");
    const response = await POST(request("publish"), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireTomeEditor).toHaveBeenCalled();
    expect(mockResolveOrphanDraft).toHaveBeenCalledWith(
      "project-example",
      "draft-revision",
      "publish",
      "steward@example.test",
    );
    expect(mockAuditTome).toHaveBeenCalledWith(expect.objectContaining({
      action: "tome.page.draft.publish",
      page: "charter.md",
    }));
    expect(body.data.current_revision_id).toBe("draft-revision");
  });

  it("rejects a stale publish when the live revision changed", async () => {
    const { POST } = await import("../route");
    const response = await POST(request("publish", "older-live-revision"), ctx);

    expect(response.status).toBe(409);
    expect(mockResolveOrphanDraft).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      code: "PAGE_EDIT_CONFLICT",
      data: { current_revision_id: "live-revision" },
    });
  });

  it("keeps report-backed drafts in the ingest review workflow", async () => {
    mockReadRevision.mockResolvedValue({
      _id: "draft-revision",
      path: "charter.md",
      status: "draft",
      report_id: "report-example",
    });
    const { POST } = await import("../route");

    await expect(POST(request("publish"), ctx)).rejects.toMatchObject({
      status: 409,
      code: "INGEST_REVIEW_REQUIRED",
    });
    expect(mockResolveOrphanDraft).not.toHaveBeenCalled();
  });

  it("rejects an orphan draft without changing the current live revision", async () => {
    const { POST } = await import("../route");
    const response = await POST(request("reject", null), ctx);
    const body = await response.json();

    expect(mockResolveOrphanDraft).toHaveBeenCalledWith(
      "project-example",
      "draft-revision",
      "reject",
      "steward@example.test",
    );
    expect(body.data).toMatchObject({
      status: "rejected",
      current_revision_id: "live-revision",
    });
  });
});
