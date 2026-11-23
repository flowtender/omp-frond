import { NextResponse, type NextRequest } from "next/server";
import { revokeWebSession, WEB_SESSION_COOKIE, webSessionCookieOptions } from "@/lib/web-auth";

export async function POST(request: NextRequest) {
  revokeWebSession(request.cookies.get(WEB_SESSION_COOKIE)?.value);
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(WEB_SESSION_COOKIE, "", { ...webSessionCookieOptions(request), maxAge: 0 });
  return response;
}
