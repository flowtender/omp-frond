# Running omp-frond in Docker

The image builds omp-frond from source and runs that checkout's `bin/omp-frond.js` launcher
inside the container, so every flag and environment variable from the
[Quick Start](../README.md#quick-start) works the same way.

Two things make omp-frond different from an ordinary web app, and both shape how
the container has to be run:

- **The compatibility setup shares OMP data.** It mounts the host's
  `~/.omp` so the CLI and browser can see the same transcripts and settings.
  Use the restricted setup below when the agent must not see that host state.
- **It can run a high-privilege agent.** Whatever the container can reach, the
  agent can change. The container boundary is the containment here — keep it
  intact rather than widening it, and only mount the projects you want the
  agent to touch.

## Quick start

```bash
OMP_FROND_PASSWORD='a-long-random-password' \
OMP_UID=$(id -u) OMP_GID=$(id -g) docker compose up --build
```

Then open <http://127.0.0.1:30141> and enter that password on the sign-in page.

`docker-compose.yml` mounts `$HOME/.omp` and the current directory, publishes
the port on loopback only, and builds the image for the UID/GID you pass.
Override the rest with `OMP_HOME`, `OMP_FROND_WORKSPACE`, `OMP_FROND_PORT`, or put
any of these in a `.env` file next to the compose file.

The IDs are `OMP_UID`/`OMP_GID` rather than `UID`/`GID` because `UID` is
readonly in bash and cannot be set inline. Docker Desktop on macOS and Windows
needs neither — see [File ownership](#file-ownership).

## Restricted worker

`docker-compose.restricted.yml` runs the web service and SDK worker in separate
containers. Only the browser port is published. The authenticated worker
channel is on an internal Docker network; the worker has no external egress
unless the operator explicitly attaches another network.

```bash
export OMP_FROND_PASSWORD='a-long-random-password'
export OMP_FROND_WORKER_TOKEN="$(openssl rand -hex 32)"
export OMP_FROND_WORKSPACE=/path/to/the/chosen/workspace
docker compose -f docker-compose.restricted.yml up --build
```

The worker runs unprivileged with a read-only image filesystem. It can write to
the chosen workspace and its own named home volume. It receives neither the
host's agent home nor the web service's password or provider environment. Add
provider credentials to the worker explicitly and configure egress separately
if the chosen provider needs it. Project trust is still required for executable
project resources; it does not grant additional mounts or network access.

The file explorer, uploads and terminal use `/workspace` inside the worker.
Worktrees use the standard sibling directory only when both the repository and
the destination fit inside this mount. Mount the repository's parent directory
as the workspace if you want sibling worktrees. Requests outside the scoped
workspace are not redirected to the web host.

## Without compose

```bash
docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) -t omp-frond .

docker run --rm \
  -p 127.0.0.1:30141:30141 \
  -v "$HOME/.omp:/home/omp/.omp" \
  -v "$HOME/code:/workspace" \
  -e OMP_FROND_AUTHENTICATED=1 \
  -e OMP_FROND_PASSWORD='a-long-random-password' \
  omp-frond
```

Arguments after the image name reach the launcher directly:

```bash
docker run --rm -p 127.0.0.1:8080:8080 -e PORT=8080 omp-frond --port 8080
```

## File ownership

Bind mounts keep the ownership they have on the host, and the container runs as
a non-root user. On Linux, build the image with your own IDs
(`--build-arg UID=$(id -u) --build-arg GID=$(id -g)`, or `OMP_UID`/`OMP_GID`
under compose; the default is `1000`) or the server cannot write to the mounted
`~/.omp`. Docker Desktop on macOS and Windows remaps ownership itself, so the
defaults are fine there.

## Paths inside the container

| Path | What it holds |
| --- | --- |
| `/home/omp/.omp` | The omp home the CLI shares — sessions, `agent/config.yml`, the auth file. Mount it. |
| `/workspace` | Default project root, and what relative project paths resolve against. |
| `/app` | The build itself: `.next`, `node_modules`, `bin`. Immutable, do not mount over it. |

## Environment

The image presets `OMP_FROND_HOSTNAME=0.0.0.0` (a container is only reachable
when it binds every interface) and `OMP_FROND_NO_OPEN=1` (no browser in here to
open). Everything else behaves as documented in the README:

| Variable | Use |
| --- | --- |
| `PORT` | Port inside the container. Publish it with `-p`. |
| `OMP_FROND_AUTHENTICATED` | Require the password lock. |
| `OMP_FROND_PASSWORD` | The password, overriding any stored hash. |
| `OMP_FROND_ALLOWED_HOSTS` | Exact external hostname, when a reverse proxy fronts the container. |

`--authenticated` on its own asks for a password on the terminal, which a
detached container has none of. Pass `OMP_FROND_PASSWORD` instead, or set the
password once in **Settings → Access** and let it persist in the mounted
`~/.omp/agent/omp-frond-auth.json`.

## Exposing it beyond localhost

`0.0.0.0` inside the container is not the same as publishing on `0.0.0.0` on the
host — the `-p 127.0.0.1:30141:30141` above keeps it local. Before widening
that:

- Turn the password on. Protect the login password and session cookie with
  HTTPS at a trusted reverse proxy. Set `OMP_FROND_SECURE_COOKIES=1` in the
  container and `OMP_FROND_ALLOWED_HOSTS` to the hostname that proxy uses.
- Remember that the agent runs with the container's access to the mounts you
  gave it. Mount the narrowest project tree that is useful.

Full threat model for the password lock: [authentication.md](./authentication.md).

## What the image does not do

It runs omp-frond, and only omp-frond. It does not reach out to the host: an image
that `nsenter`s into the host's namespaces to run a build living on the host
filesystem would need `--privileged --pid=host`, would be tied to that one
machine's paths, and would give the agent the host rather than the container.
If you already run omp-frond from a checkout on the host, run it there with
`omp-frond` or a systemd unit — that is the simpler deployment, and this image is
for the case where you want it contained.
