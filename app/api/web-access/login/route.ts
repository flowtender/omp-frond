import { NextResponse } from "next/server";
import { getAuthRetryAfterMs, recordAuthFailure, retryAfterSeconds } from "@/lib/auth-throttle";
import { hasJsonContentType } from "@/lib/request-security";
import { createWebSession, WEB_SESSION_COOKIE, webSessionCookieOptions } from "@/lib/web-auth";
import { resolveWebAuthPolicy } from "@/bin/web-auth-store.js";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  const retryAfterMs = getAuthRetryAfterMs();
  if (retryAfterMs > 0) return NextResponse.json({ error: "Too many failed attempts. Try again shortly." }, {
    status: 429, headers: { "Retry-After": String(retryAfterSeconds(retryAfterMs)), "Cache-Control": "no-store" },
  });
  let body: { password?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  if (!body || typeof body.password !== "string" || body.password.length > 256) {
    return NextResponse.json({ error: "Enter your password." }, { status: 400 });
  }
  const policy = resolveWebAuthPolicy();
  if (policy.mode === "unavailable") return NextResponse.json({ error: "Password access is unavailable. Reset the password on the server." }, { status: 503 });
  if (policy.mode === "open") return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  const token = createWebSession(body.password);
  if (!token) {
    recordAuthFailure();
    return NextResponse.json({ error: "Incorrect password." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(WEB_SESSION_COOKIE, token, webSessionCookieOptions(request));
  return response;
}
