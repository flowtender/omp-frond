# HTTPS

omp-web serves plain HTTP by default. Use HTTPS when the browser reaches omp-web
over a network, for example from a phone. The login password and session cookie
are readable on the wire over plain HTTP. Native HTTPS marks the session cookie
`Secure`; reverse proxies must explicitly enable secure cookies as described below.

omp-web can terminate TLS itself with a certificate and private key you supply.
You can also keep omp-web on plain HTTP behind a reverse proxy that terminates
TLS. Both options are described below.

## Option 1: native HTTPS in omp-web

Pass the certificate and key with flags or environment variables. Both are
required together:

```bash
omp-frond --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

| Flag | Environment variable | Meaning |
| --- | --- | --- |
| `--tls-cert <file>` | `OMP_WEB_TLS_CERT` | PEM certificate (or chain) |
| `--tls-key <file>` | `OMP_WEB_TLS_KEY` | PEM private key matching the certificate |

Rules:

- A flag wins over its environment variable.
- Giving only one of the two is an error. omp-web never falls back to HTTP
  silently.
- The files are read and checked before any password prompt. A missing,
  unreadable, or mismatched pair stops the launch with a message naming the file.
- Relative paths are resolved from the directory you start omp-web in.
- Keep the private key readable only by your user, for example `chmod 600`.

With HTTPS enabled, the browser URL is `https://<hostname>:<port>`. Next.js itself
listens only on `127.0.0.1` on an internal port, so only the HTTPS listener is
reachable from the network.

Set `--hostname` (or `OMP_WEB_HOSTNAME`) to the address the phone connects to,
for example your Tailscale address or `0.0.0.0` on a trusted LAN. If you
connect using a name, the name must be allowed (see [Host allow-list](#host-allow-list)).

## Certificates for localhost (mkcert)

[mkcert](https://github.com/FiloSottile/mkcert) creates a local certificate
authority and certificates it trusts. This is useful when the browser runs on
the same machine as omp-web.

```bash
mkcert -install
mkcert localhost 127.0.0.1 ::1
```

This writes two files to the current directory, named after the first name
(`localhost+2.pem` and `localhost+2-key.pem`). Then start omp-web:

```bash
omp-frond --hostname 127.0.0.1 \
  --tls-cert ./localhost+2.pem \
  --tls-key ./localhost+2-key.pem
```

Open `https://localhost:30141` in the browser. Certificates from mkcert are
trusted only on machines where `mkcert -install` ran. A phone does not trust
them unless you install the mkcert root CA on it. For a phone, use the Tailscale
certificate below.

## Certificates for a Tailscale address (phone access)

Tailscale issues publicly trusted certificates for the machine names in your
tailnet. Phones on the tailnet trust them without extra setup.

1. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS
   Certificates** for your tailnet.
2. Find the full machine name of the computer running omp-web, which has the
   form `<machine>.<tailnet>.ts.net`:

   ```bash
   tailscale status --self
   ```

3. Create the certificate and key. The files are written to the current
   directory, named after the machine:

   ```bash
   sudo tailscale cert \
     --cert-file ./<machine>.<tailnet>.ts.net.crt \
     --key-file ./<machine>.<tailnet>.ts.net.key \
     <machine>.<tailnet>.ts.net
   ```

   Make the key readable only by your user, for example `sudo chown "$USER"`
   the key file and `chmod 600` it.

4. Start omp-web on the tailnet address, allowing the tailnet name:

   ```bash
   OMP_WEB_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net \
   omp-frond --hostname 0.0.0.0 --no-open \
     --tls-cert ./<machine>.<tailnet>.ts.net.crt \
     --tls-key ./<machine>.<tailnet>.ts.net.key \
     --authenticated
   ```

5. On the phone, open `https://<machine>.<tailnet>.ts.net:30141`.

Tailscale certificates expire after about 90 days. Run step 3 again to renew
them, then restart omp-web.

Use `--hostname 0.0.0.0` only on a network you trust, or bind to your Tailscale
IP address (`tailscale ip -4`) instead. Add `--authenticated` before exposing
omp-web beyond loopback so that a password is required.

## Host allow-list

omp-web rejects requests whose `Host` header is not allowed. Allowed names are:

- the value of `--hostname` / `OMP_WEB_HOSTNAME`,
- loopback names and IP literals, and
- the comma-separated names in `OMP_WEB_ALLOWED_HOSTS`.

A phone that opens `https://<machine>.<tailnet>.ts.net:30141` must therefore have
that name in `OMP_WEB_ALLOWED_HOSTS` (or be the `--hostname` value).

## Option 2: reverse proxy terminates TLS

You can keep omp-web on plain HTTP on loopback and let a reverse proxy (nginx,
Caddy, and similar) serve HTTPS in front of it. Run omp-web without the TLS
options and tell it that the public connection is HTTPS:

```bash
OMP_WEB_SECURE_COOKIES=1 omp-frond --no-open
```

`OMP_WEB_SECURE_COOKIES=1` is the required setting for a reverse proxy. omp-web
does not read `X-Forwarded-Proto` or other forwarded headers to decide whether a
connection is secure, because a client can send those headers itself. Without
`OMP_WEB_SECURE_COOKIES=1`, the session cookie is not marked `Secure` when the
browser connects over HTTPS through the proxy.

Keep the proxy forwarding the `Host` header unchanged, and add that name to
`OMP_WEB_ALLOWED_HOSTS` as described above.

## Summary of environment variables

| Variable | Purpose |
| --- | --- |
| `OMP_WEB_TLS_CERT` | Certificate path for native HTTPS (also set by the launcher for the server process) |
| `OMP_WEB_TLS_KEY` | Private key path for native HTTPS (also set by the launcher for the server process) |
| `OMP_WEB_SECURE_COOKIES` | Set to `1` when a reverse proxy serves HTTPS |
| `OMP_WEB_ALLOWED_HOSTS` | Comma-separated extra `Host` names to accept |
