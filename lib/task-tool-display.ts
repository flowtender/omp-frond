import { shellToolDispatches } from "./inline-tool-display";
import type { AgentMessage, CustomMessage, ToolResultMessage } from "./types";

type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface TaskResultCard {
  tool?: "bash" | "task" | "eval";
  id: string;
  label: string;
  target: string;
  status: TaskStatus;
  durationMs?: number;
  output: string;
  error?: string;
}

interface AsyncResultCard extends TaskResultCard {
  tool: "bash" | "task" | "eval";
  agentId: string;
}

const deferredCards = Symbol("deferred task result cards");
type ToolResultWithCards = ToolResultMessage & { [deferredCards]?: Map<number, TaskResultCard[]> };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function status(value: unknown): TaskStatus | undefined {
  switch (value) {
    case "pending": case "running": case "completed": case "failed": case "cancelled": case "interrupted": return value;
    case "aborted": return "cancelled";
  }
}

function duration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// omp emits this envelope as text, not XML: the agent's output can contain arbitrary markup.
function taskEnvelope(result: string, id: string) {
  const open = /^<task-result id="([^"]+)" agent="([^"]+)" status="([^"]+)"[^\n]*>\r?\n/.exec(result);
  const end = result.lastIndexOf("\n</task-result>");
  if (!open || open[1] !== id || end < open[0].length) return undefined;
  const body = result.slice(open[0].length, end);
  const output = /^<(output|preview)(?: ([^\n]*))?>\r?\n/m.exec(body);
  if (!output) return undefined;
  const close = body.lastIndexOf(`\n</${output[1]}>`);
  if (close < output.index + output[0].length) return undefined;
  const before = body.slice(0, output.index);
  const after = body.slice(close + output[1].length + 4);
  const previewPointer = /^full-output="(agent:\/\/[^"\n]+)"$/.exec(output[2] ?? "")?.[1];
  return {
    label: open[2],
    cancelled: open[3] === "cancelled",
    output: [body.slice(output.index + output[0].length, close).trim(), previewPointer && `\`${previewPointer}\``,
      /<merge-summary>\s*([\s\S]*?)\s*<\/merge-summary>/.exec(after)?.[1]].filter(Boolean).join("\n\n"),
    error: /<(error|abort-reason)>([\s\S]*?)<\/\1>/.exec(before)?.[2],
  };
}

export function taskToolCards(tool: string, details: unknown, output: string, result?: ToolResultMessage, slot = -1): TaskResultCard[] {
  const data = record(details);
  if (!data) return [];
  const cards: TaskResultCard[] = [];
  if (tool === "task" && Array.isArray(data.results)) {
    for (const value of data.results) {
      const child = record(value);
      if (!child || typeof child.id !== "string" || typeof child.agent !== "string" || typeof child.exitCode !== "number") continue;
      const error = text(child.abortReason) || text(child.error) || (child.exitCode !== 0 ? text(child.stderr) : "");
      cards.push({ id: child.id, label: child.agent, target: text(child.description) || text(child.assignment) || child.id,
        status: child.aborted === true ? "cancelled" : child.exitCode !== 0 || child.error ? "failed" : "completed",
        durationMs: duration(child.durationMs), output: text(child.output) || text(child.stderr), error });
    }
    const deferred = (result as ToolResultWithCards | undefined)?.[deferredCards]?.get(slot);
    if (deferred) cards.push(...deferred);
  } else if ((tool === "wait" || tool === "cancel") && data.op === tool && Array.isArray(data.jobs)) {
    for (const value of data.jobs) {
      const job = record(value);
      if (!job || job.type !== "task" || typeof job.id !== "string") continue;
      const jobStatus = status(job.status);
      if (!jobStatus) continue;
      const body = text(job.resultText) || text(job.errorText);
      const envelope = taskEnvelope(body, text(job.agentUrlId) || job.id);
      cards.push({ id: job.id, label: envelope?.label || job.id, target: text(job.intent) || text(job.label),
        status: envelope?.cancelled ? "cancelled" : jobStatus, durationMs: duration(job.durationMs),
        output: envelope?.output ?? body, error: envelope?.error || (job.resultText ? text(job.errorText) : "") });
    }
  } else if (data.kind === "pi-web-subagent" && typeof data.sessionId === "string") {
    const childStatus = status(data.status);
    if (!childStatus) return cards;
    const started = typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
    const completed = typeof data.completedAt === "string" ? Date.parse(data.completedAt) : NaN;
    cards.push({ id: data.sessionId, label: text(data.profile) || data.sessionId, target: text(data.description), status: childStatus,
      durationMs: duration(completed - started), output, error: text(data.error) || text(data.worktreeCleanupError) });
  }
  return cards;
}

function taskOriginIds(details: unknown): string[] {
  const data = record(details);
  const async = record(data?.async);
  if (async?.type !== "task" || typeof async.jobId !== "string") return [];
  const ids = [async.jobId];
  if (Array.isArray(data?.progress)) {
    for (const value of data.progress) {
      const child = record(value);
      if (typeof child?.id === "string") ids.push(child.id);
    }
  }
  return ids;
}

/** Split omp's delivery report only when its ordered headings agree with the job metadata. */
export function asyncResultCards(message: CustomMessage): readonly AsyncResultCard[] {
  if (message.customType !== "async-result") return [];
  const jobs = record(message.details)?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return [];
  const report = typeof message.content === "string" ? message.content
    : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  const start = /^<system-notice>\r?\n/.exec(report);
  const end = /\r?\n<\/system-notice>\s*$/.exec(report);
  if (!start || !end) return [];
  const content = report.slice(start[0].length, end.index);
  const headings = jobs.length === 1
    ? [...content.matchAll(/^Background job (\S+?)(?: \(([^\n]*)\))? has completed\.\r?\n(?:Resume your work using the result below\.\r?\n)?/g)]
    : [...content.matchAll(/^── Job (\S+)(?: \(([^\n]*)\))? ──\r?\n/gm)];
  if (headings.length !== jobs.length) return [];
  const cards: AsyncResultCard[] = [];
  for (const [index, value] of jobs.entries()) {
    const job = record(value);
    const heading = headings[index];
    if (!job || typeof job.jobId !== "string" || job.jobId !== heading[1]) return [];
    const jobStatus = status(job.status);
    const tool = job.type;
    if (!jobStatus || (tool !== "bash" && tool !== "task" && tool !== "eval")) return [];
    const agentId = text(job.agentId) || job.jobId;
    const body = content.slice(heading.index + heading[0].length, headings[index + 1]?.index).replace(/\r?\n$/, "");
    const envelope = tool === "task" ? taskEnvelope(body.trim(), agentId) : undefined;
    cards.push({ id: job.jobId, agentId, tool,
      label: envelope?.label || (tool === "task" ? agentId : tool),
      target: heading[2] || text(job.label) || (tool === "task" ? "" : job.jobId),
      status: envelope?.cancelled ? "cancelled" : jobStatus, durationMs: duration(job.durationMs),
      output: envelope?.output ?? body, error: envelope?.error });
  }
  return cards;
}

/** Pair a later omp async delivery with its spawning call without changing transcript messages. */
export function attachDeferredTaskResults(results: Map<string, ToolResultMessage>, messages: readonly AgentMessage[]): void {
  const origins = new Map<string, { result: ToolResultMessage; slot: number }>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (message.toolName === "task") {
        for (const id of taskOriginIds(message.details)) origins.set(id, { result: message, slot: -1 });
      } else if (message.toolName === "bash") {
        shellToolDispatches(message.details).forEach(({ tool, mode, inner }, slot) => {
          if (tool === "task" && mode === "execute") {
            for (const id of taskOriginIds(inner)) origins.set(id, { result: message, slot });
          }
        });
      }
      continue;
    }
    if (origins.size === 0 || message.role !== "custom" || message.customType !== "async-result" || !message.display) continue;
    const jobs = record(message.details)?.jobs;
    if (!Array.isArray(jobs) || !jobs.some(value => record(value)?.type === "task")) continue;
    for (const card of asyncResultCards(message)) {
      if (card.tool !== "task" || card.status === "running" || card.status === "pending") continue;
      const origin = origins.get(card.id) ?? origins.get(card.agentId);
      if (!origin) continue;
      const current = results.get(origin.result.toolCallId) as ToolResultWithCards | undefined;
      if (!current) continue;
      const bySlot = current[deferredCards] ?? new Map<number, TaskResultCard[]>();
      if (!current[deferredCards]) {
        const decorated: ToolResultWithCards = { ...current, [deferredCards]: bySlot };
        results.set(current.toolCallId, decorated);
      }
      const cards = bySlot.get(origin.slot) ?? [];
      if (!bySlot.has(origin.slot)) bySlot.set(origin.slot, cards);
      cards.push(card);
    }
  }
}
