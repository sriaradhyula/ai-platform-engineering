/** @jest-environment node */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
const mockIsTomeAdmin = jest.fn();
const mockIsTomeServerEnabled = jest.fn();
const mockReadSettings = jest.fn();
const mockSaveSettings = jest.fn();

jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/rbac/tome-admin", () => ({
  isTomeAdmin: (...args: unknown[]) => mockIsTomeAdmin(...args),
}));
jest.mock("@/lib/tome/guard", () => ({
  isTomeServerEnabled: () => mockIsTomeServerEnabled(),
}));
jest.mock("@/lib/tome/issue-tracker-store", () => ({
  readTomeIssueLabelSettings: (...args: unknown[]) => mockReadSettings(...args),
  saveTomeIssueLabelSettings: (...args: unknown[]) => mockSaveSettings(...args),
  TomeIssueLabelSettingsValidationFailure: class extends Error {
    errors: unknown[];
    constructor(errors: unknown[]) {
      super("validation");
      this.errors = errors;
    }
  },
}));

import { GET, PUT } from "../route";

const settings = {
  _id: "global",
  use_prefix: true,
  labels: {
    critical: { title: "Critical", suffix: "critical" },
    "needs-attention": { title: "Needs Attention", suffix: "needs attention" },
    decision: { title: "Decisions", suffix: "decision" },
  },
  version: 1,
  updated_at: "2026-09-07T00:00:00.000Z",
  updated_by: "admin@example.test",
};

describe("TOME issue label settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTomeServerEnabled.mockReturnValue(true);
    mockGetServerSession.mockResolvedValue({ user: { email: "admin@example.test" } });
    mockIsTomeAdmin.mockResolvedValue(true);
    mockReadSettings.mockResolvedValue(settings);
    mockSaveSettings.mockResolvedValue(settings);
  });

  it("returns the global settings to TOME admins", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: settings });
  });

  it("saves settings with the current admin identity", async () => {
    const body = {
      use_prefix: false,
      labels: {
        critical: { title: "Urgent", suffix: "urgent" },
        "needs-attention": { title: "Needs Attention", suffix: "needs attention" },
        decision: { title: "Decisions", suffix: "decision" },
      },
    };
    const response = await PUT(new NextRequest("http://example.test/api/tome/admin/issue-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(mockSaveSettings).toHaveBeenCalledWith(body, "admin@example.test");
  });

  it("rejects non-admins", async () => {
    mockIsTomeAdmin.mockResolvedValue(false);

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mockReadSettings).not.toHaveBeenCalled();
  });
});
