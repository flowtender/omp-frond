#!/usr/bin/env node
"use strict";

const {
  getMissingBunMessage,
  getUnsupportedBunVersionMessage,
  getUnsupportedNodeVersionMessage,
  isBunVersionSupported,
  isNodeVersionSupported,
  resolveBunPath,
  withLoopbackNoProxy,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./runtime");

if (process.versions.bun && !isBunVersionSupported(process.versions.bun)) {
  console.error(getUnsupportedBunVersionMessage(process.versions.bun));
  process.exit(1);
}

if (!process.versions.bun && !isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseCommandLine, getHelpText } = require("./omp-frond-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { once } = require("events");
const {
  UPSTREAM_HOST,
  createTlsForwarder,
  loadTlsCredentials,
  reserveLoopbackPort,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./tls-forwarder");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { superviseWeb } = require("./worker-supervisor");
const {
  getWebAuthStatus,
  resolveWebAuthFile,
  setWebPassword,
  setWebPasswordEnabled,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./web-auth-store");
const {
  PromptAbortedError,
  isInteractive,
  readNewPassword,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./password-prompt");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx/bunx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // Fallback: locate next package root and derive the bin path manually.
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}


const launch = parseCommandLine();

// `omp-frond version` / `--help` must answer even without build artifacts.
if (launch.command === "version") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  console.log(require(path.join(pkgDir, "package.json")).version);
  process.exit(0);
}
if (launch.help) {
  console.log(getHelpText());
  process.exit(0);
}

const { port, hostname, openBrowser, authenticated, resetPassword } = launch;
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// Resolved once here and handed to the server through the environment, so the
// launcher and the Next.js process can never disagree about which credential
// file is in force.
const webAuthFile = resolveWebAuthFile();

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

const bunPath = resolveBunPath();
if (!bunPath) {
  console.error(getMissingBunMessage());
  process.exit(1);
}

// Certificate files are checked before any password prompt, so a bad pair
// stops the run before anything is written.
let tlsPaths = null;
let tlsCredentials = null;
if (launch.tls) {
  tlsPaths = { cert: path.resolve(launch.tls.cert), key: path.resolve(launch.tls.key) };
  try {
    tlsCredentials = loadTlsCredentials(tlsPaths);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

/** Refuse to hang on a password prompt nobody is there to answer. */
function requireTerminal(flag) {
  if (isInteractive()) return;
  throw new Error([
    `${flag} has to ask for a password, but omp-frond is not attached to a terminal.`,
    "Run omp-frond once interactively to set the password, or pass OMP_FROND_PASSWORD in the environment.",
  ].join("\n"));
}

async function setPasswordInteractively(intro) {
  console.log(intro);
  console.log(`It is stored as a scrypt hash in ${webAuthFile} — omp-frond never keeps the password itself.`);
  const password = await readNewPassword();
  setWebPassword(password, { file: webAuthFile });
  console.log("Password saved. Sign in with this password on the omp-frond login page.");
}

/**
 * Settle password access before the server starts.
 *
 * A run that was asked to be locked must never come up unlocked, so the
 * credential is written first and `next start` is spawned afterwards.
 */
async function configurePasswordAccess() {
  const status = getWebAuthStatus({ file: webAuthFile });

  if (resetPassword) {
    if (status.managedByEnvironment) {
      console.warn(
        "Warning: OMP_FROND_PASSWORD is set and takes precedence over the stored password. Unset it for this reset to have any effect.",
      );
    }
    requireTerminal("--reset-password");
    await setPasswordInteractively("Setting a new omp-frond password.");
    return;
  }

  if (!authenticated) return;

  if (status.managedByEnvironment) {
    console.log("Password access is already required: OMP_FROND_PASSWORD is set.");
    return;
  }
  if (status.stored) {
    if (!status.enabled) {
      setWebPasswordEnabled(true, { file: webAuthFile });
      console.log("Password access enabled with the password already stored on this machine.");
    }
    return;
  }

  requireTerminal("--authenticated");
  await setPasswordInteractively("--authenticated was requested and no omp-frond password has been set yet.");
}

function warnAboutExposure() {
  if (loopbackHostnames.has(hostname)) return;
  if (getWebAuthStatus({ file: webAuthFile }).enabled) {
    // TLS protects both the login password and session cookie in transit.
    if (!tlsCredentials) {
      console.warn(
        `Warning: omp-frond is listening on ${hostname} with password access over HTTP. Use HTTPS or a trusted VPN to protect the password and session cookie.`,
      );
    }
  } else {
    console.warn(
      `Warning: omp-frond is listening on ${hostname} without authentication. Only use this on a trusted network, or start it with --authenticated.`,
    );
  }
}

async function startServer() {
  warnAboutExposure();

  // With HTTPS the launcher owns the public listener and binds it first, so a
  // port clash fails before `next start` is spawned. Next then serves only on
  // loopback, on a port reserved here.
  const nextPort = tlsCredentials ? await reserveLoopbackPort() : port;
  let forwarder = null;
  if (tlsCredentials) {
    forwarder = createTlsForwarder({ credentials: tlsCredentials, upstreamPort: nextPort });
    forwarder.listen(Number(port), hostname);
    await once(forwarder, "listening");
  }

  // The TLS pair is the signal the server reads for secure cookies. It is set
  // only when this run serves HTTPS, so an ambient value cannot claim HTTPS.
  const childEnv = { ...withLoopbackNoProxy(process.env) };
  delete childEnv.OMP_FROND_TLS_CERT;
  delete childEnv.OMP_FROND_TLS_KEY;
  if (tlsPaths) {
    childEnv.OMP_FROND_TLS_CERT = tlsPaths.cert;
    childEnv.OMP_FROND_TLS_KEY = tlsPaths.key;
  }

  const nextHost = forwarder ? UPSTREAM_HOST : hostname;
  let browserOpened = false;
  const url = tlsCredentials ? `https://${hostname}:${port}` : `http://${hostname}:${port}`;

  const onWebOutput = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!browserOpened && text.includes("Ready")) {
      browserOpened = true;
      if (tlsCredentials) console.log(`omp-frond HTTPS: ${url}`);
      if (!openBrowser) return;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
      const opener = spawn(openCmd, [url], {
        shell: isWindows,
        stdio: "ignore",
        detached: true,
      });

      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });

      opener.unref();
    }
  };

  try {
    process.exitCode = await superviseWeb({
      bunPath,
      cwd: pkgDir,
      nextArgs: ["--bun", nextBin, "start", "-p", String(nextPort), "-H", nextHost],
      onWebOutput,
      env: {
        ...childEnv,
        OMP_FROND_HOSTNAME: hostname,
        OMP_FROND_AUTH_FILE: webAuthFile,
        // Relative project paths start at the directory `omp-frond` was launched from.
        OMP_FROND_LAUNCH_CWD: process.cwd(),
      },
    });
  } finally {
    forwarder?.close();
  }
}

configurePasswordAccess().then(startServer).catch((error) => {
  if (error instanceof PromptAbortedError) process.exit(130);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
