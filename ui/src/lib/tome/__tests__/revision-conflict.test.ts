import { currentLiveRevision, hasPageEditConflict } from "../revision-conflict";
import type { PageRevision } from "@/types/tome";

function revision(id: string, status?: PageRevision["status"]): PageRevision {
  return {
    _id: id,
    project_id: "example-project-id",
    path: "example.md",
    markdown: id,
    author: "test-user@example.com",
    message: "test",
    status,
    created_at: new Date(),
  };
}

describe("revision conflict detection", () => {
  it("ignores review-only revisions and compares the latest live revision", () => {
    const history = [revision("draft", "draft"), revision("latest"), revision("old")];
    expect(currentLiveRevision(history)?._id).toBe("latest");
    expect(hasPageEditConflict(history, "latest")).toBe(false);
    expect(hasPageEditConflict(history, "old")).toBe(true);
  });
});
