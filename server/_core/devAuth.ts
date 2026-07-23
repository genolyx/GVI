/**
 * Local development-only login bypass endpoint.
 * Active only when NODE_ENV=development and DEV_AUTH=true.
 * Never activated in a production build.
 */

import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

const isDevAuthEnabled =
  process.env.NODE_ENV === "development" && process.env.DEV_AUTH === "true";

export function registerDevAuthRoutes(app: Express) {
  if (!isDevAuthEnabled) return;

  console.log(
    "[DevAuth] ⚠️  Dev login enabled — /api/dev/login is active. NEVER use in production."
  );

  /**
   * POST /api/dev/login
   * Body: { openId?: string, name?: string, email?: string }
   *
   * Issues a session cookie immediately without external OAuth.
   * Falls back to "dev_local_user" if openId is omitted.
   */
  app.post("/api/dev/login", async (req: Request, res: Response) => {
    const openId: string = req.body?.openId ?? "dev_local_user";
    const name: string = req.body?.name ?? "Dev User";
    const email: string | null = req.body?.email ?? "dev@localhost";

    try {
      await db.upsertUser({
        openId,
        name,
        email,
        loginMethod: "dev",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(openId, {
        name,
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      res.json({ success: true, openId, name });
    } catch (error) {
      console.error("[DevAuth] Login failed", error);
      res.status(500).json({ error: "Dev login failed", detail: String(error) });
    }
  });

  /**
   * POST /api/dev/logout
   */
  app.post("/api/dev/logout", (req: Request, res: Response) => {
    const cookieOptions = getSessionCookieOptions(req);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    res.json({ success: true });
  });
}
