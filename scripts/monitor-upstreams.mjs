import { readFileSync } from "node:fs";

const reportStart = "<!-- upstream-report:start -->";
const reportEnd = "<!-- upstream-report:end -->";

export function composeTrackingIssue(stream, head, comparison, previousBody) {
  if (!/^[a-f0-9]{40}$/.test(stream.reviewed) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error(`Invalid commit SHA for ${stream.repository}`);
  }
  const url = `https://github.com/${stream.repository}`;
  const compareUrl = `${url}/compare/${stream.reviewed}...${head}`;
  const pending = comparison.status !== "identical";
  const summary = comparison.status === "ahead"
    ? `${comparison.ahead_by} commits await review.`
    : comparison.status === "identical"
      ? "No changes since the reviewed checkpoint."
      : `History is ${comparison.status}; inspect the comparison before updating the checkpoint.`;
  const commits = comparison.commits.slice(0, 15).map((commit) => {
    const subject = commit.commit.message.split("\n")[0]
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replace(/[\\`*_[\]]/g, "\\$&");
    return `- [${commit.sha.slice(0, 8)}](${url}/commit/${commit.sha}) ${subject}`;
  });
  const report = [
    reportStart,
    `<!-- upstream-head:${head} -->`,
    `## ${stream.repository}: ${stream.branch}`,
    "",
    `Reviewed checkpoint: [${stream.reviewed}](${url}/commit/${stream.reviewed})`,
    `Latest observed commit: [${head}](${url}/commit/${head})`,
    "",
    summary,
    `[Review the complete comparison](${compareUrl}).`,
    "",
    ...commits,
    ...(comparison.commits.length > 15 ? ["", "Showing the first 15 commits; use the comparison for the complete list."] : []),
    "",
    "The checkpoint advances only when `.github/upstreams.json` is edited on the default branch.",
    "Monitoring does not merge changes or mark them reviewed.",
    reportEnd,
  ].join("\n");
  const marker = `<!-- upstream-monitor:${stream.repository} -->`;
  let body;
  if (previousBody === undefined) {
    body = `${marker}\n\n${report}\n\n## Review notes (maintained by you)\n\n- Pending sync PR: none recorded\n- Disposition: not yet reviewed\n- Record incorporated commits and intentionally skipped changes here.\n`;
  } else {
    const start = previousBody.indexOf(reportStart);
    const end = previousBody.indexOf(reportEnd);
    if (start < 0 || end < start || previousBody.indexOf(reportStart, start + reportStart.length) !== -1
      || previousBody.indexOf(reportEnd, end + reportEnd.length) !== -1) {
      throw new Error(`Tracking issue for ${stream.repository} has damaged report markers; restore them before rerunning.`);
    }
    body = previousBody.slice(0, start) + report + previousBody.slice(end + reportEnd.length);
  }
  return { body, pending, compareUrl, newHead: !previousBody?.includes(`<!-- upstream-head:${head} -->`) };
}

export async function monitorUpstreams({ github, context, core, dryRun = false }) {
  const streams = JSON.parse(readFileSync(new URL("../.github/upstreams.json", import.meta.url), "utf8"));
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: "all", per_page: 100,
  });
  for (const stream of streams) {
    const [owner, repo] = stream.repository.split("/");
    const { data: headCommit } = await github.rest.repos.getCommit({ owner, repo, ref: stream.branch });
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `${stream.reviewed}...${headCommit.sha}`, per_page: 100,
    });
    const marker = `<!-- upstream-monitor:${stream.repository} -->`;
    const matching = issues.filter((issue) => !issue.pull_request && issue.body?.includes(marker)
      && issue.user?.type === "Bot");
    if (matching.length > 1) throw new Error(`Multiple tracking issues for ${stream.repository}; keep one marker.`);
    const existing = matching[0];
    const report = composeTrackingIssue(stream, headCommit.sha, comparison, existing?.body);
    core.info(`${stream.repository}: ${comparison.status}; ${comparison.ahead_by} ahead; ${report.compareUrl}`);
    await core.summary.addHeading(stream.repository, 2)
      .addLink("Upstream comparison", report.compareUrl)
      .addRaw(` — ${comparison.status}, ${comparison.ahead_by} ahead\n`).write();
    if (dryRun) continue;
    if (!existing) {
      await github.rest.issues.create({
        ...context.repo, title: `Upstream review: ${stream.repository}`, body: report.body,
      });
      continue;
    }
    if (existing.body !== report.body || (report.pending && existing.state === "closed")) {
      await github.rest.issues.update({
        ...context.repo, issue_number: existing.number, body: report.body,
        ...(report.pending ? { state: "open" } : {}),
      });
    }
    if (report.newHead) {
      await github.rest.issues.createComment({
        ...context.repo, issue_number: existing.number,
        body: `Upstream main changed. [Review changes since the checkpoint](${report.compareUrl}).`,
      });
    }
  }
}
