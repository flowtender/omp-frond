import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/omp-frond-options.js");

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    help: false,
    port: "30141",
    hostname: "127.0.0.1",
    openBrowser: true,
    authenticated: false,
    resetPassword: false,
    tls: null,
  });
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy OMP_WEB_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { OMP_WEB_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false OMP_WEB_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { OMP_WEB_NO_OPEN: value }).openBrowser, true);
  }
});

test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {}),
    {
      help: false,
      port: "8080",
      hostname: "0.0.0.0",
      openBrowser: true,
      authenticated: false,
      resetPassword: false,
      tls: null,
    },
  );
});

test("supports OMP_WEB_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { OMP_WEB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});

test("forces password access with --authenticated or OMP_WEB_AUTHENTICATED", () => {
  assert.equal(parseLaunchOptions(["--authenticated"], {}).authenticated, true);
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { OMP_WEB_AUTHENTICATED: value }).authenticated, true);
  }
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { OMP_WEB_AUTHENTICATED: value }).authenticated, false);
  }
});

test("requests a password reset only from the CLI flag", () => {
  assert.equal(parseLaunchOptions(["--reset-password"], {}).resetPassword, true);
  assert.equal(parseLaunchOptions([], { OMP_WEB_RESET_PASSWORD: "1" }).resetPassword, false);
});

test("enables HTTPS from --tls-cert and --tls-key", () => {
  assert.deepEqual(
    parseLaunchOptions(["--tls-cert", "cert.pem", "--tls-key", "key.pem"], {}).tls,
    { cert: "cert.pem", key: "key.pem" },
  );
});

test("reads HTTPS paths from OMP_WEB_TLS_CERT and OMP_WEB_TLS_KEY", () => {
  assert.deepEqual(
    parseLaunchOptions([], { OMP_WEB_TLS_CERT: "/certs/c.pem", OMP_WEB_TLS_KEY: "/certs/k.pem" }).tls,
    { cert: "/certs/c.pem", key: "/certs/k.pem" },
  );
});

test("prefers CLI TLS paths over environment values", () => {
  assert.deepEqual(
    parseLaunchOptions(["--tls-cert", "a.pem", "--tls-key", "a.key"], {
      OMP_WEB_TLS_CERT: "b.pem",
      OMP_WEB_TLS_KEY: "b.key",
    }).tls,
    { cert: "a.pem", key: "a.key" },
  );
});

test("keeps plain HTTP when TLS paths are absent or blank", () => {
  assert.equal(parseLaunchOptions([], {}).tls, null);
  assert.equal(parseLaunchOptions([], { OMP_WEB_TLS_CERT: "  ", OMP_WEB_TLS_KEY: "" }).tls, null);
});

test("requires the certificate and private key together", () => {
  assert.throws(
    () => parseLaunchOptions(["--tls-cert", "cert.pem"], {}),
    /needs both a certificate and a private key/,
  );
  assert.throws(
    () => parseLaunchOptions([], { OMP_WEB_TLS_KEY: "key.pem" }),
    /needs both a certificate and a private key/,
  );
  assert.throws(
    () => parseLaunchOptions(["--tls-key", "key.pem"], { OMP_WEB_TLS_CERT: "  " }),
    /needs both a certificate and a private key/,
  );
});
