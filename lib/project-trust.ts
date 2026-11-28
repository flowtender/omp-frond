import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectExecutableResource, ProjectTrustChoice, ProjectTrustStatus } from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { projectIdentityKey } from "./project-identity";
import { listProjectExecutableResources } from "./project-resource-inventory";
import { readRegularFileText } from "./regular-file";
import { resolveProjectTrustRoot } from "./worktree";

// The old allow-list was scoped to one path. Do not broaden it to other worktrees.
const DECISIONS_FILE = "omp-frond-project-decisions.json";
const OPENING_IDLE_MS = 12 * 60 * 60 * 1000;
const OPENING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProjectTrustAssessment extends ProjectTrustStatus {
  projectRoot: string;
  checkoutRoot: string;
  folder: string;
  resources: ProjectExecutableResource[];
}

interface OpeningDecision {
  agentDir: string;
  projectRoot: string;
  cwd: string;
  sessionId?: string;
  trusted: boolean;
  expires: number;
}

declare global {
  var __ompProjectOpenings: Map<string, OpeningDecision> | undefined;
}

function openings() {
  return globalThis.__ompProjectOpenings ??= new Map();
}

export class RpcProjectTrustError extends Error {
  constructor(readonly status: 409 | 428) {
    super(status === 428
      ? "A project trust decision is required for this chat opening."
      : "This session is busy under a different project trust policy. Try again when it is idle.");
  }
}

function readDecisions(agentDir: string): Map<string, boolean> {
  const text = readRegularFileText(join(agentDir, DECISIONS_FILE));
  if (text === undefined) return new Map();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid project decision store");
  return new Map(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

function canonicalFolder(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

export function isProjectOpeningId(value: unknown): value is string {
  return typeof value === "string" && OPENING_ID.test(value);
}

export async function getProjectTrustStatus(cwd: string, agentDir: string): Promise<ProjectTrustAssessment> {
  const folder = canonicalFolder(cwd);
  const { projectRoot, checkoutRoot } = await resolveProjectTrustRoot(folder);
  const resources = listProjectExecutableResources(folder, checkoutRoot);
  const requiresTrust = resources.length > 0;
  let decision: boolean | null;
  try {
    decision = readDecisions(agentDir).get(projectIdentityKey(projectRoot)) ?? null;
  } catch {
    return {
      projectRoot, checkoutRoot, folder, resources, requiresTrust, trusted: false, decision: null, inherited: false,
      decisionError: "Could not read omp-frond's project decisions.",
    };
  }
  return {
    projectRoot, checkoutRoot, folder, resources, requiresTrust, trusted: decision ?? !requiresTrust, decision,
    inherited: decision !== null && projectIdentityKey(folder) !== projectIdentityKey(projectRoot),
    ...(decision !== null && { decisionPath: projectRoot }),
  };
}

export async function setProjectTrustDecision(
  cwd: string,
  agentDir: string,
  expectedRoot: string,
  choice: ProjectTrustChoice,
  openingId: string,
  sessionId?: string,
): Promise<ProjectTrustAssessment | undefined> {
  const assessment = await getProjectTrustStatus(cwd, agentDir);
  if (assessment.projectRoot !== expectedRoot) return undefined;
  const now = Date.now();
  const rootKey = projectIdentityKey(assessment.projectRoot);
  const agentKey = projectIdentityKey(agentDir);
  const folderKey = projectIdentityKey(canonicalFolder(cwd));
  const trusted = choice === "trust-chat" || choice === "always-trust";
  const permanent = choice === "always-trust" || choice === "always-distrust";
  const records = openings();
  for (const [id, record] of records) {
    if (record.expires <= now) records.delete(id);
  }
  const existing = records.get(openingId);
  if (existing && (existing.agentDir !== agentKey || existing.projectRoot !== rootKey ||
    existing.cwd !== folderKey || existing.sessionId !== sessionId)) return undefined;
  if (permanent) {
    const decisions = readDecisions(agentDir);
    decisions.set(rootKey, trusted);
    mkdirSync(agentDir, { recursive: true });
    writePrivateFileAtomicSync(join(agentDir, DECISIONS_FILE), `${JSON.stringify(Object.fromEntries(decisions), null, 2)}\n`);
    for (const [id, record] of records) {
      if (record.agentDir === agentKey && record.projectRoot === rootKey) records.delete(id);
    }
    return {
      ...assessment, trusted, decision: trusted, decisionPath: assessment.projectRoot,
      inherited: folderKey !== rootKey,
    };
  }
  records.set(openingId, { agentDir: agentKey, projectRoot: rootKey, cwd: folderKey, sessionId, trusted, expires: now + OPENING_IDLE_MS });
  return { ...assessment, trusted };
}

export async function getChatProjectPolicy(
  cwd: string,
  agentDir: string,
  openingId: string | undefined,
  sessionId?: string,
): Promise<{ trusted: boolean; requiresTrust: boolean; projectRoot: string; decided: boolean }> {
  const assessment = await getProjectTrustStatus(cwd, agentDir);
  const { projectRoot, requiresTrust, decision } = assessment;
  const opening = openingId && openings().get(openingId);
  if (opening && opening.expires > Date.now() && opening.agentDir === projectIdentityKey(agentDir) &&
    opening.projectRoot === projectIdentityKey(projectRoot) && opening.cwd === projectIdentityKey(canonicalFolder(cwd)) &&
    opening.sessionId === sessionId) {
    opening.expires = Date.now() + OPENING_IDLE_MS;
    return { trusted: opening.trusted, requiresTrust, projectRoot, decided: true };
  }
  return { trusted: decision === true, requiresTrust, projectRoot, decided: decision !== null || !requiresTrust };
}

/** A new chat has no transcript ID until the SDK creates it. Bind its grant to that ID. */
export function bindProjectOpening(openingId: string | undefined, sessionId: string): void {
  const opening = openingId && openings().get(openingId);
  if (opening && opening.sessionId === undefined) opening.sessionId = sessionId;
}
