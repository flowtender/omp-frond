# Release Checklist

This fork (`flowtender/omp-frond`) publishes its own GitHub Releases and tags. The npm package `omp-web` is the upstream distribution, not automatically this fork: publish it only if you own that package and have configured trusted publishing (see below). Source install of this fork is authoritative (see README).

Use this checklist from a clean `main` checkout.

## Automated npm publishing

`.github/workflows/publish-npm.yml` is inherited from upstream. It runs on a pushed `v*` tag or manual dispatch and publishes `omp-web` to npm with provenance. Pushing a release tag to `flowtender/omp-frond` therefore starts a publish attempt. Do not push `v*` tags here unless you own the `omp-web` npm package and intend to publish it.

If you own it, the npm trusted publisher must match the repository and workflow that will run:

- workflow file: `.github/workflows/publish-npm.yml`
- GitHub environment: `npm`
- publisher: GitHub Actions, for the repository that actually publishes the package

The npm package must trust that repository and workflow, and the repository's `npm` environment must permit the release job to run. No npm token is stored in GitHub Actions. Activation state is tracked in [upstream maintenance](upstream-maintenance.md#github-automation-first-time-setup).


## Automated omp compatibility proposals

`.github/workflows/update-omp.yml` checks the latest stable `oh-my-pi` release
daily and opens a **draft** PR against `integration` with exact SDK package
pins. It refreshes the lockfile and runs installation, typechecking, and tests;
failures remain visible in the PR and linked workflow logs. Existing open
update PRs are left untouched so source adaptations are preserved.

Passing checks do not establish runtime compatibility. Review breaking changes,
adapt omp-web, exercise affected runtime paths, and mark the draft ready only
after verification. If the release is not yet available on npm, the next daily
run checks again.

The updater does not bump omp-web's version, tag, create a release, publish npm
packages, or merge anything. Publishing remains a separate deliberate action
using the release procedures below. See [upstream maintenance](upstream-maintenance.md#github-automation-first-time-setup)
for initial GitHub setup and upstream review tracking.

## 1. Preflight

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate -5
git rev-list --left-right --count trunk...origin/trunk
gh auth status
npm whoami
bun --version   # the published .next is built with Bun; engines.bun requires 1.4.4+
node -e "const p=require('./package.json'); console.log(p.version)"
lsof -nP -iTCP:30141 -sTCP:LISTEN
ls .next/server/route-cache
```

Expected:

- `git status` is clean, or only contains changes you intentionally plan to release.
- `trunk` and `origin/trunk` are aligned (`0	0`).
- GitHub is authenticated as an account that can push and create releases.
- npm is authenticated as an owner of `omp-web`, only if you intend to publish it.
- No dev server is listening on 30141: the production build rewrites `.next/` and breaks a running `bun run dev`. Stop it first.
- `.next/server/route-cache/` does not exist. `next start` writes it (the build does not), and it would be published. Delete it if present.

Before bumping, confirm the next version is free (replace `<version>`):

```bash
npm view omp-web@<version> version --registry https://registry.npmjs.org/   # expect E404
git ls-remote --tags origin v<version>                                            # expect empty
```

## 2. Publish to npm

Run this section only if you own the npm package `omp-web` and intend to publish it. Otherwise stop after the GitHub release steps: the npm package is the upstream distribution.

Patch release:

```bash
npm run release
```

The release script runs:

```bash
npm version patch --no-git-tag-version && npm run build && npm publish --access public
```

`npm run release` only bumps the patch number. For a minor (or major) release, set the version yourself and run the other two steps separately:

```bash
npm version <x.y.0> --no-git-tag-version
npm run build
npm publish --access public
```

Choosing the bump: look at `git log --oneline v<previous>..HEAD`. A batch of `feat:` commits (new UI, new commands, new settings) is a minor; only fixes and small adjustments is a patch. Decide before running the script, since a published version cannot be reused.

Notes:

- This bumps `package.json` and `package-lock.json`.
- It intentionally runs a production build. Do not run `next build` during normal development; release work is the exception.
- A newly published version may take a few minutes to show up. `npm view omp-web@<version> version` can return E404 and `npm view omp-web version` can show the previous version even though the publish printed `+ omp-web@<version>`. This is registry propagation, not a failed publish: do not publish again. Poll the registry until the version appears:

```bash
curl -s https://registry.npmjs.org/omp-web/<version> | head -c 80   # JSON once it exists, "version not found" before
npm view omp-web dist-tags --registry https://registry.npmjs.org/
npm view omp-web versions --json --registry https://registry.npmjs.org/
```

## 3. Commit the Version Bump

Replace `<version>` with the new package version, for example `0.7.5`.

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v<version>"
```

## 4. Tag and Push

```bash
git tag -a v<version> -m "v<version>"
git push origin main v<version>
```

Push the release tag by name. Do not use `git push --tags`: the local checkout holds tags fetched from contributor forks that are not on origin, and `--tags` publishes them (it leaked a stray `v0.10.5`, on a commit that is on no branch, during the v0.11.0 release). If you ever need `--tags`, compare `git tag` with `git ls-remote --tags origin` first.

Confirm the tag does not already exist before creating it when unsure:

```bash
git ls-remote --tags origin v<version>
gh release view v<version> --repo flowtender/omp-frond
```

## 5. Generate Release Notes from Commits

Use the previous release tag as the base.

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Write the release notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes or PR numbers next to each item when useful.

- Check commands, flags and setting names against `README.md` and the code before writing them down.
- Thank outside contributors by name: `git log --format='%h %an | %s' v<previous>..v<version>` lists authors, and the previous release's notes show the style.
- Open with the install or upgrade instructions for this fork's source checkout (see README), not `npm install -g omp-web@latest`, unless this release is also published to npm.
- Write the notes to a file outside the repo (for example `NOTES=$(mktemp)`), or pass them through stdin as shown below. A `release-notes.md` in the repo root is an untracked file in the next release's `git status`.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 GitHub Release `v<version>`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published GitHub Release `v<version>`.
```

## 6. Create or Update the GitHub Release

Create a new release:

```bash
gh release create v<version> \
  --repo flowtender/omp-frond \
  --verify-tag \
  --title "v<version>" \
  --notes-file "$NOTES"
```

If the release already exists and only the notes need updating:

```bash
gh release edit v<version> \
  --repo flowtender/omp-frond \
  --notes-file "$NOTES"
```

You can avoid a temporary file by passing notes through stdin:

```bash
gh release edit v<version> --repo flowtender/omp-frond --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 7. Final Verification

```bash
gh release view v<version> --repo flowtender/omp-frond
# only if this release was published to npm by an owner of omp-web
npm view omp-web@<version> version --registry https://registry.npmjs.org/
npm view omp-web dist-tags --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
git ls-remote --tags origin
```

Expected:

- GitHub Release exists and is not a draft unless intentionally published as one.
- If published to npm: the exact version resolves and `latest` points at it (allow a few minutes, see step 2).
- `git ls-remote --tags origin` shows no tag you did not mean to publish.
- `trunk` is aligned with `origin/trunk`.
- `HEAD` points at the release commit and `v<version>` tag.
