import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { capLines, execOrThrow, parseJsonDocument, textResult } from "./lib/output";

const MAX_CALLERS = 8;
const MAX_FLOWS = 5;

interface ImpactReport {
	risk: string;
	summary?: { direct?: number; processes_affected?: number; modules_affected?: number };
	affected_processes?: { name: string }[];
	byDepth?: Record<string, { filePath: string }[]>;
	staleness?: { status: string; commitsBehind: number };
}

const factory: CustomToolFactory = pi => ({
	name: "impact",
	label: "Impact",
	summary: "Blast radius of changing one or more symbols: risk, direct callers, affected flows (one line each)",
	description:
		"Runs gitnexus impact for each symbol and prints one line per symbol: risk, direct caller count, affected flows and modules, and the direct callers' files. Use before editing a shared contract.",
	parameters: pi.zod.object({
		symbols: pi.zod.array(pi.zod.string()),
		direction: pi.zod.enum(["upstream", "downstream"]).optional(),
		repo: pi.zod.string().optional(),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
		const lines: string[] = [];
		for (const symbol of params.symbols) {
			const args = ["impact", symbol, "--direction", params.direction ?? "upstream"];
			if (params.repo) args.push("--repo", params.repo);
			const result = await execOrThrow(pi, "gitnexus", args, signal);
			try {
				lines.push(summarizeImpact(symbol, parseJsonDocument<ImpactReport>(result.stdout)));
			} catch {
				lines.push(`${symbol}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
			}
		}
		return textResult(lines.join("\n"));
	},
});

function summarizeImpact(symbol: string, report: ImpactReport): string {
	const direct = report.summary?.direct ?? 0;
	const flows = (report.affected_processes ?? []).map(flow => flow.name);
	const callerFiles = [...new Set((report.byDepth?.["1"] ?? []).map(node => node.filePath))];
	const parts = [
		`${symbol} ${report.risk} direct=${direct} flows=${report.summary?.processes_affected ?? 0} modules=${report.summary?.modules_affected ?? 0}`,
	];
	if (callerFiles.length) parts.push(`callers: ${capLines(callerFiles, MAX_CALLERS).join(", ")}`);
	if (flows.length) parts.push(`flows: ${capLines(flows, MAX_FLOWS).join(", ")}`);
	if (report.staleness?.status === "behind") parts.push(`index ${report.staleness.commitsBehind} commits behind`);
	return parts.join(" | ");
}

export default factory;
