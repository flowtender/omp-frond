# Bun hosts the pinned TypeScript OMP SDK in its own managed worker.
ARG BUN_VERSION=1.4.4

# ---------------------------------------------------------------------------
# Dependencies shared by the web build and standalone worker.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS deps

WORKDIR /app

# Manifests first, so the dependency layer is reused until they actually change.
COPY package.json bun.lock ./
COPY bin/prepare-terminal.js ./bin/
RUN bun --bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

# ---------------------------------------------------------------------------
# Common runtime with the pinned SDK. The standalone target never builds Next.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS worker-base

# git is a runtime dependency, not a build-time one: the worktree switcher, the
# diff view and skill updates all shell out to it (lib/worktree.ts,
# lib/git-changes.ts, lib/skill-updates.ts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Bind mounts keep their host ownership, so the container user has to match the
# user that owns `~/.omp` and the project checkouts on the host. 1000 is the
# usual first human account on Linux; override for anything else:
#   docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) .
# Docker Desktop on macOS and Windows remaps ownership itself and needs neither.
ARG UID=1000
ARG GID=1000
RUN test "${UID}" -gt 0 && test "${GID}" -gt 0 \
 && (getent group "${GID}" >/dev/null || groupadd --gid "${GID}" omp) \
 && (getent passwd "${UID}" >/dev/null || useradd --uid "${UID}" --gid "${GID}" --home-dir /home/omp omp) \
 && mkdir -p /home/omp/.omp/agent /workspace \
 && chown -R "${UID}:${GID}" /home/omp /workspace

WORKDIR /app

# Keep the pinned SDK and its native dependencies available to the worker.
COPY --from=deps --chown=${UID}:${GID} /app/node_modules ./node_modules
COPY --chown=${UID}:${GID} bin ./bin
COPY --chown=${UID}:${GID} worker ./worker
COPY --chown=${UID}:${GID} lib ./lib
COPY --chown=${UID}:${GID} tsconfig.json package.json ./

ENV HOME=/home/omp NODE_ENV=production
USER ${UID}:${GID}
WORKDIR /workspace

FROM worker-base AS worker
ENV PI_CODING_AGENT_DIR=/home/omp/.omp/agent \
    OMP_FROND_WORKER_WORKSPACE=/workspace
ENTRYPOINT ["bun", "--no-env-file", "/app/worker/main.ts"]

FROM worker-base AS runtime
WORKDIR /app
COPY --from=build --chown=${UID}:${GID} /app/.next ./.next
COPY --from=build --chown=${UID}:${GID} /app/public ./public
COPY --chown=${UID}:${GID} next.config.ts ./

# OMP_FROND_HOSTNAME binds every interface because a container is only reachable
# from outside when it does; publish the port to 127.0.0.1 on the host to keep
# it local. OMP_FROND_NO_OPEN because there is no browser in here to open.
ENV PORT=30141 \
    OMP_FROND_HOSTNAME=0.0.0.0 \
    OMP_FROND_NO_OPEN=1

# `~/.omp/agent` is the directory the omp CLI writes: mount the host's copy here
# and a terminal session continues in the browser. `/workspace` is the default
# project root, and is where relative project paths resolve.
VOLUME ["/home/omp/.omp"]
EXPOSE 30141

# Not /app: the launcher records its own cwd as OMP_FROND_LAUNCH_CWD so relative
# project paths in the browser resolve against it.
WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun --eval 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 30141}/`); process.exit(r.status < 500 ? 0 : 1)'

# The published CLI, so the container honours the same flags and environment
# variables as a local `omp-frond` — including `--authenticated`.
ENTRYPOINT ["bun", "/app/bin/omp-frond.js"]
