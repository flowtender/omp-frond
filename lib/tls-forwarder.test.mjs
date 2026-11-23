import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createTlsForwarder, loadTlsCredentials, reserveLoopbackPort } = require("../bin/tls-forwarder.js");

// Certificates are generated per run, so no key material lives in the repo.
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const opensslSkip = hasOpenssl ? false : "openssl is required to generate a test certificate";

function makeCertificate(dir, name) {
  const cert = join(dir, `${name}-cert.pem`);
  const key = join(dir, `${name}-key.pem`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { cert, key };
}

const workDir = hasOpenssl ? mkdtempSync(join(tmpdir(), "omp-web-tls-test-")) : null;
if (workDir) process.once("exit", () => rmSync(workDir, { recursive: true, force: true }));
const pair = hasOpenssl ? makeCertificate(workDir, "primary") : null;
const otherPair = hasOpenssl ? makeCertificate(workDir, "other") : null;
const ca = hasOpenssl ? readFileSync(pair.cert) : null;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function startForwarder(upstreamPort) {
  const credentials = loadTlsCredentials(pair);
  return createTlsForwarder({ credentials, upstreamPort });
}

function httpsRequest({ port, method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port, method, path, headers, ca, servername: "localhost", agent: false },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("loadTlsCredentials names a missing certificate file", { skip: opensslSkip }, () => {
  assert.throws(
    () => loadTlsCredentials({ cert: "/nonexistent/omp-cert.pem", key: pair.key }),
    /Cannot read the TLS certificate file \/nonexistent\/omp-cert\.pem: no such file/,
  );
});

test("loadTlsCredentials names an unreadable private key file", { skip: opensslSkip }, () => {
  assert.throws(
    () => loadTlsCredentials({ cert: pair.cert, key: "/nonexistent/omp-key.pem" }),
    /Cannot read the TLS private key file \/nonexistent\/omp-key\.pem: no such file/,
  );
});

test("loadTlsCredentials rejects a certificate and key that do not match", { skip: opensslSkip }, () => {
  assert.throws(
    () => loadTlsCredentials({ cert: pair.cert, key: otherPair.key }),
    /do not form a usable pair/,
  );
});

test("loadTlsCredentials rejects a key file that is not PEM", { skip: opensslSkip }, () => {
  const bogus = join(workDir, "bogus-key.pem");
  writeFileSync(bogus, "not a key\n");
  assert.throws(() => loadTlsCredentials({ cert: pair.cert, key: bogus }), /do not form a usable pair/);
});

test("reserveLoopbackPort returns a free loopback port number", async () => {
  const port = await reserveLoopbackPort();
  assert.equal(typeof port, "number");
  assert.ok(port > 0 && port <= 65535);
});

test("forwards requests and responses over HTTPS unchanged", { skip: opensslSkip }, async () => {
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(201, { "content-type": "text/plain", "x-upstream": "yes" });
      res.end(`${req.method} ${req.url} host=${req.headers.host} body=${body}`);
    });
  });
  const upstreamPort = await listen(upstream);
  const forwarder = startForwarder(upstreamPort);
  const port = await listen(forwarder);

  try {
    const response = await httpsRequest({
      port,
      method: "POST",
      path: "/api/items?limit=1",
      headers: { host: "example.test:30141" },
      body: "hello",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers["x-upstream"], "yes");
    assert.equal(response.body, "POST /api/items?limit=1 host=example.test:30141 body=hello");
  } finally {
    await close(forwarder);
    await close(upstream);
  }
});

test("streams chunks as they arrive rather than buffering the whole response", { skip: opensslSkip }, async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => res.end("data: two\n\n"), 150);
  });
  const upstreamPort = await listen(upstream);
  const forwarder = startForwarder(upstreamPort);
  const port = await listen(forwarder);

  try {
    const arrivals = await new Promise((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port, path: "/events", ca, servername: "localhost", agent: false },
        (res) => {
          const times = [];
          res.setEncoding("utf8");
          res.on("data", () => times.push(Date.now()));
          res.on("end", () => resolve(times));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(arrivals.length, 2);
    assert.ok(arrivals[1] - arrivals[0] >= 100, `chunks arrived ${arrivals[1] - arrivals[0]}ms apart`);
  } finally {
    await close(forwarder);
    await close(upstream);
  }
});

test("answers 502 when the upstream is not listening", { skip: opensslSkip }, async () => {
  const deadPort = await reserveLoopbackPort();
  const forwarder = startForwarder(deadPort);
  const port = await listen(forwarder);

  try {
    const response = await httpsRequest({ port, path: "/" });
    assert.equal(response.status, 502);
    assert.match(response.body, /not reachable on its local port/);
  } finally {
    await close(forwarder);
  }
});

test("pipes WebSocket-style upgrades through to the upstream", { skip: opensslSkip }, async () => {
  const upstream = http.createServer();
  let upstreamSocket;
  upstream.on("upgrade", (req, socket) => {
    upstreamSocket = socket;
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    socket.on("error", () => {});
  });
  const upstreamPort = await listen(upstream);
  const forwarder = startForwarder(upstreamPort);
  const port = await listen(forwarder);

  try {
    const reply = await new Promise((resolve, reject) => {
      const req = https.request({
        host: "127.0.0.1",
        port,
        path: "/ws",
        headers: { connection: "Upgrade", upgrade: "echo" },
        ca,
        servername: "localhost",
        agent: false,
      });
      req.on("error", reject);
      req.on("upgrade", (res, socket) => {
        socket.once("data", (chunk) => {
          resolve(chunk.toString());
          socket.destroy();
        });
        socket.write("ping");
      });
      req.end();
    });
    assert.equal(reply, "echo:ping");
  } finally {
    upstreamSocket?.destroy();
    await close(forwarder);
    await close(upstream);
  }
});
