# Security Policy

## What this tool holds

`epic-fab` authenticates against Epic Games and persists OAuth tokens to:

```
$XDG_CONFIG_HOME/epic-fab/auth.json   (default: ~/.config/epic-fab/auth.json)
```

The directory is created `0700` and the file is written `0600` via a temp-file +
`rename` so it is never briefly world-readable. Those tokens grant access to the
account's Fab library and identity. Treat the file like an SSH private key.

`epic-fab` never logs, prints, or transmits tokens anywhere other than Epic's own
`account-public-service-prod03.ol.epicgames.com` token endpoint.

## Reporting a vulnerability

Open a private security advisory through GitHub on this repository rather than a
public issue. Please include a reproduction and the version (`epic-fab --version`).

## Design rule: epic-fab does not open a network listener

**`epic-fab` is a CLI. It makes outbound HTTPS calls to Epic and nothing else. It
does not bind a port.** This is a deliberate security boundary, enforced by
`scripts/no-listener-guard.ts` (`bun run guard`), which fails the build if a
listener is introduced.

The reason is specific. A local web UI was proposed that called:

```ts
Bun.serve({ port: opts.port, fetch: handler })   // no hostname → binds 0.0.0.0
```

with four state-changing routes and no request-origin validation:

| Route | Effect |
|---|---|
| `POST /api/auth` | Writes Epic OAuth tokens to disk |
| `POST /api/logout` | Deletes tokens — logs the user out |
| `POST /api/download` | Starts a download; caller-controlled `into` path |
| `POST /api/download/<jobId>/cancel` | Aborts an in-flight job |

plus `GET /api/status`, `/api/library`, `/api/jobs`, `/api/events`, which return
the account's identity and full owned-asset library.

Two separate attackers reach that server:

1. **Anyone on the same network.** Bun's `serve()` defaults to `0.0.0.0` when no
   `hostname` is given. On shared Wi-Fi, a hotel network, or a home LAN with an
   untrusted device, `curl http://<your-ip>:<port>/api/library` returns the
   user's Epic identity, and a POST logs them out or triggers downloads.

2. **Any website the user visits.** `localhost` is not a security boundary in a
   browser. With no CSRF token and no `Origin` check, a page at
   `https://example.com` can issue a cross-origin `fetch()` or auto-submit a form
   to `http://localhost:<port>/api/logout`. Without a `Host` check, DNS rebinding
   also reaches the same routes and can read responses.

**If a local UI is ever added, it must satisfy all four of these — not three:**

1. **Bind loopback explicitly** — `Bun.serve({ hostname: "127.0.0.1", port })`.
   Never rely on the default.
2. **Reject cross-origin requests** — require `Origin` to be exactly
   `http://127.0.0.1:<port>` or `http://localhost:<port>` on every state-changing
   method. Absent `Origin` on a POST is a rejection, not a pass.
3. **Validate `Host`** — accept only `127.0.0.1:<port>` / `localhost:<port>`.
   This is what stops DNS rebinding; the `Origin` check alone does not.
4. **Require an unguessable per-session token** — printed to the terminal at
   startup and sent as a header (not a cookie, so it cannot ride along
   automatically) on every state-changing request.

Additionally: the download target path must be validated against traversal
before use, since an unvalidated `into` on a reachable route is an arbitrary
filesystem write, which is a worse outcome than the token exposure.

## Supported versions

Only the latest release on `master` receives security fixes.
