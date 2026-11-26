// Loaded before the test files (bunfig.toml `[test] preload`). Points omp's
// agent directory at a throwaway one, so no test can read or write the real
// ~/.omp/agent: omp's SDK freezes PI_CODING_AGENT_DIR when it first loads, and
// a test that never sets the variable would otherwise get the user's own.
// `--parallel` re-runs this in every file's fresh global, so each process makes
// its directory once. Workers are stopped without an `exit` event, so a
// directory is removed by whichever later run finds its process gone.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDirsRoot = join(tmpdir(), "omp-frond-test-agents");
const agentDir = join(agentDirsRoot, String(process.pid));

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

if (!existsSync(agentDir)) {
  mkdirSync(agentDir, { recursive: true });
  for (const name of readdirSync(agentDirsRoot)) {
    if (!isRunning(Number(name))) rmSync(join(agentDirsRoot, name), { recursive: true, force: true });
  }
}
process.env.PI_CODING_AGENT_DIR = agentDir;
