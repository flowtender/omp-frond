import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { capLines, execOrThrow, textResult } from "./lib/output";

const DEFAULT_REPO = "can1357/oh-my-pi";
const MAX_COMMITS = 20;
const MAX_FILES = 60;

interface Comparison {
	status: string;
	total_commits: number;
	commits?: { sha: string; commit: { message: string } }[];
	files?: { filename: string; additions: number; deletions: number }[];
}

const factory: CustomToolFactory = pi => ({
	name: "upstream",
	label: "Upstream diff",
	summary: "Compare two upstream release tags: commit subjects and changed files with +/- counts",
	description: `Compares two tags of ${DEFAULT_REPO} (or another repo) through the GitHub compare API and prints status, commit subjects and per-file additions/deletions.`,
	parameters: pi.zod.object({
		from: pi.zod.string(),
		to: pi.zod.string(),
		repo: pi.zod.string().optional(),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
		const repo = params.repo ?? DEFAULT_REPO;
		const result = await execOrThrow(pi, "gh", ["api", `repos/${repo}/compare/${params.from}...${params.to}`], signal);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "gh api failed");
		const comparison = JSON.parse(result.stdout) as Comparison; // gh api returns GitHub's documented compare shape

		const commits = (comparison.commits ?? []).map(commit => `${commit.sha.slice(0, 8)} ${commit.commit.message.split("\n")[0]}`);
		const files = (comparison.files ?? []).map(file => `${file.filename} +${file.additions} -${file.deletions}`);
		return textResult(
			[
				`${comparison.status} commits=${comparison.total_commits} files=${files.length}`,
				...capLines(commits, MAX_COMMITS),
				"--",
				...capLines(files, MAX_FILES),
			].join("\n"),
		);
	},
});

export default factory;
