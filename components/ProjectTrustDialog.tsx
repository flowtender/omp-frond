"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  McpConfigFieldRef,
  McpConfigFileInfo,
  McpErrorResponse,
  McpOverrideKey,
  McpRefusalReason,
  McpServerInfo,
  ProjectMcpListing,
  ProjectTrustResponse,
  ProjectTrustChoice,
  ProjectTrustStatus,
} from "@/lib/api-types";
import {
  mcpFieldLabel,
  mcpFileProblemDetail,
  mcpOverrideNotice,
  mcpServerHasHiddenCharacters,
  mcpServerTarget,
  mcpVariableChips,
  mcpVariableReferencesKey,
  revealHiddenCharacters,
} from "@/lib/mcp-server-display";
import { openStackedDialog } from "@/lib/stacked-dialog";

/** How long the dialog waits for the listing before it stops holding Trust back. */
export const MCP_LISTING_TIMEOUT_MS = 10_000;

/** Why trusting failed: a route refusal carries its `reason`; a network failure has none. */
export interface ProjectTrustFailure {
  error: string;
  reason?: McpRefusalReason;
}

/** What the dialog knows about project MCP files and trust from the same answer. */
export type ProjectTrustMcpListing =
  | { state: "loading" }
  | { state: "failed"; error?: string; reason?: McpRefusalReason; timedOut?: boolean }
  | {
      state: "loaded";
      listing: ProjectMcpListing;
      /** Absent when `trust.json` could not be read; see `statusError`. */
      status?: ProjectTrustStatus;
      statusError?: string;
    };

const STATUS_ID = "project-trust-mcp-status";
const NOTICE_ID = "project-trust-notice";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trustStatusFrom(data: ProjectTrustResponse): ProjectTrustStatus {
  const status: ProjectTrustStatus = {
    requiresTrust: data.requiresTrust,
    trusted: data.trusted,
    decision: data.decision,
    inherited: data.inherited,
  };
  if (data.decisionPath !== undefined) status.decisionPath = data.decisionPath;
  if (data.decisionError !== undefined) status.decisionError = data.decisionError;
  return status;
}

/** The listing and the status a GET answer carries; a 500 for an unreadable trust store still carries the listing. */
export function projectTrustListingFrom(
  ok: boolean,
  status: number,
  data: Partial<ProjectTrustResponse & McpErrorResponse>,
): ProjectTrustMcpListing {
  const listing: ProjectMcpListing | undefined = Array.isArray(data.mcpServers)
    ? {
        mcpServers: data.mcpServers,
        ...(data.mcpFile ? { mcpFile: data.mcpFile } : {}),
        ...(data.mcpFiles !== undefined ? { mcpFiles: data.mcpFiles } : {}),
        ...(data.mcpError !== undefined ? { mcpError: data.mcpError } : {}),
      }
    : undefined;
  if (ok && !data.error && listing && typeof data.requiresTrust === "boolean") {
    return { state: "loaded", listing, status: trustStatusFrom(data as ProjectTrustResponse) };
  }
  if (data.reason === "trust-unreadable" && listing) {
    return { state: "loaded", listing, statusError: data.error ?? `HTTP ${status}` };
  }
  return { state: "failed", error: data.error ?? `HTTP ${status}`, reason: data.reason };
}

/** Choose a policy for this opening or for the repository. */
export function ProjectTrustDialog({
  cwd,
  projectRoot,
  resources,
  busy,
  error,
  onCancel,
  onConfirm,
  onAssessment,
}: {
  cwd: string;
  projectRoot: string;
  resources: ProjectTrustResponse["resources"];
  busy: boolean;
  error: ProjectTrustFailure | null;
  onCancel: () => void;
  onAssessment?: (data: ProjectTrustResponse) => void;
  onConfirm: (choice: ProjectTrustChoice) => void;
}) {
  const [listing, setListing] = useState<ProjectTrustMcpListing>({ state: "loading" });

  useEffect(() => {
    let active = true;
    let timedOut = false;
    setListing({ state: "loading" });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MCP_LISTING_TIMEOUT_MS);
    fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as Partial<ProjectTrustResponse & McpErrorResponse>;
        if (!active) return;
        const next = projectTrustListingFrom(response.ok, response.status, data);
        setListing(next);
        if (response.ok && data.projectRoot && Array.isArray(data.resources)) onAssessment?.(data as ProjectTrustResponse);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setListing(timedOut ? { state: "failed", timedOut: true } : { state: "failed", error: errorMessage(reason) });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cwd, onAssessment]);

  return (
    <ProjectTrustDialogView
      cwd={cwd}
      projectRoot={projectRoot}
      resources={resources}
      busy={busy}
      error={error}
      listing={listing}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** The dialog for a listing in any state, without the fetch; exported for tests. */
export function ProjectTrustDialogView({
  cwd,
  projectRoot,
  resources,
  busy,
  error,
  listing,
  onCancel,
  onConfirm,
}: {
  cwd: string;
  projectRoot: string;
  resources: ProjectTrustResponse["resources"];
  busy: boolean;
  error: ProjectTrustFailure | null;
  listing: ProjectTrustMcpListing;
  onCancel: () => void;
  onConfirm: (choice: ProjectTrustChoice) => void;
}) {
  const { t } = useI18n();
  const loading = listing.state === "loading";
  const notice = listing.state === "loaded" && listing.status && !listing.status.requiresTrust ? "mcp.reason.trust-not-required" : undefined;
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read through refs, so the Escape listener registered once sees the current props.
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    busyRef.current = busy;
    onCancelRef.current = onCancel;
  }, [busy, onCancel]);

  // The dialog can open above Settings › MCP: Escape closes it alone (taken in
  // the capture phase, before Settings' own handler), focus moves into it, and
  // goes back to what had it once it closes. Escape is ignored while trusting,
  // like Cancel and the backdrop, but still never reaches Settings.
  useEffect(() => openStackedDialog(document, dialogRef.current, () => {
    if (!busyRef.current) onCancelRef.current();
  }), []);

  return (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        aria-describedby="project-trust-description"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <div className="project-trust-body">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="project-trust-icon"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <div className="project-trust-content">
            <div id="project-trust-title" className="project-trust-title">
              {t("trust.dialogTitle")}
            </div>
            <div id="project-trust-description" className="project-trust-text">
              {t("trust.dialogBody")}
            </div>
            <code className="project-trust-path">{revealHiddenCharacters(cwd)}</code>
            <p>{t("trust.root")}</p>
            <code className="project-trust-path">{revealHiddenCharacters(projectRoot)}</code>
            {resources.length > 0 && (
              <section aria-label={t("trust.resources")}>
                <h3>{t("trust.resources")}</h3>
                <ul>{resources.map((resource) => (
                  <li key={`${resource.kind}:${resource.path}`}>
                    <span>{t(`trust.kind.${resource.kind}`)}</span>{" "}<code>{revealHiddenCharacters(resource.path)}</code>
                  </li>
                ))}</ul>
              </section>
            )}
            {notice && <p id={NOTICE_ID} role="status" className="project-trust-notice">{t(notice)}</p>}
            {listing.state === "loaded" && (listing.statusError !== undefined || listing.status?.decisionError !== undefined) && (
              <div className="project-trust-mcp-failed">
                <p className="project-trust-mcp-line is-warning">{t("trust.decisionError")}</p>
                <code className="project-trust-mcp-detail">{revealHiddenCharacters(listing.statusError ?? listing.status?.decisionError ?? "")}</code>
              </div>
            )}
            <ProjectTrustMcpSection listing={listing} />
          </div>
        </div>
        {/* Outside the scrolling body, so a long server list cannot hide it. */}
        {error && <ProjectTrustError error={error} />}
        <div className="project-trust-footer">
          <button
            type="button"
            className="project-trust-button"
            onClick={onCancel}
            disabled={busy}
          >
            {t("trust.cancel")}
          </button>
          {([
            ["distrust-chat", "trust.denyChat"],
            ["trust-chat", "trust.allowChat"],
            ["always-distrust", "trust.denyAlways"],
            ["always-trust", "trust.allowAlways"],
          ] as const).map(([choice, label]) => (
            <button
              key={choice}
              type="button"
              className={`project-trust-button${choice === "trust-chat" ? " is-primary" : ""}`}
              onClick={() => onConfirm(choice)}
              disabled={busy || loading || !projectRoot || ((listing.state === "failed" || (listing.state === "loaded" && (listing.statusError !== undefined || listing.listing.mcpError !== undefined || (!listing.listing.mcpFiles && !listing.listing.mcpFile)))) && choice !== "distrust-chat")}
              aria-busy={busy || undefined}
              aria-describedby={loading ? STATUS_ID : undefined}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Why trusting failed: the translated reason, or for an internal or network failure its diagnostic. */
function ProjectTrustError({ error }: { error: ProjectTrustFailure }) {
  const { t } = useI18n();
  const translated = error.reason !== undefined && error.reason !== "internal";
  return (
    <div role="alert" className="project-trust-error">
      {translated ? t(`mcp.reason.${error.reason}`) : t("trust.trustFailed")}
      {!translated && <code className="project-trust-error-detail">{revealHiddenCharacters(error.error)}</code>}
    </div>
  );
}

/** The trust dialog's list of the project's MCP servers; exported for tests. */
export function ProjectTrustMcpSection({ listing }: { listing: ProjectTrustMcpListing }) {
  const { t } = useI18n();
  if (listing.state === "loading") {
    return <p id={STATUS_ID} role="status" className="project-trust-mcp-status">{t("trust.mcp.loading")}</p>;
  }
  if (listing.state === "failed" || listing.listing.mcpError !== undefined || (!listing.listing.mcpFiles && !listing.listing.mcpFile)) {
    let detail: string | undefined;
    if (listing.state === "failed") {
      // An internal failure has nothing to translate: its diagnostic is the reason.
      detail = listing.reason && listing.reason !== "internal" ? t(`mcp.reason.${listing.reason}`) : listing.error;
    } else {
      detail = listing.listing.mcpError;
    }
    const timedOut = listing.state === "failed" && listing.timedOut;
    return (
      <div className="project-trust-mcp-failed">
        <p className="project-trust-mcp-line is-warning">{t(timedOut ? "trust.mcp.timedOut" : "trust.mcp.loadFailed")}</p>
        {detail && <code className="project-trust-mcp-detail">{revealHiddenCharacters(detail)}</code>}
      </div>
    );
  }

  const { mcpServers: servers } = listing.listing;
  const files = (listing.listing.mcpFiles ?? (listing.listing.mcpFile ? [listing.listing.mcpFile] : []))
    .filter((file) => file.exists || file.problems.length > 0 || servers.some((server) => server.sourcePath === file.path));
  if (files.length === 0) return null;
  return (
    <section className="project-trust-mcp" aria-labelledby="project-trust-mcp-title">
      <div id="project-trust-mcp-title" className="project-trust-mcp-title">{t("trust.mcp.title")}</div>
      {servers.length > 0 && <p className="project-trust-mcp-intro">{t("trust.mcp.intro")}</p>}
      {files.map((file) => {
        const fileServers = servers.filter((server) => server.sourcePath === file.path);
        return (
          <section key={file.path}>
            <code className="project-trust-mcp-detail">{revealHiddenCharacters(file.path)}</code>
            <McpFileProblems file={file} />
            {fileServers.length === 0 && file.problems.length === 0 && (
              <p className="project-trust-mcp-line">{t("trust.mcp.none")}</p>
            )}
            {fileServers.some((server) => !server.validated) && (
              <p className="project-trust-mcp-line">{t("trust.mcp.unchecked")}</p>
            )}
            {fileServers.length > 0 && (
              <ul className="project-trust-mcp-list">
                {fileServers.map((server) => <McpServerItem key={server.name} server={server} />)}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}

function McpFileProblems({ file }: { file: McpConfigFileInfo }) {
  const { t } = useI18n();
  return (
    <>
      {file.problems.map((problem) => {
        const detail = mcpFileProblemDetail(problem, file.realPath);
        return (
          <div key={problem.reason} className="project-trust-mcp-problem">
            <p className="project-trust-mcp-line is-warning">{t(`mcp.fileProblem.${problem.reason}`)}</p>
            {detail && <code className="project-trust-mcp-detail">{detail}</code>}
          </div>
        );
      })}
    </>
  );
}

function McpFieldChips({ fields }: { fields: McpConfigFieldRef[] }) {
  const { t } = useI18n();
  return (
    <>
      {fields.map((field) => {
        const label = mcpFieldLabel(field);
        return (
          <code key={`${field.kind}\0${field.name ?? ""}`} className="project-trust-mcp-chip">
            {t(label.key, label.params)}
          </code>
        );
      })}
    </>
  );
}

function McpVariableChips({ server }: { server: McpServerInfo }) {
  const { t } = useI18n();
  return (
    <>
      {mcpVariableChips(server.variableReferences).map(({ variable, field }) => {
        const label = mcpFieldLabel(field);
        return (
          <code key={`${variable}\0${field.kind}\0${field.name ?? ""}`} className="project-trust-mcp-chip">
            {t("mcp.server.variableIn", { variable, field: t(label.key, label.params) })}
          </code>
        );
      })}
    </>
  );
}

function McpServerItem({ server }: { server: McpServerInfo }) {
  const { t } = useI18n();
  const overrideText = (keys: McpOverrideKey[]) => {
    const notice = mcpOverrideNotice(keys);
    return t(notice.key, notice.params);
  };
  const target = mcpServerTarget(server);
  // A refused entry never connects, so nothing in it runs or is sent.
  const connects = server.invalidError === undefined;
  return (
    <li className="project-trust-mcp-server">
      <div className="project-trust-mcp-server-head">
        <span className="project-trust-mcp-server-name">{revealHiddenCharacters(server.name)}</span>
        {server.transport && <span className="project-trust-mcp-tag">{t(`mcp.transport.${server.transport}`)}</span>}
      </div>
      {target !== undefined && <code className="project-trust-mcp-target">{target}</code>}
      {server.cwd !== undefined && (
        <p className="project-trust-mcp-line">{t("trust.mcp.cwd", { path: revealHiddenCharacters(server.cwd) })}</p>
      )}
      {mcpServerHasHiddenCharacters(server) && (
        <p className="project-trust-mcp-line is-warning">{t("mcp.server.hiddenCharacters")}</p>
      )}
      {server.invalidError !== undefined && (
        <p className="project-trust-mcp-line is-warning">
          {t("mcp.server.invalid")} <code className="project-trust-mcp-chip">{revealHiddenCharacters(server.invalidError)}</code>
        </p>
      )}
      {server.webPasswordField && (
        <p className="project-trust-mcp-line is-warning">
          {t("mcp.server.webPassword")} <McpFieldChips fields={[server.webPasswordField]} />
        </p>
      )}
      {!server.enabled && <p className="project-trust-mcp-line">{t("mcp.server.disabled")}</p>}
      {connects && server.commandFields.length > 0 && (
        <p className="project-trust-mcp-line is-warning">
          {t("mcp.server.commandFields")} <McpFieldChips fields={server.commandFields} />
        </p>
      )}
      {connects && server.variableReferences.length > 0 && (
        <p className="project-trust-mcp-line is-warning">
          {t(mcpVariableReferencesKey(server))} <McpVariableChips server={server} />
        </p>
      )}
      {server.replacesGlobal && <p className="project-trust-mcp-line is-warning">{t("mcp.server.replacesGlobal")}</p>}
      {server.override && <p className="project-trust-mcp-line is-warning">{overrideText(server.override.keys)}</p>}
      {server.masked && <p className="project-trust-mcp-line is-dim">{t("mcp.server.masked")}</p>}
    </li>
  );
}
