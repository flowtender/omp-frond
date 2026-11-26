import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWebAuthPolicy, verifyWebPassword, type WebAuthStoreOptions } from "../bin/web-auth-store.js";

export const WEB_SESSION_COOKIE = "omp-frond-session";
export const WEB_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export type WebAuthDecision = "allow" | "unauthorized" | "unavailable";

type Session = { credential: string; expiresAt: number };

function credentialIdentity(options: WebAuthStoreOptions): string | null {
  const policy = resolveWebAuthPolicy(options);
  if (policy.mode !== "stored" && policy.mode !== "environment") return null;
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function sessionPath(token: string, options: WebAuthStoreOptions): string | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const policy = resolveWebAuthPolicy(options);
  return join(`${policy.file}.sessions`, createHash("sha256").update(token).digest("hex"));
}

export function createWebSession(password: string, options: WebAuthStoreOptions = {}, now = Date.now()): string | null {
  const credential = credentialIdentity(options);
  if (!credential || !verifyWebPassword(password, options)) return null;
  const token = randomBytes(32).toString("hex");
  const path = sessionPath(token, options)!;
  mkdirSync(`${resolveWebAuthPolicy(options).file}.sessions`, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ credential, expiresAt: now + WEB_SESSION_TTL_SECONDS * 1000 }), { mode: 0o600, flag: "wx" });
  return token;
}

export function revokeWebSession(token: string | undefined, options: WebAuthStoreOptions = {}): void {
  const path = token ? sessionPath(token, options) : null;
  if (!path) return;
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function authorizeWebRequest(token: string | null, options: WebAuthStoreOptions = {}, now = Date.now()): WebAuthDecision {
  const policy = resolveWebAuthPolicy(options);
  if (policy.mode === "open") return "allow";
  if (policy.mode === "unavailable") return "unavailable";
  const path = token ? sessionPath(token, options) : null;
  if (!path) return "unauthorized";
  try {
    const session = JSON.parse(readFileSync(path, "utf8")) as Session;
    if (typeof session.expiresAt !== "number" || session.expiresAt <= now || session.credential !== credentialIdentity(options)) {
      revokeWebSession(token!, options);
      return "unauthorized";
    }
    return "allow";
  } catch {
    return "unauthorized";
  }
}

export function webSessionCookieOptions(request: Request) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.OMP_FROND_SECURE_COOKIES === "1" || Boolean(process.env.OMP_FROND_TLS_CERT) || new URL(request.url).protocol === "https:",
    path: "/",
    maxAge: WEB_SESSION_TTL_SECONDS,
  };
}
