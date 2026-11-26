import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { capLines, execOrThrow, stripAnsi, textResult } from "./lib/output";

const LOG_PATH = join(tmpdir(), "omp-frond-runtests.log");
const MAX_FAILURE_DETAIL_LINES = 30;
const FALLBACK_TAIL_LINES = 15;

// Named runtests, not test: a mounted tool shadows a shell command of the same name, and `test` is a bash builtin.
const factory: CustomToolFactory = pi => ({
	name: "runtests",
	label: "Run tests",
	summary: "Run the project's tests on given files; prints pass/fail counts and only the failures",
	description:
		"Runs `bun run test` (the project's parallel runner) on the given test files or directories, or everything when none are given. Prints pass/fail counts and the failing test names with their assertion lines; the full log goes to a temp file.",
	parameters: pi.zod.object({
		files: pi.zod.array(pi.zod.string()).optional(),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
		const result = await execOrThrow(pi, "bun", ["run", "test", ...(params.files ?? [])], signal);
		const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
		writeFileSync(LOG_PATH, output);
		const lines = output.split("\n");

		const counts = lines.filter(line => /^\s*\d+ (pass|fail|skip)\b/.test(line) || /^Ran \d+ tests?/.test(line));
		const failures = lines.filter(line => /^\(fail\)/.test(line));
		const detail = lines.filter(line => /error:|Expected|Received|expect\(/.test(line));

		if (counts.length === 0) {
			const tail = lines.filter(Boolean).slice(-FALLBACK_TAIL_LINES);
			return textResult([`exit=${result.code} (unrecognised output)`, ...tail, `log: ${LOG_PATH}`].join("\n"));
		}

		const report = [`exit=${result.code} ${counts.map(line => line.trim()).join(", ")}`];
		if (failures.length) report.push(...capLines(failures, MAX_FAILURE_DETAIL_LINES));
		if (failures.length && detail.length) report.push(...capLines(detail, MAX_FAILURE_DETAIL_LINES));
		if (failures.length) report.push(`log: ${LOG_PATH}`);
		return textResult(report.join("\n"));
	},
});

export default factory;
