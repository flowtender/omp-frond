import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setWebPassword, setWebPasswordEnabled, consumeRecoveryCode, issueRecoveryCode } from "../bin/web-auth-store.js";
import { authorizeWebRequest, createWebSession, revokeWebSession, WEB_SESSION_TTL_SECONDS } from "./web-auth.ts";

const PASSWORD = "a-long-enough-password";

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), "omp-session-"));
  const options = { file: join(directory, "auth.json"), env: {}, params: { cost: 16, keyLength: 32 } };
  try { return run(options); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("unconfigured servers allow access, but unreadable credentials fail closed", () => withStore((options) => {
  assert.equal(authorizeWebRequest(null, options), "allow");
  writeFileSync(options.file, "invalid json");
  assert.equal(authorizeWebRequest(null, options), "unavailable");
}));

test("only a correct password creates a session; missing, forged and basic-auth credentials are refused", () => withStore((options) => {
  setWebPassword(PASSWORD, options);
  assert.equal(createWebSession("wrong", options), null);
  assert.equal(authorizeWebRequest(null, options), "unauthorized");
  assert.equal(authorizeWebRequest("f".repeat(64), options), "unauthorized");
  assert.equal(authorizeWebRequest("../auth.json", options), "unauthorized");
  assert.equal(authorizeWebRequest(`Basic ${Buffer.from(`omp:${PASSWORD}`).toString("base64")}`, options), "unauthorized");
  const token = createWebSession(PASSWORD, options);
  assert.equal(authorizeWebRequest(token, options), "allow");
}));

test("sessions persist across reads, contain neither bearer token nor password on disk, and use private permissions", () => withStore((options) => {
  setWebPassword(PASSWORD, options);
  const token = createWebSession(PASSWORD, options);
  const directory = `${options.file}.sessions`;
  const path = join(directory, readdirSync(directory)[0]);
  const contents = readFileSync(path, "utf8");
  assert.equal(contents.includes(token), false);
  assert.equal(contents.includes(PASSWORD), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  assert.equal(authorizeWebRequest(token, { ...options }), "allow");
}));

test("expiration refuses access at the exact boundary", () => withStore((options) => {
  setWebPassword(PASSWORD, options);
  const now = 123456;
  const token = createWebSession(PASSWORD, options, now);
  const expiresAt = now + WEB_SESSION_TTL_SECONDS * 1000;
  assert.equal(authorizeWebRequest(token, options, expiresAt - 1), "allow");
  assert.equal(authorizeWebRequest(token, options, expiresAt), "unauthorized");
}));

test("logout revokes only its own session, including replay of a copied cookie", () => withStore((options) => {
  setWebPassword(PASSWORD, options);
  const first = createWebSession(PASSWORD, options);
  const second = createWebSession(PASSWORD, options);
  revokeWebSession(first, options);
  assert.equal(authorizeWebRequest(first, options), "unauthorized");
  assert.equal(authorizeWebRequest(second, options), "allow");
  revokeWebSession(first, options);
}));

test("password replacement and successful recovery invalidate existing sessions", () => withStore((options) => {
  setWebPassword(PASSWORD, options);
  const original = createWebSession(PASSWORD, options);
  setWebPassword("replacement-password", options);
  assert.equal(authorizeWebRequest(original, options), "unauthorized");
  const replacement = createWebSession("replacement-password", options);
  const code = issueRecoveryCode(options);
  assert.equal(code.ok, true);
  assert.equal(consumeRecoveryCode(code.code, PASSWORD, options).ok, true);
  assert.equal(authorizeWebRequest(replacement, options), "unauthorized");
}));

test("environment credentials take precedence and changing them invalidates sessions", () => withStore((options) => {
  setWebPassword(PASSWORD, options);
  const environment = { ...options, env: { OMP_FROND_PASSWORD: "environment-password" } };
  assert.equal(createWebSession(PASSWORD, environment), null);
  const token = createWebSession("environment-password", environment);
  assert.equal(authorizeWebRequest(token, environment), "allow");
  assert.equal(authorizeWebRequest(token, { ...options, env: { OMP_FROND_PASSWORD: "another-password" } }), "unauthorized");
  setWebPasswordEnabled(false, options);
  assert.equal(authorizeWebRequest(null, options), "allow");
}));
