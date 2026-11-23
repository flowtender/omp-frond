"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require("https");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("net");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tls = require("tls");

// Next.js only serves plain HTTP, so the launcher terminates TLS itself and
// hands every request to a loopback-only `next start`. The upstream never
// listens on the public interface.
const UPSTREAM_HOST = "127.0.0.1";

function readCredentialFile(label, file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    const reason = error.code === "ENOENT" ? "no such file" : error.message;
    throw new Error(`Cannot read the TLS ${label} file ${file}: ${reason}`);
  }
}

/**
 * Reads the caller-supplied certificate and private key. `createSecureContext`
 * parses both PEM blocks and checks that the key matches the certificate, so a
 * bad or mismatched pair fails here, before Next.js starts or a password is set.
 */
function loadTlsCredentials({ cert, key }) {
  const credentials = {
    cert: readCredentialFile("certificate", cert),
    key: readCredentialFile("private key", key),
  };

  try {
    tls.createSecureContext(credentials);
  } catch (error) {
    throw new Error(
      `The TLS certificate (${cert}) and private key (${key}) do not form a usable pair: ${error.message}`,
    );
  }

  return credentials;
}

function forwardRequest(req, res, upstreamPort) {
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    // Host and forwarding headers pass through unchanged. The launcher adds
    // nothing and trusts nothing here; the scheme signal reaches the server
    // through its environment, not through request headers.
    headers: req.headers,
  });

  upstream.on("response", (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
    // Send headers now so streamed responses (SSE) reach the client immediately.
    res.flushHeaders();
    upstreamRes.pipe(res);
  });

  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("omp-web is not reachable on its local port.\n");
  });

  // Client went away before the response finished: stop the upstream work too.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.on("error", () => upstream.destroy());

  req.pipe(upstream);
}

function forwardUpgrade(req, socket, head, upstreamPort) {
  const upstream = net.connect(upstreamPort, UPSTREAM_HOST, () => {
    // Replay the original request line and raw headers so the upgrade handshake
    // reaches Next byte-for-byte, then splice the two sockets together.
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const teardown = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", teardown);
  socket.on("error", teardown);
  upstream.on("end", teardown);
  socket.on("end", teardown);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}

/**
 * Builds an HTTPS server that forwards to `upstreamPort` on loopback. The
 * caller listens on the public address and starts `next start` on the upstream
 * port. Throws if the credentials cannot be used to build a TLS context.
 */
function createTlsForwarder({ credentials, upstreamPort }) {
  let server;
  try {
    server = https.createServer(credentials, (req, res) => forwardRequest(req, res, upstreamPort));
  } catch (error) {
    throw new Error(`Cannot start the HTTPS listener: ${error.message}`);
  }

  server.on("upgrade", (req, socket, head) => forwardUpgrade(req, socket, head, upstreamPort));
  return server;
}

/**
 * Asks the OS for a free loopback port. There is a small window before Next
 * binds it; if another process takes it first, Next exits with EADDRINUSE and
 * the launcher exits with that code.
 */
function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, UPSTREAM_HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = {
  UPSTREAM_HOST,
  createTlsForwarder,
  loadTlsCredentials,
  reserveLoopbackPort,
};
