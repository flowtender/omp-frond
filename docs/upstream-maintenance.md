# Maintaining the upstream streams

## Remotes

| Remote | Repository | Role |
| --- | --- | --- |
| `origin` | `flowtender/omp-web` | Publish this fork and its PR branches |
| `pi-web` | `agegr/pi-web` | Original UI upstream |
| `ddallabenetta` | `ddallabenetta/omp-web` | OMP adaptation upstream |
| `kd-mm2` | `KD-MM2/omp-web` | OMP fork with a newer pi-web integration |

OMP itself is a pinned package dependency, not another UI branch to merge.
The SDK source is <https://github.com/can1357/oh-my-pi>.

Local configuration defaults pushes to `origin`, uses `push.default=current`,
and permits only fast-forward pulls. Explicit push destinations still override
these defaults. These settings and the local branches are not installed by a
clone; they belong to this checkout's shared Git configuration.

```bash
git config --local remote.pushDefault origin
git config --local push.default current
git config --local pull.ff only
```

## Branch roles

- `main`: existing published development history; retained without rewriting.
  Fork README and maintenance documentation can live here.
- `archive/main-before-streams`: preserved application tip `f81813c`.
- `integration`: candidate maintained baseline at `76839bc`, the SDK 19.1.1
  adaptation already submitted as `sdk-update-kd`. It is based on kd-mm2's main,
  not pi-web directly. It includes SDK-related lifecycle, capacity, and form work;
  it is not a pure dependency-version bump or an approved upstream release.
- `daily`: the complete working application at `f81813c`, including pending
  features. This currently shares the old main history, not the new integration
  ancestry. Do not blindly merge or rebase it onto `integration`: SDK work was
  ported separately and needs deduplication when assembling a new daily version.
- `sdk-update-dd` and `sdk-update-kd`: existing submitted PR branches. Preserve
  their histories and worktrees while the reviews are pending.
- `topic/*`: historical topic tips catalogued below. They preserve the original
  stack, not independently based, submission-ready branches.

No personal-only feature has been identified: typing focus, scrolling, and the
other additions are potential upstream submissions. Keep genuinely personal
patches separate if any are added later.

## Existing patch catalog

Each topic's original patch is `topic/<name>^..topic/<name>`. Its parent includes
all earlier local patches, so do not submit the whole topic branch against an
upstream main: that would include unrelated changes. A parent records historical
ordering, not proof that every earlier feature is a semantic dependency.

| Topic | Commit | Classification |
| --- | --- | --- |
| `usage-stats` | `aa018bd` | Feature |
| `enabled-models` | `b5c5112` | Feature |
| `settings-reload` | `b4f6baa` | Settings workaround |
| `typing-focus` | `3854c3f` | Feature |
| `docs-capitalization` | `d91d727` | Documentation correction; may be folded into related docs |
| `mcp-guidance` | `436f61e` | UI improvement |
| `chat-scrolling` | `5426567` | Feature |
| `async-reply-visibility` | `9043e6b` | Transcript fix |
| `completed-reply-folding` | `45da8b3` | Transcript fix |
| `pwa-login` | `36cfac7` | Feature |
| `native-https` | `0de4aaf` | Feature; built after the login change |
| `agent-lifecycle` | `d9e5616` | SDK lifecycle fix; also adapted into the SDK PR |
| `capacity-resets` | `fea0951` | SDK capacity fix; also adapted into the SDK PR |
| `event-stream-release` | `80f8ca4` | SSE cleanup fix |

The SDK sequence from `4cdd4eb` through `f81813c` and HTML form implementation
`4e223e3` remain preserved in the archive/daily history and are adapted in the
existing SDK PR branches. Do not replay that sequence over `integration`.

## Receiving upstream changes

Fetch first; fetching does not integrate changes into a working branch:

```bash
git fetch --all
```

Review each stream independently. In particular, a new automation branch or
repository push timestamp does not mean its main branch advanced.

For each upstream, inspect what is not yet in integration:

```bash
git log --oneline integration..kd-mm2/main
git log --oneline integration..ddallabenetta/main
git log --oneline integration..pi-web/main
```

These are ancestry comparisons, not patch-equivalence checks. A cherry-picked
or squash-merged fix can appear absent despite equivalent code being present.

Create a `sync/<source>-<date>` branch from `integration` for a reviewed update.
Merge a coherent upstream history when appropriate, or cherry-pick selected
commits with provenance (`-x`). Resolve OMP adaptations explicitly: pi-web's Pi
SDK, authentication, configuration, and session assumptions cannot simply
replace the OMP equivalents. Verify the changed behavior before accepting the
sync branch into integration. Do not automatically merge all upstreams.

When a pending feature is accepted upstream, compare the resulting code before
replaying its local patch; upstream may squash or modify it.

## Preparing a submission

Choose the recipient first. For example, prepare the typing-focus patch for
kd-mm2 in a separate worktree (choose a new sibling path):

```bash
git worktree add -b submit/kd-typing-focus ../omp-web-kd-typing-focus kd-mm2/main
cd ../omp-web-kd-typing-focus
git cherry-pick -x topic/typing-focus
```

This replays only the named tip commit, not its historical ancestors. Adapt it
to that recipient's code, include only actual prerequisites, and run the
relevant tests and UI scenario. If it needs the SDK PR, wait for that PR or make
that dependency explicit rather than silently including the whole local stack.

Publish to this fork with an explicit branch and open the PR against the chosen
repository, not the default inferred by a GitHub client:

```bash
git push -u origin submit/kd-typing-focus
gh pr create --repo KD-MM2/omp-web --base main --head flowtender:submit/kd-typing-focus
```

For ddallabenetta or pi-web, start from that remote's main instead. A patch
working in daily is not proof that it works on a different recipient baseline.

## SDK upgrades

Create `sdk/<version>` from integration. Pin the SDK package family consistently,
update the lockfile, adapt changed APIs and event contracts, and verify the
affected runtime paths. Follow the repository's Bun-only runtime requirements;
never run the normal production build in the development checkout.

Carry compatible upgrade fixes to each recipient on its own submission branch.
Do not merge the OMP source repository into this UI or treat an automated version
bump as proof of compatibility.

## Publication and cutover

The setup creates local refs only; it does not push branches, change GitHub's
default branch, replace published main, or change the running checkout.
The historical topic refs are a provenance catalog, not completed extraction of
independent feature branches. Use the recipient-based workflow above to extract
and validate each submission without rewriting the preserved history.

A future replacement for published main should be reviewed as a deliberate
history/default-branch migration. Do not force-push it as part of a routine sync.

## GitHub automation: first-time setup

The workflow files must be published on the repository's default branch (`main`)
before GitHub will schedule them. The SDK target `integration` must also exist
on GitHub. Local files and branches alone do not activate Actions.

After reviewing the automation commit, publish these two branches:

```bash
git push origin integration
git push origin main
```

No force push is required. Do not push all branches or tags. If either push is
rejected, inspect the remote changes rather than forcing it.

In <https://github.com/flowtender/omp-web/settings/actions>:

1. Under **Actions permissions**, allow the actions used by the workflows:
   `actions/checkout`, `actions/github-script`, `oven-sh/setup-bun`, and
   `peter-evans/create-pull-request`. An existing allow-all policy also works.
2. Under **Workflow permissions**, enable **Allow GitHub Actions to create and
   approve pull requests**, then save. The workflow YAML requests its own
   minimal token permissions; no personal access token or repository secret
   needs to be added. Nothing in these workflows approves or merges PRs.
3. Open the repository's **Actions** tab. If GitHub says workflows are disabled
   because this is a fork, enable them. Select each of the following workflows
   and enable it if necessary.
4. Select **Monitor UI upstreams → Run workflow**, use branch `main`, and check
   `dry_run` for the first run. Inspect the comparisons in the job summary.
   Run again without `dry_run` to create the three review issues.
5. Select **Update omp dependency → Run workflow**, using branch `main`.
   A newer published SDK opens a draft PR into `integration`; if the SDK is
   already current, no PR is expected. An existing open PR for that version is
   left untouched so human source adaptations are not overwritten.

The SDK workflow runs daily at 08:17 UTC. UI upstream monitoring runs Mondays
at 08:43 UTC. GitHub schedules can be delayed; these are not exact-time alarms.
Scheduled workflows run from the default branch and may be disabled after 60
days without repository activity. See [enabling workflows][enable-workflows].

### What to do with the results

**SDK draft PR:** inspect the linked release notes and job logs. Failed lockfile,
installation, typechecking, or tests mean source adaptations are needed, not
that the updater silently skipped the release. Even successful checks leave
the PR in draft until the affected runtime behavior has been exercised.
Installation failures before the package bump (for example unavailable npm
packages) appear in the workflow logs and are checked again the next day.

The built-in GitHub token can leave PR CI awaiting approval: select
**Approve workflows to run** if the PR shows that banner. Compatibility checks
also run inside the updater itself. Subsequent human-pushed source changes
trigger normal PR CI. Neither merging this SDK PR nor running this updater
bumps the application version, creates a release, or starts npm publishing.
Existing independent release workflows are unchanged.

**Upstream tracking issues:** subscribe to each issue to receive notifications
when the monitor comments about a changed upstream head. Reports are refreshed
without duplicate comments when the head is unchanged. Keep your sync PR links
and decisions in **Review notes**, outside the report marker comments; that
text is preserved. Closing an issue with unreviewed changes is temporary: the
next run reopens it.

The durable review checkpoints live in `.github/upstreams.json` on `main`.
Initial checkpoints are the pi-web merge base of integration and the existing
ddallabenetta/kd-mm2 upstream tips. This intentionally exposes the pi-web
backlog instead of treating today's latest pi-web as already reviewed.
After reviewing a batch, update that stream's `reviewed` field to the full
40-character upstream commit SHA and commit/push the configuration change.
Advance only past changes you incorporated or explicitly decided to skip;
record those decisions in the issue. Do not advance checkpoints merely because
the monitor observed a newer head.

The next run compares the new checkpoint and refreshes the same issue. A
rewritten upstream history is reported as `behind` or `diverged`, not silently
treated as reviewed. A damaged report marker fails the run rather than
overwriting human notes. Fix the markers and rerun.

### Cost and permissions

This fork is public. [Standard GitHub-hosted runners are free for public
repositories][actions-billing]; these workflows use `ubuntu-latest`, no paid
larger runners, and no artifact uploads. Private repositories and paid storage
have different allowances.

The SDK updater requests repository contents and pull-request write access.
The UI monitor requests contents read and issues write access. Both use
GitHub's short-lived built-in `GITHUB_TOKEN`, provided automatically for each
run. The monitor reads upstream commit metadata; it does not execute upstream
code, change checkpoints, create sync commits, or merge anything.

[enable-workflows]: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows
[actions-billing]: https://docs.github.com/en/billing/concepts/product-billing/github-actions
