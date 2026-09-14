/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockIsSecondaryOidcConfigured = jest.fn();
const mockValidateSecondaryOidcJWT = jest.fn();
const mockUnlinkedSecondaryOidcIdentity = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) =>
    mockGetAuthFromBearerOrSession(...args),
}));

jest.mock("@/lib/auth/secondary-oidc", () => ({
  buildSecondaryOidcAuth: jest.fn(),
  isSecondaryOidcConfigured: () => mockIsSecondaryOidcConfigured(),
  validateSecondaryOidcJWT: (...args: unknown[]) =>
    mockValidateSecondaryOidcJWT(...args),
}));

jest.mock("@/lib/auth/secondary-identity-link", () => ({
  unlinkedSecondaryOidcIdentity: (...args: unknown[]) =>
    mockUnlinkedSecondaryOidcIdentity(...args),
}));

import { getMcpAuthFromBearerOrSession } from "../mcp-auth";

function encoded(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("secondary OIDC MCP auth diagnostics", () => {
  const originalDebug = process.env.CAIPE_SECONDARY_OIDC_AUTH_DEBUG;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.CAIPE_SECONDARY_OIDC_AUTH_DEBUG = "true";
    mockIsSecondaryOidcConfigured.mockReturnValue(true);
    mockUnlinkedSecondaryOidcIdentity.mockReturnValue(null);
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.CAIPE_SECONDARY_OIDC_AUTH_DEBUG;
    } else {
      process.env.CAIPE_SECONDARY_OIDC_AUTH_DEBUG = originalDebug;
    }
    warn.mockRestore();
    jest.clearAllMocks();
  });

  it("logs safe JWT metadata and both validation failures without the bearer", async () => {
    const token = [
      encoded({ alg: "RS256", kid: "secondary-key", typ: "JWT" }),
      encoded({
        iss: "https://identity.example.test/oauth2/example",
        aud: ["caipe-api"],
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
    mockValidateSecondaryOidcJWT.mockRejectedValue(secondaryError);
    mockGetAuthFromBearerOrSession.mockRejectedValue(primaryError);

    await expect(
      getMcpAuthFromBearerOrSession(
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

  it("returns a limited unlinked session without falling back to primary auth", async () => {
    const linkingError = Object.assign(new Error("profile not found"), {
      code: "SECONDARY_OIDC_IDENTITY_USER_NOT_FOUND",
    });
    mockValidateSecondaryOidcJWT.mockRejectedValue(linkingError);
    mockUnlinkedSecondaryOidcIdentity.mockReturnValue({
      sub: "external-subject",
      email: "new-user@example.test",
      name: "New User",
      groups: [],
    });

    const result = await getMcpAuthFromBearerOrSession(
      new NextRequest("https://example.test/api/tome/mcp", {
        method: "POST",
        headers: { authorization: "Bearer redacted" },
      }),
      { allowUnlinkedSecondaryIdentity: true },
    );

    expect(result).toMatchObject({
      user: { email: "new-user@example.test", name: "New User" },
      session: {
        principalType: "secondary_oidc_unlinked",
        authMethod: "bearer",
      },
    });
    expect(result.session.sub).toBeUndefined();
    expect(result.session).not.toHaveProperty("accessToken");
    expect(mockGetAuthFromBearerOrSession).not.toHaveBeenCalled();

    const logs = warn.mock.calls.flat().join(" ");
    expect(logs).toContain("secondary_identity_unlinked");
    expect(logs).not.toContain("new-user@example.test");
    expect(logs).not.toContain("external-subject");
  });
});
