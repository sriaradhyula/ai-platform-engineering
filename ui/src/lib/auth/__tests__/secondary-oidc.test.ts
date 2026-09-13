import { jwtVerify } from "jose";

import {
  buildSecondaryOidcAuth,
  createSecondaryOidcProof,
  isSecondaryOidcConfigured,
  isValidSecondaryOidcProof,
  resetSecondaryOidcJWTCache,
  validateSecondaryOidcJWT,
} from "@/lib/auth/secondary-oidc";

const mockJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;
const mockLinkSecondaryOidcIdentity = jest.fn();

jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn().mockReturnValue("mock-secondary-oidc-jwks"),
  jwtVerify: jest.fn(),
}));

jest.mock("@/lib/auth/secondary-identity-link", () => ({
  linkSecondaryOidcIdentity: (...args: unknown[]) =>
    mockLinkSecondaryOidcIdentity(...args),
}));

describe("CAIPE secondary OIDC JWT validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAIPE_SECONDARY_OIDC_JWKS_URI = "https://identity.example.test/oauth2/keys";
    process.env.CAIPE_SECONDARY_OIDC_ISSUER = "https://identity.example.test/oauth2";
    process.env.CAIPE_SECONDARY_OIDC_AUDIENCES = "caipe-api, mcp";
    process.env.CAIPE_SECONDARY_OIDC_PROVIDER_ID = "example-corporate";
    process.env.NEXTAUTH_SECRET = "internal-test-secret";
    mockJwtVerify.mockResolvedValue({
      payload: {
        sub: "secondary-subject",
        email: "user@example.test",
        email_verified: true,
        name: "Example User",
        groups: ["member"],
        iss: "https://identity.example.test/oauth2",
        aud: ["caipe-api"],
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      protectedHeader: { alg: "RS256" },
    } as Awaited<ReturnType<typeof jwtVerify>>);
    mockLinkSecondaryOidcIdentity.mockImplementation(
      async ({ identity }) => ({ ...identity, sub: "keycloak-subject" }),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSecondaryOidcJWTCache();
    mockJwtVerify.mockReset();
    mockLinkSecondaryOidcIdentity.mockReset();
  });

  it("requires all three secondary OIDC trust settings", () => {
    delete process.env.CAIPE_SECONDARY_OIDC_AUDIENCES;

    expect(isSecondaryOidcConfigured).toThrow(/must all be configured/);
  });

  it("requires a provider identifier with the trust settings", () => {
    delete process.env.CAIPE_SECONDARY_OIDC_PROVIDER_ID;

    expect(isSecondaryOidcConfigured).toThrow(/must all be configured/);
  });

  it("validates issuer, audience, and required expiration locally", async () => {
    const identity = await validateSecondaryOidcJWT("oidc-token");

    expect(identity).toMatchObject({
      sub: "keycloak-subject",
      email: "user@example.test",
      name: "Example User",
      groups: ["member"],
    });
    expect(mockJwtVerify).toHaveBeenCalledWith(
      "oidc-token",
      "mock-secondary-oidc-jwks",
      expect.objectContaining({
        issuer: "https://identity.example.test/oauth2",
        audience: ["caipe-api", "mcp"],
        requiredClaims: ["iss", "aud", "exp"],
      }),
    );
    expect(mockLinkSecondaryOidcIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "secondary-subject",
        email: "user@example.test",
        emailVerified: true,
      }),
    );
  });

  it("binds the internal forwarding proof to the exact token", () => {
    const proof = createSecondaryOidcProof("oidc-token");

    expect(isValidSecondaryOidcProof("oidc-token", proof)).toBe(true);
    expect(isValidSecondaryOidcProof("different-token", proof)).toBe(false);
    expect(isValidSecondaryOidcProof("oidc-token", "forged-proof")).toBe(false);
  });

  it("builds an OpenFGA-compatible user session from the linked Keycloak sub", () => {
    const result = buildSecondaryOidcAuth("oidc-token", {
      email: "user@example.test",
      name: "Example User",
      groups: [],
      sub: "keycloak-subject",
    });

    expect(result).toMatchObject({
      user: { email: "user@example.test", name: "Example User", role: "user" },
      session: {
        accessToken: "oidc-token",
        principalType: "oidc_user",
        authMethod: "bearer",
        sub: "keycloak-subject",
      },
    });
    expect(result.session.secondaryOidcProof).toEqual(expect.any(String));
  });
});
