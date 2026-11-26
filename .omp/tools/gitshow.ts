import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { capLines, execOrThrow, textResult } from "./lib/output";

const DEFAULT_MAX_LINES = 200;

const factory: CustomToolFactory = pi => ({
	name: "gitshow",
	label: "Git show",
	summary: "Compact git show: stat by default, or one file's diff at a revision, capped",
	description:
		"Without `file`: the commit's author, date, message and diffstat. With `file`: that file's diff in the commit, capped at maxLines. Read-only.",
	parameters: pi.zod.object({
		rev: pi.zod.string(),
		file: pi.zod.string().optional(),
		maxLines: pi.zod.number().optional(),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
		const args = params.file
			? ["--no-pager", "show", "--format=%h %s", params.rev, "--", params.file]
			: ["--no-pager", "show", "--stat", "--date=short", "--format=%h %an %ad%n%s%n%b", params.rev];
		const result = await execOrThrow(pi, "git", args, signal);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "git show failed");
		const lines = result.stdout.trimEnd().split("\n");
		return textResult(capLines(lines, params.maxLines ?? DEFAULT_MAX_LINES).join("\n"));
	},
});

export default factory;
