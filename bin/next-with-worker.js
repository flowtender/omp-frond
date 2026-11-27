"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const { join } = require("node:path");
const { withLoopbackNoProxy } = require("./runtime");
const { superviseWeb } = require("./worker-supervisor");
/* eslint-enable @typescript-eslint/no-require-imports */

const cwd = join(__dirname, "..");
const next = require.resolve("next/dist/bin/next", { paths: [cwd] });
superviseWeb({
  cwd,
  env: withLoopbackNoProxy(process.env),
  bunPath: process.execPath,
  nextArgs: ["--bun", next, ...process.argv.slice(2)],
}).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`Failed to launch omp-frond: ${error.message}`);
  process.exitCode = 1;
});
