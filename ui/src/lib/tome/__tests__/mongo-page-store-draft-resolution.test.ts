const mockFindOneAndUpdate = jest.fn();

jest.mock("../mongo-collections", () => ({
  getTomePageRevisionsCollection: async () => ({
    findOneAndUpdate: mockFindOneAndUpdate,
  }),
}));

jest.mock("mongodb", () => ({
  ObjectId: class MockObjectId {
    static isValid(): boolean {
      return false;
    }
  },
}));

import { MongoPageStore } from "../mongo-page-store";

describe("MongoPageStore orphan draft resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({
      _id: "draft-revision",
      project_id: "project-example",
      path: "charter.md",
      status: "live",
    });
  });

  it("publishes only an unresolved report-less draft and preserves its draft time", async () => {
    const store = new MongoPageStore();
    await store.resolveOrphanDraft(
      "project-example",
      "draft-revision",
      "publish",
      "steward@example.test",
    );

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "draft-revision",
        project_id: "project-example",
        status: "draft",
        $or: [{ report_id: { $exists: false } }, { report_id: null }],
      }),
      [
        {
          $set: expect.objectContaining({
            status: "live",
            draft_created_at: "$created_at",
            reviewed_by: "steward@example.test",
            review_outcome: "published",
          }),
        },
      ],
      { returnDocument: "after" },
    );
  });

  it("rejects a draft without making it live", async () => {
    const store = new MongoPageStore();
    await store.resolveOrphanDraft(
      "project-example",
      "draft-revision",
      "reject",
      "steward@example.test",
    );

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-example",
        status: "draft",
      }),
      [
        {
          $set: expect.objectContaining({
            status: "rejected",
            reviewed_by: "steward@example.test",
            review_outcome: "rejected",
          }),
        },
      ],
      { returnDocument: "after" },
    );
  });
});
