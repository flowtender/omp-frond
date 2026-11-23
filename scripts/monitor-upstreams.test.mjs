import assert from "node:assert/strict";
import test from "node:test";
import { composeTrackingIssue } from "./monitor-upstreams.mjs";

const stream = { repository: "example/ui", branch: "main", reviewed: "a".repeat(40) };
const head = "b".repeat(40);
const comparison = {
  status: "ahead", ahead_by: 1,
  commits: [{ sha: head, commit: { message: "Fix session reload\n\nDetails" } }],
};

test("new upstream commits remain pending until the configured checkpoint advances", () => {
  const pending = composeTrackingIssue(stream, head, comparison);
  assert.equal(pending.pending, true);
  assert.match(pending.body, /1 commits await review/);
  assert.ok(pending.compareUrl.endsWith(`${stream.reviewed}...${head}`));
  const reviewed = composeTrackingIssue({ ...stream, reviewed: head }, head,
    { status: "identical", ahead_by: 0, commits: [] }, pending.body);
  assert.equal(reviewed.pending, false);
  assert.match(reviewed.body, /No changes since the reviewed checkpoint/);
});

test("refreshing reports preserves human review notes and does not announce the same head again", () => {
  const original = composeTrackingIssue(stream, head, comparison);
  const annotated = original.body.replace("Pending sync PR: none recorded", "Pending sync PR: #123; skip the theme change");
  const refreshed = composeTrackingIssue(stream, head, comparison, annotated);
  assert.equal(refreshed.body, annotated);
  assert.equal(refreshed.newHead, false);
  const nextHead = "c".repeat(40);
  const next = composeTrackingIssue(stream, nextHead, comparison, annotated);
  assert.equal(next.newHead, true);
  assert.match(next.body, /Pending sync PR: #123; skip the theme change/);
});

test("rewritten upstream history is not mistaken for no pending work", () => {
  for (const status of ["behind", "diverged"]) {
    const report = composeTrackingIssue(stream, head, { status, ahead_by: 0, commits: [] });
    assert.equal(report.pending, true);
    assert.ok(report.body.includes(`History is ${status}`));
  }
});

test("damaged report boundaries fail instead of overwriting human notes", () => {
  const original = composeTrackingIssue(stream, head, comparison).body;
  for (const damaged of [
    original.replace("<!-- upstream-report:end -->", ""),
    `${original}\n<!-- upstream-report:start -->`,
    `${original}\n<!-- upstream-report:end -->`,
  ]) {
    assert.throws(() => composeTrackingIssue(stream, head, comparison, damaged), /damaged report markers/);
  }
});

test("commit subjects cannot inject HTML or task-list markup into the digest", () => {
  const report = composeTrackingIssue(stream, head, {
    ...comparison, commits: [{ sha: head, commit: { message: "<img src=x> [x] *done*" } }],
  });
  assert.ok(report.body.includes("&lt;img src=x&gt; \\[x\\] \\*done\\*"));
});
