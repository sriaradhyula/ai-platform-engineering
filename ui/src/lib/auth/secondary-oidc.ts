import { createHmac, timingSafeEqual } from "crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";

import type { JWTIdentity } from "@/lib/jwt-validation";
import { linkSecondaryOidcIdentity } from "@/lib/auth/secondary-identity-link";

/**
 * Server-only proof used after a secondary OIDC token has been validated.
 * The proof binds internal forwarding to the exact bearer token without
 * forwarding a provider-specific credential to downstream routes.
 */
export const SECONDARY_OIDC_PROOF_HEADER = "x-caipe-secondary-oidc-proof";

const SECONDARY_OIDC_JWKS_URI = "CAIPE_SECONDARY_OIDC_JWKS_URI";
const SECONDARY_OIDC_ISSUER = "CAIPE_SECONDARY_OIDC_ISSUER";
const SECONDARY_OIDC_AUDIENCES = "CAIPE_SECONDARY_OIDC_AUDIENCES";
const SECONDARY_OIDC_PROVIDER_ID = "CAIPE_SECONDARY_OIDC_PROVIDER_ID";
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface SecondaryOidcConfig {
  audiences: string[];
  issuer: string;
  jwksUri: string;
  providerId: string;
}

interface SecondaryOidcSession {
  accessToken: string;
  authMethod: "bearer";
  org?: string;
  principalType: "oidc_user";
  role: "user";
  sub?: string;
  secondaryOidcProof: string;
  user: { email: string; name: string };
}

export interface SecondaryOidcAuthResult {
  session: SecondaryOidcSession;
  user: { email: string; name: string; role: string };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getSecondaryOidcConfig(): SecondaryOidcConfig | null {
  const jwksUri = process.env[SECONDARY_OIDC_JWKS_URI]?.trim() || "";
  const issuer = process.env[SECONDARY_OIDC_ISSUER]?.trim() || "";
  const audiences = csv(process.env[SECONDARY_OIDC_AUDIENCES]);
  const providerId = process.env[SECONDARY_OIDC_PROVIDER_ID]?.trim() || "";
  const configured = Boolean(jwksUri || issuer || audiences.length || providerId);

  if (!configured) return null;
  if (!jwksUri || !issuer || audiences.length === 0 || !providerId) {
    throw new Error(
      `${SECONDARY_OIDC_JWKS_URI}, ${SECONDARY_OIDC_ISSUER}, ${SECONDARY_OIDC_AUDIENCES}, and ${SECONDARY_OIDC_PROVIDER_ID} must all be configured`,
    );
  }

  const parsed = new URL(jwksUri);
  if (parsed.protocol !== "https:") {
    throw new Error(`${SECONDARY_OIDC_JWKS_URI} must use HTTPS`);
  }
  const parsedIssuer = new URL(issuer);
  if (parsedIssuer.protocol !== "https:") {
    throw new Error(`${SECONDARY_OIDC_ISSUER} must use HTTPS`);
  }
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(
      `${SECONDARY_OIDC_PROVIDER_ID} must be a 1-64 character provider identifier`,
    );
  }

  return { audiences, issuer, jwksUri, providerId };
}

export function isSecondaryOidcConfigured(): boolean {
  return getSecondaryOidcConfig() !== null;
}

function getJWKS(config: SecondaryOidcConfig): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(config.jwksUri);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  jwksCache.set(config.jwksUri, jwks);
  return jwks;
}

function identityFromPayload(payload: JWTPayload): JWTIdentity {
  const email =
    (typeof payload.email === "string" && payload.email) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username) ||
    (typeof payload.sub === "string" && payload.sub) ||
    "unknown";
  const name =
    (typeof payload.name === "string" && payload.name) ||
    (typeof payload.fullname === "string" && payload.fullname) ||
    email;
  const groups = Array.isArray(payload.groups)
    ? payload.groups.map(String)
    : typeof payload.groups === "string"
      ? payload.groups.split(/[;,\s]+/).filter(Boolean)
      : [];

  return {
    email,
    name,
    groups,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    org:
      (typeof payload.org === "string" && payload.org) ||
      (typeof payload.tenant_id === "string" && payload.tenant_id) ||
      (typeof payload.organization === "string" && payload.organization) ||
      undefined,
  };
}

/** Validate a secondary OIDC JWT locally against cached remote JWKS keys. */
export async function validateSecondaryOidcJWT(token: string): Promise<JWTIdentity> {
  const config = getSecondaryOidcConfig();
  if (!config) {
    throw new Error("CAIPE secondary OIDC JWT validation is not configured");
  }

  const { payload } = await jwtVerify(token, getJWKS(config), {
    issuer: config.issuer,
    audience: config.audiences,
    requiredClaims: ["iss", "aud", "exp"],
  });
  if (typeof payload.iss !== "string" || typeof payload.sub !== "string") {
    throw new Error("The secondary OIDC token must contain issuer and subject claims");
  }
  return linkSecondaryOidcIdentity({
    providerId: config.providerId,
    issuer: payload.iss,
    externalSub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified:
      typeof payload.email_verified === "boolean"
        ? payload.email_verified
        : undefined,
    identity: identityFromPayload(payload),
  });
}

function internalProofSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret?.trim()) {
    throw new Error("NEXTAUTH_SECRET is required for secondary OIDC forwarding");
  }
  return secret;
}

function proofForToken(token: string): string {
  return createHmac("sha256", internalProofSecret())
    .update("caipe-secondary-oidc-proof\0", "utf8")
    .update(token, "utf8")
    .digest("base64url");
}

export function createSecondaryOidcProof(token: string): string {
  return proofForToken(token);
}

/** Verify the proof before accepting a secondary OIDC token internally. */
export function isValidSecondaryOidcProof(token: string, proof: string | null): boolean {
  if (!proof) return false;
  try {
    const expected = Buffer.from(proofForToken(token));
    const actual = Buffer.from(proof);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function buildSecondaryOidcAuth(
  token: string,
  identity: JWTIdentity,
): SecondaryOidcAuthResult {
  const user = { email: identity.email, name: identity.name, role: "user" };
  return {
    user,
    session: {
      role: "user",
      accessToken: token,
      sub: identity.sub,
      org: identity.org,
      principalType: "oidc_user",
      authMethod: "bearer",
      secondaryOidcProof: createSecondaryOidcProof(token),
      user: { email: identity.email, name: identity.name },
    },
  };
}

export function resetSecondaryOidcJWTCache(): void {
  jwksCache.clear();
}
