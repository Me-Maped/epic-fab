#!/usr/bin/env bun
// epic-fab — Linux-native CLI for Epic Games / Fab.com asset library.

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  clearTokens,
  loadTokens,
  refreshIfNeeded,
  startBrowserAuth,
  type AuthTokens,
} from "./auth.ts";
import { getAsset, listLibraryCached, whoami, type FabAssetSummary } from "./api.ts";
import { downloadAsset } from "./download.ts";
import { startUiServer } from "./serve.ts";

const USAGE = `epic-fab — Epic Games / Fab.com asset library on Linux

Commands:
  auth                       Authenticate via Epic OAuth (browser login + code paste)
  list [--json]              List owned Fab assets
  download <asset-id> [...]  Download asset(s) to disk
  sync --project <path>      Bulk-download library into a UE project's Content/
  ui [--port <n>] [--no-open]  Serve local web UI (default port 8471)
  whoami                     Show current authenticated Epic account
  logout                     Delete persisted auth tokens

Options:
  -h, --help                 Show this help
  -v, --version              Show version
  --into <dir>               download: target directory (default .)
  --project <path>           sync: UE project root
  --concurrency <n>          CDN chunk fetch concurrency (default 8)
  --no-skip                  Redownload even when on-disk SHA1 matches
  --refresh                  Bypass local library cache, force re-fetch
  --port <n>                 ui: listen port (default 8471)
  --no-open                  ui: do not auto-open the browser
`;

const VERSION = "0.1.0";

const DEFAULT_UI_PORT = 8471;

const EXIT_OK = 0;
const EXIT_USER_ERROR = 1;
const EXIT_NOT_AUTHENTICATED = 2;
const EXIT_NETWORK_ERROR = 3;

function findFlagValue(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.includes(name);
}

/** Progress/status on stderr so stdout stays JSON-pipeable. */
function status(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseConcurrency(argv: ReadonlyArray<string>): number | undefined {
  const raw = findFlagValue(argv, "--concurrency");
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 64) {
    throw new Error(`--concurrency must be an integer 1–64, got ${raw}`);
  }
  return n;
}

async function loadAndRefresh(): Promise<AuthTokens | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;
  return refreshIfNeeded(tokens);
}

function assetSlug(asset: FabAssetSummary): string {
  const candidate = asset.title.length > 0 ? asset.title : asset.id;
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : asset.id;
}

async function cmdAuth(): Promise<number> {
  try {
    const tokens = await startBrowserAuth();
    console.log(`Authenticated as ${tokens.displayName}`);
    return EXIT_OK;
  } catch (err) {
    console.error(`auth failed: ${(err as Error).message}`);
    return EXIT_NETWORK_ERROR;
  }
}

async function cmdList(argv: ReadonlyArray<string>): Promise<number> {
  const tokens = await loadAndRefresh();
  if (!tokens) {
    console.error("Not authenticated. Run: epic-fab auth");
    return EXIT_NOT_AUTHENTICATED;
  }

  try {
    const items = await listLibraryCached(tokens, { forceRefresh: hasFlag(argv, "--refresh") });
    // JSON is the default output — the brief calls for stdout-pipeable output. --json is accepted
    // as an explicit synonym (no-op) so users have a stable contract if a non-JSON mode lands later.
    const projected = items.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      ownedAt: item.ownedAt,
    }));
    console.log(JSON.stringify(projected, null, 2));
    return EXIT_OK;
  } catch (err) {
    console.error(`list failed: ${(err as Error).message}`);
    return EXIT_NETWORK_ERROR;
  }
}

async function cmdDownload(argv: ReadonlyArray<string>): Promise<number> {
  const assetId = argv[0];
  if (!assetId || assetId.startsWith("-")) {
    console.error("download: missing <asset-id>");
    return EXIT_USER_ERROR;
  }

  const tokens = await loadAndRefresh();
  if (!tokens) {
    console.error("Not authenticated. Run: epic-fab auth");
    return EXIT_NOT_AUTHENTICATED;
  }

  const into = findFlagValue(argv, "--into") ?? ".";
  let concurrency: number | undefined;
  try {
    concurrency = parseConcurrency(argv);
  } catch (err) {
    console.error(`download: ${(err as Error).message}`);
    return EXIT_USER_ERROR;
  }
  const skipExisting = !hasFlag(argv, "--no-skip");
  const forceRefresh = hasFlag(argv, "--refresh");
  const targetDir = resolve(into);

  try {
    status(`Resolving asset ${assetId}…`);
    status("Fetching library and signed manifest…");
    const asset = await getAsset(tokens, assetId, "UE_5.7", { forceRefresh });
    status(
      `Resolved “${asset.title}” — ${asset.downloadUrls.length} file(s), ${asset.chunkInfoById.size} unique chunk(s)`,
    );
    status(`Downloading into ${targetDir}`);
    const result = await downloadAsset(asset, {
      targetDir,
      preserveStructure: true,
      concurrency,
      skipExisting,
    });
    status(
      `Done — ${result.files.length} file(s), ${result.bytesTotal} bytes` +
        (result.skipped > 0 ? ` (${result.skipped} skipped)` : ""),
    );
    console.log(
      JSON.stringify(
        {
          asset: { id: asset.id, title: asset.title },
          files: result.files,
          bytesTotal: result.bytesTotal,
          skipped: result.skipped,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  } catch (err) {
    console.error(`download failed: ${(err as Error).message}`);
    return EXIT_NETWORK_ERROR;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function hasUprojectFile(path: string): Promise<boolean> {
  const entries = await readdir(path);
  return entries.some((entry) => entry.endsWith(".uproject"));
}

async function cmdSync(argv: ReadonlyArray<string>): Promise<number> {
  const projectPath = findFlagValue(argv, "--project");
  if (!projectPath) {
    console.error("sync: missing --project <path>");
    return EXIT_USER_ERROR;
  }

  const resolvedProject = resolve(projectPath);
  if (!(await isDirectory(resolvedProject))) {
    console.error(`sync: ${resolvedProject} is not a directory`);
    return EXIT_USER_ERROR;
  }
  if (!(await hasUprojectFile(resolvedProject))) {
    console.error(`sync: ${resolvedProject} contains no .uproject file`);
    return EXIT_USER_ERROR;
  }

  const tokens = await loadAndRefresh();
  if (!tokens) {
    console.error("Not authenticated. Run: epic-fab auth");
    return EXIT_NOT_AUTHENTICATED;
  }

  let concurrency: number | undefined;
  try {
    concurrency = parseConcurrency(argv);
  } catch (err) {
    console.error(`sync: ${(err as Error).message}`);
    return EXIT_USER_ERROR;
  }
  const skipExisting = !hasFlag(argv, "--no-skip");
  const forceRefresh = hasFlag(argv, "--refresh");

  const fabRoot = join(resolvedProject, "Content", "Fab");
  try {
    status("Fetching library…");
    const items = await listLibraryCached(tokens, { forceRefresh });
    status(`Library has ${items.length} asset(s) — syncing into ${fabRoot}`);
    const synced: Array<{
      id: string;
      title: string;
      files: number;
      bytes: number;
      skipped: number;
    }> = [];

    let assetIndex = 0;
    for (const item of items) {
      assetIndex += 1;
      status(`[asset ${assetIndex}/${items.length}] Resolving ${item.id}…`);
      const detail = await getAsset(tokens, item.id, "UE_5.7", { forceRefresh });
      status(
        `[asset ${assetIndex}/${items.length}] “${detail.title}” — ${detail.downloadUrls.length} file(s)`,
      );
      const targetDir = join(fabRoot, assetSlug(detail));
      const result = await downloadAsset(detail, {
        targetDir,
        preserveStructure: true,
        concurrency,
        skipExisting,
      });
      synced.push({
        id: detail.id,
        title: detail.title,
        files: result.files.length,
        bytes: result.bytesTotal,
        skipped: result.skipped,
      });
    }

    status(`Sync complete — ${synced.length} asset(s)`);
    console.log(
      JSON.stringify(
        {
          project: resolvedProject,
          fabRoot,
          assets: synced,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  } catch (err) {
    console.error(`sync failed: ${(err as Error).message}`);
    return EXIT_NETWORK_ERROR;
  }
}

function parsePort(argv: ReadonlyArray<string>): number {
  const raw = findFlagValue(argv, "--port");
  if (raw === undefined) return DEFAULT_UI_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 1 || n > 65535) {
    throw new Error(`--port must be an integer 1–65535, got ${raw}`);
  }
  return n;
}

async function cmdUi(argv: ReadonlyArray<string>): Promise<number> {
  let port: number;
  try {
    port = parsePort(argv);
  } catch (err) {
    console.error(`ui: ${(err as Error).message}`);
    return EXIT_USER_ERROR;
  }
  const openBrowser = !hasFlag(argv, "--no-open");

  try {
    startUiServer({ port, openBrowser });
    // Keep the process alive — Bun.serve handles requests until killed.
    await new Promise<void>(() => undefined);
    return EXIT_OK;
  } catch (err) {
    console.error(`ui failed: ${(err as Error).message}`);
    return EXIT_NETWORK_ERROR;
  }
}

async function cmdWhoami(): Promise<number> {
  const tokens = await loadTokens();
  if (!tokens) {
    console.error("Not authenticated. Run: epic-fab auth");
    return EXIT_NOT_AUTHENTICATED;
  }
  console.log(JSON.stringify(whoami(tokens), null, 2));
  return EXIT_OK;
}

async function cmdLogout(): Promise<number> {
  await clearTokens();
  console.log("Logged out");
  return EXIT_OK;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (!command || command === "-h" || command === "--help") {
    console.log(USAGE);
    return EXIT_OK;
  }

  if (command === "-v" || command === "--version") {
    console.log(VERSION);
    return EXIT_OK;
  }

  const rest = argv.slice(1);

  switch (command) {
    case "auth":
      return cmdAuth();
    case "list":
      return cmdList(rest);
    case "download":
      return cmdDownload(rest);
    case "sync":
      return cmdSync(rest);
    case "ui":
      return cmdUi(rest);
    case "whoami":
      return cmdWhoami();
    case "logout":
      return cmdLogout();
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return EXIT_USER_ERROR;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
