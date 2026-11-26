import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as login } from "../app/api/web-access/login/route.ts";
import { POST as logout } from "../app/api/web-access/logout/route.ts";
import { proxy } from "../proxy.ts";
import { recordAuthFailure, recordAuthSuccess } from "./auth-throttle.ts";
import { setWebPassword } from "../bin/web-auth-store.js";

function request(path, body, cookie, secure = false) {
  return new NextRequest(`${secure ? "https" : "http"}://localhost:30141${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost:30141", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("a backoff imposed during body parsing applies to the pending login", async () => {
  recordAuthSuccess();
  try {
    const pending = login(request("/api/web-access/login", { password: "example" }));
    // Model another handler recording a failure before the body read resumes.
    recordAuthFailure();
    const response = await pending;
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.has("set-cookie"), false);
  } finally {
    recordAuthSuccess();
  }
});

test("login issues persistent cookies, throttles guesses, protects APIs, and logout prevents replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-login-"));
  const previous = { file: process.env.OMP_WEB_AUTH_FILE, password: process.env.OMP_WEB_PASSWORD, secure: process.env.OMP_WEB_SECURE_COOKIES, cert: process.env.OMP_WEB_TLS_CERT };
  try {
    process.env.OMP_WEB_AUTH_FILE = join(directory, "auth.json");
    delete process.env.OMP_WEB_PASSWORD;
    delete process.env.OMP_WEB_SECURE_COOKIES;
    delete process.env.OMP_WEB_TLS_CERT;
    recordAuthSuccess();
    setWebPassword("correct-password");
    const deniedPage = proxy(request("/?session=example"));
    assert.equal(deniedPage.status, 307);
    assert.equal(new URL(deniedPage.headers.get("location")).pathname, "/login");
    assert.equal(new URL(deniedPage.headers.get("location")).searchParams.get("next"), "/?session=example");
    const deniedApi = proxy(request("/api/web-access"));
    assert.equal(deniedApi.status, 401);
    assert.equal(deniedApi.headers.has("www-authenticate"), false);
    assert.equal(proxy(request("/login")).headers.get("x-middleware-next"), "1");
    const crossSite = request("/api/web-access/login", { password: "correct-password" });
    crossSite.headers.set("sec-fetch-site", "cross-site");
    assert.equal(proxy(crossSite).status, 403);
    assert.equal((await login(request("/api/web-access/login", { password: "wrong-password" }))).status, 401);
    const blocked = await login(request("/api/web-access/login", { password: "correct-password" }));
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    recordAuthSuccess();
    const accepted = await login(request("/api/web-access/login", { password: "correct-password" }));
    assert.equal(accepted.status, 200);
    const setCookie = accepted.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=strict/i);
    assert.match(setCookie, /Max-Age=2592000/i);
    assert.doesNotMatch(setCookie, /; Secure/i);
    const cookie = setCookie.split(";")[0];
    assert.equal(proxy(request("/api/web-access", undefined, cookie)).headers.get("x-middleware-next"), "1");
    const secureLogin = await login(request("/api/web-access/login", { password: "correct-password" }, undefined, true));
    assert.match(secureLogin.headers.get("set-cookie"), /; Secure/i);
    process.env.OMP_WEB_SECURE_COOKIES = "1";
    const proxiedLogin = await login(request("/api/web-access/login", { password: "correct-password" }));
    assert.match(proxiedLogin.headers.get("set-cookie"), /; Secure/i);
    const signedOut = await logout(request("/api/web-access/logout", {}, cookie));
    assert.match(signedOut.headers.get("set-cookie"), /Max-Age=0/i);
    assert.equal(proxy(request("/api/web-access", undefined, cookie)).status, 401);
  } finally {
    for (const [key, value] of Object.entries({ OMP_WEB_AUTH_FILE: previous.file, OMP_WEB_PASSWORD: previous.password, OMP_WEB_SECURE_COOKIES: previous.secure, OMP_WEB_TLS_CERT: previous.cert })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    recordAuthSuccess();
    rmSync(directory, { recursive: true, force: true });
  }
});
