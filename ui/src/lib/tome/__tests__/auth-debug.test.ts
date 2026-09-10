/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockIsTomeSecondaryOidcConfigured = jest.fn();
const mockValidateTomeSecondaryOidcJWT = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) =>
    mockGetAuthFromBearerOrSession(...args),
}));

jest.mock("@/lib/tome/oidc-jwt", () => ({
  buildTomeOidcAuth: jest.fn(),
  isTomeSecondaryOidcConfigured: () =>
    mockIsTomeSecondaryOidcConfigured(),
  validateTomeSecondaryOidcJWT: (...args: unknown[]) =>
    mockValidateTomeSecondaryOidcJWT(...args),
}));

import { getTomeAuthFromBearerOrSession } from "../auth";

function encoded(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("TOME MCP auth diagnostics", () => {
  const originalDebug = process.env.TOME_MCP_AUTH_DEBUG;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.TOME_MCP_AUTH_DEBUG = "true";
    mockIsTomeSecondaryOidcConfigured.mockReturnValue(true);
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.TOME_MCP_AUTH_DEBUG;
    else process.env.TOME_MCP_AUTH_DEBUG = originalDebug;
    warn.mockRestore();
    jest.clearAllMocks();
  });

  it("logs safe JWT metadata and both validation failures without the bearer", async () => {
    const token = [
      encoded({ alg: "RS256", kid: "secondary-key", typ: "JWT" }),
      encoded({
        iss: "https://identity.example.test/oauth2/example",
        aud: ["tome-api"],
        sub: "sensitive-subject",
        email: "user@example.test",
        iat: 1_750_000_000,
        exp: 1_750_000_300,
      }),
      "sensitive-signature",
    ].join(".");
    const secondaryError = Object.assign(new Error("audience mismatch"), {
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
      reason: "check_failed",
    });
    const primaryError = Object.assign(new Error("invalid bearer"), {
      name: "ApiError",
      code: "BEARER_INVALID",
      reason: "bearer_invalid",
      statusCode: 401,
    });
    mockValidateTomeSecondaryOidcJWT.mockRejectedValue(secondaryError);
    mockGetAuthFromBearerOrSession.mockRejectedValue(primaryError);

    await expect(
      getTomeAuthFromBearerOrSession(
        new NextRequest("https://example.test/api/tome/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-request-id": "request-123",
          },
        }),
      ),
    ).rejects.toBe(primaryError);

    const logs = warn.mock.calls.flat().join(" ");
    expect(logs).toContain("secondary_validation_failed");
    expect(logs).toContain("primary_fallback_failed");
    expect(logs).toContain("request-123");
    expect(logs).toContain("secondary-key");
    expect(logs).toContain("ERR_JWT_CLAIM_VALIDATION_FAILED");
    expect(logs).toContain('"claim":"aud"');
    expect(logs).toContain('"iss":"https://identity.example.test/oauth2/example"');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("sensitive-signature");
    expect(logs).not.toContain("sensitive-subject");
    expect(logs).not.toContain("user@example.test");
  });
});
