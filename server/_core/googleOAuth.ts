/**
 * Google (Gmail) OAuth 2.0 / OpenID Connect login.
 * Reuses the existing JWT session cookie (app_session_id).
 *
 * CSRF protection uses an HMAC-signed `state` (not a Secure/__Host- cookie),
 * so the flow works on local HTTP (localhost) after the Google redirect.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import * as db from "../db";
import { isPlatformAdminEmail } from "../domain/platformAdmin";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import { sdk } from "./sdk";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const STATE_TTL_MS = 10 * 60 * 1000;

type GoogleOAuthState = {
  redirectUri: string;
  nonce: string;
  exp: number;
  /** Same-origin relative path after login, e.g. `/invite/...` */
  returnTo?: string;
};

function sanitizeReturnTo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  if (value.includes("://")) return undefined;
  return value;
}

function isGoogleAuthConfigured() {
  return Boolean(ENV.googleClientId && ENV.googleClientSecret);
}

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function getRedirectUri(req: Request): string {
  if (ENV.googleRedirectUri) return ENV.googleRedirectUri;

  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]?.trim()
    : forwardedProto?.split(",")[0]?.trim();
  const protocol = proto || req.protocol || "http";
  const host = req.get("host") || "localhost:3010";
  return `${protocol}://${host}/api/auth/google/callback`;
}

function signState(payload: GoogleOAuthState): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = ENV.cookieSecret || "dev-insecure-oauth-state";
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(state: string): GoogleOAuthState | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;

  const secret = ENV.cookieSecret || "dev-insecure-oauth-state";
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as GoogleOAuthState;
    if (
      typeof payload.redirectUri !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function decodeIdTokenPayload(idToken: string): {
  sub?: string;
  email?: string;
  name?: string;
} {
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return JSON.parse(json) as { sub?: string; email?: string; name?: string };
  } catch {
    return {};
  }
}

export function registerGoogleOAuthRoutes(app: Express) {
  app.get("/api/auth/google", (req: Request, res: Response) => {
    if (!isGoogleAuthConfigured()) {
      res.status(503).json({
        error: "Google OAuth is not configured",
        detail: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment.",
      });
      return;
    }

    const redirectUri = getRedirectUri(req);
    const returnTo = sanitizeReturnTo(getQueryParam(req, "returnTo"));
    const state = signState({
      redirectUri,
      nonce: randomUUID(),
      exp: Date.now() + STATE_TTL_MS,
      ...(returnTo ? { returnTo } : {}),
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", ENV.googleClientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("state", state);

    res.redirect(302, url.toString());
  });

  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    if (!isGoogleAuthConfigured()) {
      res.status(503).json({ error: "Google OAuth is not configured" });
      return;
    }

    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    const oauthError = getQueryParam(req, "error");

    if (oauthError) {
      res.status(400).json({ error: "Google OAuth denied", detail: oauthError });
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    const parsed = verifyState(state);
    if (!parsed) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }

    const cookieOptions = getSessionCookieOptions(req);

    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: ENV.googleClientId,
          client_secret: ENV.googleClientSecret,
          redirect_uri: parsed.redirectUri || getRedirectUri(req),
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const detail = await tokenRes.text();
        console.error("[GoogleOAuth] Token exchange failed", detail);
        res.status(502).json({ error: "Google token exchange failed" });
        return;
      }

      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        id_token?: string;
      };

      let sub: string | undefined;
      let email: string | null = null;
      let name: string | null = null;

      if (tokenJson.access_token) {
        const userInfoRes = await fetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (userInfoRes.ok) {
          const profile = (await userInfoRes.json()) as {
            sub?: string;
            email?: string;
            name?: string;
          };
          sub = profile.sub;
          email = profile.email ?? null;
          name = profile.name ?? null;
        }
      }

      if (!sub && tokenJson.id_token) {
        const payload = decodeIdTokenPayload(tokenJson.id_token);
        sub = payload.sub;
        email = email ?? payload.email ?? null;
        name = name ?? payload.name ?? null;
      }

      if (!sub) {
        res.status(400).json({ error: "Google subject (sub) missing from user info" });
        return;
      }

      const openId = `google_${sub}`.slice(0, 64);
      const displayName = name || email || "Google User";

      await db.upsertUser({
        openId,
        name: displayName,
        email,
        loginMethod: "google",
        lastSignedIn: new Date(),
        ...(isPlatformAdminEmail(email) ? { role: "admin" as const } : {}),
      });

      const sessionToken = await sdk.createSessionToken(openId, {
        name: displayName,
        expiresInMs: ONE_YEAR_MS,
      });

      res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      const returnTo = sanitizeReturnTo(parsed.returnTo) || "/";
      res.redirect(302, returnTo);
    } catch (error) {
      console.error("[GoogleOAuth] Callback failed", error);
      res.status(500).json({ error: "Google OAuth callback failed" });
    }
  });
}
