import { createHash, randomUUID } from "crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import type { NextRequest } from "next/server";

import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import {
  buildSecondaryOidcAuth,
  isSecondaryOidcConfigured,
  validateSecondaryOidcJWT,
} from "@/lib/auth/secondary-oidc";
import { unlinkedSecondaryOidcIdentity } from "@/lib/auth/secondary-identity-link";

type AuthErrorDetails = {
  action?: unknown;
  claim?: unknown;
  code?: unknown;
  name?: unknown;
  reason?: unknown;
  statusCode?: unknown;
};

function boundedString(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maxLength)
    : undefined;
}

function safeAudience(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return boundedString(value);
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, 8)
    .map((entry) => entry.slice(0, 256));
}

/**
 * Return enough unverified JWT metadata to diagnose trust-anchor failures
 * without putting a reusable credential or caller identity into logs.
 */
function bearerDebugMetadata(token: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    fingerprint: createHash("sha256").update(token).digest("hex").slice(0, 16),
    tokenCharacters: token.length,
    tokenSegments: token.split(".").length,
  };

  try {
    const header = decodeProtectedHeader(token);
    metadata.alg = boundedString(header.alg, 64);
    metadata.kid = boundedString(header.kid, 256);
    metadata.typ = boundedString(header.typ, 64);
  } catch {
    metadata.headerDecoded = false;
  }

  try {
    const payload = decodeJwt(token);
    metadata.iss = boundedString(payload.iss);
    metadata.aud = safeAudience(payload.aud);
    metadata.exp = typeof payload.exp === "number" ? payload.exp : undefined;
    metadata.nbf = typeof payload.nbf === "number" ? payload.nbf : undefined;
    metadata.iat = typeof payload.iat === "number" ? payload.iat : undefined;
  } catch {
    metadata.payloadDecoded = false;
  }

  return metadata;
}

function authErrorMetadata(error: unknown): Record<string, unknown> {
  const details = (error ?? {}) as AuthErrorDetails;
  return {
    name: boundedString(details.name, 128),
    code: boundedString(details.code, 128),
    claim: boundedString(details.claim, 128),
    reason: boundedString(details.reason, 128),
    action: boundedString(details.action, 128),
    statusCode:
      typeof details.statusCode === "number" ? details.statusCode : undefined,
  };
}

function debugRequestId(request: NextRequest): string {
  return (
    boundedString(request.headers.get("x-request-id"), 128) ||
    boundedString(request.headers.get("traceparent"), 128) ||
    randomUUID()
  );
}

function logAuthDebug(
  requestId: string,
  event: string,
  details: Record<string, unknown>,
): void {
  if (process.env.CAIPE_SECONDARY_OIDC_AUTH_DEBUG !== "true") return;
  console.warn(
    "[caipe-secondary-oidc-auth]",
    JSON.stringify({ event, requestId, ...details }),
  );
}

function buildUnlinkedSecondaryOidcAuth(identity: {
  email: string;
  name: string;
}) {
  const user = { email: identity.email, name: identity.name, role: "user" };
  return {
    user,
    session: {
      role: "user" as const,
      sub: undefined,
      principalType: "secondary_oidc_unlinked" as const,
      authMethod: "bearer" as const,
      user: { email: identity.email, name: identity.name },
    },
  };
}

/**
 * MCP authentication accepts a JWT from an optional secondary OIDC
 * provider in addition to CAIPE's existing Keycloak, API-key, and
 * browser-session credentials. The secondary provider is attempted first
 * only for callers that opt into this helper; all other API routes retain the
 * normal Keycloak-only bearer behavior.
 */
export async function getMcpAuthFromBearerOrSession(
  request: NextRequest,
  options: { allowUnlinkedSecondaryIdentity?: boolean } = {},
) {
  const authorization = request.headers.get("authorization");
  const requestId = debugRequestId(request);
  const hasBearer = authorization?.startsWith("Bearer ") === true;
  let bearerMetadata: Record<string, unknown> | undefined;

  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length);
    bearerMetadata = bearerDebugMetadata(token);

    let secondaryConfigured: boolean;
    try {
      secondaryConfigured = isSecondaryOidcConfigured();
    } catch (error) {
      logAuthDebug(requestId, "secondary_config_invalid", {
        ...bearerMetadata,
        error: authErrorMetadata(error),
      });
      throw error;
    }

    if (secondaryConfigured) {
      try {
        const identity = await validateSecondaryOidcJWT(token);
        logAuthDebug(requestId, "secondary_validation_succeeded", bearerMetadata);
        return buildSecondaryOidcAuth(token, identity);
      } catch (error) {
        const unlinkedIdentity = unlinkedSecondaryOidcIdentity(error);
        if (unlinkedIdentity && options.allowUnlinkedSecondaryIdentity) {
          logAuthDebug(requestId, "secondary_identity_unlinked", {
            ...bearerMetadata,
            error: authErrorMetadata(error),
          });
          return buildUnlinkedSecondaryOidcAuth(unlinkedIdentity);
        }
        logAuthDebug(requestId, "secondary_validation_failed", {
          ...bearerMetadata,
          error: authErrorMetadata(error),
        });
        // Dual-auth behavior: a failed secondary-provider validation may still
        // be a valid Keycloak token, handled by the existing middleware below.
      }
    }
  }

  try {
    const result = await getAuthFromBearerOrSession(request);
    logAuthDebug(requestId, "primary_fallback_succeeded", {
      hasBearer,
      ...bearerMetadata,
    });
    return result;
  } catch (error) {
    logAuthDebug(requestId, "primary_fallback_failed", {
      hasBearer,
      ...bearerMetadata,
      error: authErrorMetadata(error),
    });
    throw error;
  }
}
