import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { capLines, execOrThrow, stripAnsi, textResult } from "./lib/output";

const FALLBACK_TAIL_LINES = 15;

const factory: CustomToolFactory = pi => ({
	name: "typecheck",
	label: "Typecheck",
	summary: "Run the project's typecheck; prints ok or one line per type error",
	description: "Runs `bun run typecheck` (tsc --noEmit) and prints `ok`, or the error count and the errors, capped.",
	parameters: pi.zod.object({
		maxErrors: pi.zod.number().optional(),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
		const result = await execOrThrow(pi, "bun", ["run", "typecheck"], signal);
		if (result.code === 0) return textResult("ok");

		const lines = stripAnsi(`${result.stdout}\n${result.stderr}`).split("\n");
		const errors = lines.filter(line => /error TS\d+/.test(line));
		if (errors.length === 0) {
			return textResult([`exit=${result.code}`, ...lines.filter(Boolean).slice(-FALLBACK_TAIL_LINES)].join("\n"));
		}
		return textResult([`${errors.length} errors`, ...capLines(errors, params.maxErrors ?? 30)].join("\n"));
	},
});

export default factory;
