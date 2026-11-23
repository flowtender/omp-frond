import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestAllowed, isApiRequestHostAllowed } from "@/lib/request-security";
import { authorizeWebRequest, WEB_SESSION_COOKIE } from "@/lib/web-auth";

const PUBLIC_PATHS: Record<string, true | undefined> = {
  "/login": true,
  "/recover": true,
  "/api/web-access/login": true,
  "/api/web-access/recovery": true,
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  if (!(isApiRequest ? isApiRequestAllowed(request) : isApiRequestHostAllowed(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (Object.hasOwn(PUBLIC_PATHS, pathname)) return NextResponse.next();
  const decision = authorizeWebRequest(request.cookies.get(WEB_SESSION_COOKIE)?.value ?? null);
  if (decision === "unavailable") {
    return new NextResponse("Password access is unavailable. Check the server credential file or reset the password on the server.", {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
  if (decision === "unauthorized") {
    if (isApiRequest) return NextResponse.json({ error: "Authentication required", loginPath: "/login" }, {
      status: 401, headers: { "Cache-Control": "no-store" },
    });
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl, { status: 307, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/recover", "/api/:path*"] };
