# Password access

omp-frond drives a coding agent that reads and writes files, runs shell commands,
and spends provider credits. Anything that can reach the port can do all of
that. On loopback that is exactly the intent; the moment omp-frond listens on a
LAN address or sits behind a tunnel, it needs a lock.

The lock uses a password sign-in page and server-validated session cookies, not
browser-managed HTTP Basic authentication. It works in installed PWAs without
a native browser credentials dialog.

## Turning it on

Three ways in, in the order most people reach for them:

**From the browser.** Settings → **Access**. Set a password, and password access
turns on with it. The same panel switches the lock off without forgetting the
password, and removes the password entirely.

**From the command line.**

```bash
omp-frond --authenticated
```

Turns password access on for this run and for every later one. If no password
has ever been set, omp-frond asks for one on the terminal before the server
starts, so a run that was told to be locked can never come up unlocked. If a
password is already stored, the flag just switches the lock back on.

`OMP_FROND_AUTHENTICATED=1` does the same thing from the environment.

Non-interactive launches — systemd, Docker, `omp-frond &` — cannot answer a
prompt, so `--authenticated` fails there with a message instead of hanging. Set
the password once interactively, or use the environment variable below.

**From the environment.**

```bash
OMP_FROND_PASSWORD='a-long-random-password' omp-frond
```

The variable overrides the stored credential completely: while it is set, the
settings panel is read-only and recovery has nothing to reset. Leaving it unset
or empty hands control back to the stored credential.

## How the password is stored

In `<agentDir>/omp-frond-auth.json` — normally `~/.omp/agent/omp-frond-auth.json` —
created with mode `0600` and replaced atomically. The file holds a `scrypt`
digest, the random salt that produced it, and the cost parameters. **The
password itself is never written anywhere.**

That is the whole reason recovery exists rather than a "show password" button:
nothing on the machine can turn the file back into the password.

`OMP_FROND_AUTH_FILE` overrides the location. Set it if you have migrated omp's
state to XDG directories, or if you want the credential somewhere else entirely;
`bin/omp-frond.js` resolves the path once and passes it to the server, so the two
halves can never disagree.

Password verification is timing-safe. Successful password verifications are
cached for five minutes, keyed by the credential digest. Authenticated API
requests validate the session instead of resending or rehashing the password.

## Login sessions

Open `/login` and enter the password. A successful login sets an HttpOnly,
SameSite=Strict cookie with a 30-day lifetime. The cookie is persistent, so
closing and reopening the PWA does not require another login.

The server stores each session in `<credential-file>.sessions/` (directory mode
`0700`, session files `0600`). Filenames hash the random bearer token; file
contents contain only a credential fingerprint and expiration time. Neither
the bearer token nor the plaintext password is stored there. Sessions survive
server restarts; missing, expired, malformed, or revoked sessions grant no access.

**Settings → Access → Sign out of this device** deletes the server-side session
and clears its cookie. A copied cookie cannot be replayed after logout.
Replacing or recovering the password invalidates all existing sessions,
including sessions on other devices. Changing `OMP_FROND_PASSWORD` does the same.

Unauthenticated page loads redirect to `/login`; API calls return `401` without
a Basic challenge. Open app windows also check their session on visibility,
reconnection, and every minute while visible, returning to login when access
expires. Offline windows keep their screen until connectivity returns.

Password guesses at the login endpoint use the shared exponential backoff:
`429` responses include `Retry-After`. Successful logins do not reset the
failure counter. Host and cross-site checks run before login and logout.

Native HTTPS marks session cookies Secure automatically. When a trusted reverse
proxy terminates HTTPS, set `OMP_FROND_SECURE_COOKIES=1`; forwarded headers alone
are not trusted for that decision. HTTP without Secure cookies is retained for
loopback and trusted-network deployments. See [HTTPS](./https.md) for certificates.

If the credential file exists but cannot be parsed while the lock is on, omp-frond
answers `503` to everything rather than assuming it should unlock. Use
`--reset-password` to get out of that state.

## Recovering a forgotten password

Both paths prove access to the machine running the server. Neither can hand the
old password back.

**From a shell on that machine:**

```bash
omp-frond --reset-password
```

Asks for a new password, stores it, and starts the server.

**From a browser**, when you have a terminal but not a shell prompt on the
server — a tmux pane, a service log, a Docker `logs` stream:

1. Open `/recover`. The recovery page and API are reachable without credentials,
   as are the login page and API.
2. Ask for a recovery code. omp-frond prints it **on its own console** — the
   terminal running the server — and never returns it over HTTP.
3. Type the code and a new password into the page.

Recovery codes carry 60 bits of entropy, expire after 10 minutes, allow five
wrong attempts before being discarded, are single-use, and are themselves stored
only as a digest. A new code can be minted at most once every 30 seconds.

This means an unauthenticated caller who finds `/recover` on a scan can make the
server print codes on a console they cannot see. That is the entire extent of
what they gain.

## What this does not protect

Password login authenticates; it does not encrypt. Both the login password and
session cookie are readable over plain HTTP on an untrusted network.

Use [native HTTPS](./https.md), a trusted HTTPS reverse proxy, or a trusted VPN
before exposing omp-frond beyond loopback.

Separately from the password, API requests are accepted only for loopback names,
IP literals, the bind hostname, and the exact names listed in
`OMP_FROND_ALLOWED_HOSTS`; cross-site browser requests are rejected outright.
Those checks run before authentication and apply to `/recover` too.
