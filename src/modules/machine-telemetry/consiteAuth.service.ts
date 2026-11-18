// ─────────────────────────────────────────────────────────────────────────────
// ConSite OAuth token management.
//
// The token endpoint's auth is plain HTTP Basic Auth (username/password) —
// confirmed from the Postman screenshot, not a manually-built header. Body
// is {"grant_type":"client_credentials"} for a fresh token, or
// {"grant_type":"refresh_token","refresh_token":"..."} to reissue, same
// Basic Auth header both times (confirmed). Response shape either way:
//   { token_type, access_token, expires_in, refresh_token }
//
// The token is cached in Redis (not in-process memory) so it survives
// worker-process restarts/PM2 restarts and is shared across every call in a
// sync run — one token fetch per ~hour-long expiry window, not one per
// machine or per page.
//
// Concurrency: a module-level in-flight promise (not a Redis lock) guards
// against two concurrent callers both triggering a refresh at once. This is
// enough for how the token is actually used today — the machine-telemetry
// worker runs with concurrency: 1, so there's only ever one sync in flight —
// and avoids building a distributed lock for a problem this codebase
// doesn't have yet (KISS). If a second concurrent consumer of this token is
// ever added, revisit this.
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import { redis } from "@shared/config/redis";
import logger from "@shared/utils/logger";
import ApiError from "@shared/utils/apiError";

const REDIS_TOKEN_KEY = "consite:token";

// Re-authenticate this many seconds before the token's real expiry, so a
// call that's in-flight right as the token would otherwise expire still
// succeeds with the token it already has.
const EXPIRY_SAFETY_BUFFER_SECONDS = 60;

type ConSiteTokenResponse = {
  token_type: string;
  access_token: string;
  expires_in: number; // seconds
  refresh_token: string;
};

type CachedToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms, already adjusted by the safety buffer
};

// ── Config ────────────────────────────────────────────────────────────────────

function readConSiteCredentials(): { username: string; password: string } {
  const username = process.env.CONSITE_USERNAME;
  const password = process.env.CONSITE_PASSWORD;

  if (!username || !password) {
    throw new ApiError(
      500,
      "CONSITE_USERNAME and CONSITE_PASSWORD must be configured",
    );
  }
  return { username, password };
}

function readConSiteTokenUrl(): string {
  const url = process.env.CONSITE_TOKEN_URL;
  if (!url) {
    throw new ApiError(500, "CONSITE_TOKEN_URL must be configured");
  }
  return url;
}

// ── Redis cache ───────────────────────────────────────────────────────────────

async function readRawCachedToken(): Promise<CachedToken | null> {
  const raw = await redis.get(REDIS_TOKEN_KEY);
  return raw ? (JSON.parse(raw) as CachedToken) : null;
}

async function writeCachedToken(
  response: ConSiteTokenResponse,
): Promise<CachedToken> {
  const cached: CachedToken = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt:
      Date.now() + (response.expires_in - EXPIRY_SAFETY_BUFFER_SECONDS) * 1000,
  };

  // TTL matches the token's real (unbuffered) lifetime, so a Redis entry
  // never outlives the credential it represents even if the safety-buffer
  // logic above is ever changed.
  await redis.set(
    REDIS_TOKEN_KEY,
    JSON.stringify(cached),
    "EX",
    response.expires_in,
  );

  return cached;
}

// ── Token endpoint calls ─────────────────────────────────────────────────────

async function requestNewToken(): Promise<ConSiteTokenResponse> {
  const { username, password } = readConSiteCredentials();

  const { data } = await axios.post<ConSiteTokenResponse>(
    readConSiteTokenUrl(),
    { grant_type: "client_credentials" },
    {
      auth: { username, password },
      headers: { Accept: "application/json" },
    },
  );

  return data;
}

async function requestRefreshedToken(
  refreshTokenValue: string,
): Promise<ConSiteTokenResponse> {
  const { username, password } = readConSiteCredentials();

  const { data } = await axios.post<ConSiteTokenResponse>(
    readConSiteTokenUrl(),
    { grant_type: "refresh_token", refresh_token: refreshTokenValue },
    {
      auth: { username, password },
      headers: { Accept: "application/json" },
    },
  );

  return data;
}

// ── Public API ───────────────────────────────────────────────────────────────

// In-flight guard shared across concurrent callers within this process —
// see module header for why this (and not a Redis lock) is enough today.
let inFlightTokenFetch: Promise<CachedToken> | null = null;

// Returns a valid ConSite access token, transparently refreshing or
// re-authenticating as needed. Safe to call before every outbound ConSite
// request — in the common case this is just a Redis GET, not a network
// round-trip to ConSite.
export async function getConSiteAccessToken(): Promise<string> {
  const valid = await readRawCachedToken();
  if (valid && valid.expiresAt > Date.now()) {
    return valid.accessToken;
  }

  if (inFlightTokenFetch) {
    return (await inFlightTokenFetch).accessToken;
  }

  inFlightTokenFetch = (async () => {
    try {
      // Prefer refreshing over a full re-auth when we have something to
      // refresh with — reuse the just-read cache entry if we have one
      // (it may be expired-by-buffer but not yet evicted by Redis' real
      // TTL), otherwise there is nothing to refresh and we go straight to
      // a fresh client_credentials request.
      const stale = valid ?? (await readRawCachedToken());

      if (stale) {
        try {
          const response = await requestRefreshedToken(stale.refreshToken);
          return await writeCachedToken(response);
        } catch (error) {
          logger.warn(
            `[ConSiteAuth] Token refresh failed, falling back to a full re-auth: ${(error as Error).message}`,
          );
        }
      }

      const response = await requestNewToken();
      return writeCachedToken(response);
    } finally {
      inFlightTokenFetch = null;
    }
  })();

  return (await inFlightTokenFetch).accessToken;
}
