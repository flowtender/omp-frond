import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { capLines, execOrThrow, parseJsonDocument, textResult } from "./lib/output";

const MAX_SYMBOLS = 25;
const MAX_FLOWS = 10;

interface ChangesReport {
	summary?: { risk_level?: string; changed_count?: number; affected_count?: number; changed_files?: number };
	changed_symbols?: { name: string; filePath: string }[];
	affected_processes?: { name: string }[];
}

const factory: CustomToolFactory = pi => ({
	name: "changes",
	label: "Changes",
	summary: "Risk and affected flows of the uncommitted diff, mapped to indexed symbols",
	description:
		"Runs gitnexus detect-changes and prints the risk level, counts, changed symbols and affected execution flows in a few lines.",
	parameters: pi.zod.object({
		scope: pi.zod.enum(["unstaged", "staged", "all", "compare"]).optional(),
		baseRef: pi.zod.string().optional(),
		repo: pi.zod.string().optional(),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
		const args = ["detect-changes", "--scope", params.scope ?? "all"];
		if (params.baseRef) args.push("--base-ref", params.baseRef);
		if (params.repo) args.push("--repo", params.repo);
		const result = await execOrThrow(pi, "gitnexus", args, signal);

		let report: ChangesReport;
		try {
			report = parseJsonDocument<ChangesReport>(result.stdout);
		} catch {
			// gitnexus prints plain text such as "No changes detected." when there is nothing to map
			return textResult(result.stdout.trim() || result.stderr.trim());
		}

		const summary = report.summary ?? {};
		const symbols = (report.changed_symbols ?? []).map(symbol => `${symbol.name} (${symbol.filePath})`);
		const flows = (report.affected_processes ?? []).map(flow => flow.name);
		const lines = [
			`risk=${summary.risk_level} changed=${summary.changed_count} affected=${summary.affected_count} files=${summary.changed_files}`,
		];
		if (symbols.length) lines.push(`symbols: ${capLines(symbols, MAX_SYMBOLS).join(", ")}`);
		if (flows.length) lines.push(`flows: ${capLines(flows, MAX_FLOWS).join(", ")}`);
		return textResult(lines.join("\n"));
	},
});

export default factory;
