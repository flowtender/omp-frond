import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("code fences preserve numbered source before the first grammar load, then highlight it", () => {
  // Other render tests load Prism's process-wide registry. Exercise a genuinely cold page.
  execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/prism-cold.mjs", import.meta.url))], { stdio: "pipe" });
});
