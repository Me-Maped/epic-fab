#!/usr/bin/env bun
// no-listener-guard — fails the build if epic-fab grows a network listener.
//
// Why this exists
// ---------------
// epic-fab is a CLI that holds Epic Games OAuth tokens at ~/.config/epic-fab/auth.json.
// A contributed local web UI (PR #2, commit "feat: web ui") added `Bun.serve({ port })`
// with no `hostname` argument. Bun defaults that to 0.0.0.0 — every interface, not
// loopback — and exposed four state-changing POST routes (/api/auth, /api/logout,
// /api/download, /api/download/<id>/cancel) with no Origin, Host, or CSRF validation.
//
// That is reachable two ways:
//   1. anyone on the same LAN, because the bind is 0.0.0.0 rather than 127.0.0.1;
//   2. any website the user visits, because a page can cross-origin POST to
//      http://localhost:<port>/api/logout or /api/download with no token to stop it.
//
// The UI was declined rather than patched. This guard makes that decision durable:
// a listener cannot land again without someone deliberately deleting this check.
//
// If you are adding a local UI on purpose, do not delete this file. Read SECURITY.md
// first and satisfy all four requirements listed there, then extend ALLOWED below.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Directories never scanned — third-party code and VCS metadata. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".github", "docs"]);

/** Patterns that create an inbound network listener. Outbound fetch() is unaffected. */
const LISTENER_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bBun\.serve\s*\(/, what: "Bun.serve() — binds 0.0.0.0 unless hostname is set" },
  { re: /\bDeno\.serve\s*\(/, what: "Deno.serve()" },
  { re: /\bcreateServer\s*\(/, what: "http/https/net createServer()" },
  { re: /\bnew\s+WebSocketServer\b/, what: "WebSocketServer" },
  { re: /\.listen\s*\(\s*\d/, what: ".listen(port)" },
  { re: /\b0\.0\.0\.0\b/, what: "literal 0.0.0.0 bind address" },
];

/**
 * Files explicitly reviewed and permitted to contain the above.
 * This guard file itself documents the patterns it bans, so it is exempt.
 */
const ALLOWED = new Set<string>(["scripts/no-listener-guard.ts"]);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

const findings: string[] = [];

// Whole repo, not just src/ — a listener in scripts/ or at the root is the same
// exposure with an extra step. node_modules and docs are skipped.
for await (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOWED.has(rel)) continue;

  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("//")) return; // comments describing the rule are fine
    for (const { re, what } of LISTENER_PATTERNS) {
      if (re.test(line)) findings.push(`${rel}:${i + 1}  ${what}\n    ${line.trim()}`);
    }
  });
}

if (findings.length > 0) {
  console.error("no-listener-guard: FAIL — epic-fab must not open a network listener.\n");
  for (const f of findings) console.error(`  ${f}\n`);
  console.error("epic-fab holds Epic OAuth tokens. A listener exposes them to the local");
  console.error("network and to CSRF from any visited website. See SECURITY.md before");
  console.error("adding any server, then add the reviewed file to ALLOWED in this script.");
  process.exit(1);
}

console.log("no-listener-guard: OK — no network listener in the repo");
process.exit(0);
