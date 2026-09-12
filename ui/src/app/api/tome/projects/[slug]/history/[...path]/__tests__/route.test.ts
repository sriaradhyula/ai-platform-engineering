/** @jest-environment node */

import { NextRequest } from "next/server";

const mockLoadTomeProject = jest.fn();
const mockPageHistory = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  successResponse: (data: unknown) => Response.json({ data }),
  withErrorHandler: (handler: unknown) => handler,
}));

jest.mock("@/lib/tome/tome-api", () => ({
  loadTomeProject: (...args: unknown[]) => mockLoadTomeProject(...args),
}));

jest.mock("@/lib/tome/page-store", () => ({
  getPageStore: async () => ({ pageHistory: mockPageHistory }),
}));

describe("page history status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadTomeProject.mockResolvedValue({ projectId: "project-example" });
  });

  it("identifies the current live revision instead of the newest draft", async () => {
    mockPageHistory.mockResolvedValue([
      {
        _id: "draft-revision",
        path: "charter.md",
        author: "agent@example.test",
        message: "draft update",
        created_at: new Date("2026-09-04T13:34:21Z"),
        status: "draft",
      },
      {
        _id: "live-revision",
        path: "charter.md",
        author: "editor@example.test",
        message: "published update",
        created_at: new Date("2026-08-25T14:32:01Z"),
      },
    ]);

    const { GET } = await import("../route");
    const response = await GET(
      new NextRequest("http://localhost/api/tome/projects/example/history/charter.md"),
      { params: Promise.resolve({ slug: "example", path: ["charter.md"] }) },
    );
    const body = await response.json();

    expect(body.data.current_revision_id).toBe("live-revision");
    expect(body.data.revisions).toEqual([
      expect.objectContaining({ id: "draft-revision", status: "draft" }),
      expect.objectContaining({ id: "live-revision", status: "live" }),
    ]);
  });
});
