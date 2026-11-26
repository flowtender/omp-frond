// Shared helpers for the compact agent tools in the parent directory.
// Lives in a subdirectory without an index.ts so omp does not load it as a tool.
import type { CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

export function capLines(lines: string[], max: number): string[] {
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), `+${lines.length - max} more`];
}

export function textResult(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

// gitnexus may print log lines ahead of its JSON; the document starts at a line that is only "{".
// T is the caller's description of the CLI's documented output; it is not validated at runtime.
export function parseJsonDocument<T>(stdout: string): T {
	const start = stdout.search(/^\{\s*$/m);
	if (start === -1) throw new Error(stdout.trim().slice(0, 300) || "no JSON in output");
	return JSON.parse(stdout.slice(start)) as T;
}

export async function execOrThrow(
	pi: CustomToolAPI,
	command: string,
	args: string[],
	signal: AbortSignal | undefined,
) {
	const result = await pi.exec(command, args, { signal, cwd: pi.cwd });
	if (result.killed) throw new Error(`${command} was cancelled`);
	return result;
}
