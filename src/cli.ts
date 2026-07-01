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
import {
  ENGINE_VERSION_RE,
  fetchAssetDetail,
  listLibrary,
  resolveAsset,
  whoami,
  type FabAssetSummary,
  type ResolvedAsset,
} from "./api.ts";
import { downloadAsset } from "./download.ts";
import { createInterface } from "node:readline/promises";

const USAGE = `epic-fab — Epic Games / Fab.com asset library on Linux

Commands:
  auth                       Authenticate via Epic OAuth (browser login + code paste)
  list [--json]              List owned Fab assets
  download <asset-id> [...]  Download asset(s) to disk
  sync --project <path>      Bulk-download library into a UE project's Content/
  whoami                     Show current authenticated Epic account
  logout                     Delete persisted auth tokens

Options:
  --engine <version>         UE engine version for artifact selection (default: UE_5.7)
  -h, --help                 Show this help
  -v, --version              Show version
`;

const VERSION = "0.1.0";

const EXIT_OK = 0;
const EXIT_USER_ERROR = 1;
const EXIT_NOT_AUTHENTICATED = 2;
const EXIT_NETWORK_ERROR = 3;

function findFlagValue(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
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

async function promptEngineVersion(available: string[]): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Enter a version from the list above (or 'q' to abort): ");
    const trimmed = answer.trim();
    if (trimmed === "q" || trimmed === "") return null;
    if (!available.includes(trimmed)) {
      console.error(`"${trimmed}" is not in the available versions.`);
      return null;
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

async function handleEngineResolution(
  tokens: import("./auth.ts").AuthTokens,
  resolved: ResolvedAsset,
): Promise<ResolvedAsset | null> {
  const { resolution } = resolved;

  switch (resolution.matchType) {
    case "exact":
      return resolved;

    case "fallback":
      console.error(
        `Engine ${resolution.requested} not available for "${resolved.summary.title}". Using ${resolution.selected} (highest compatible version).`,
      );
      return resolved;

    case "higher-only":
      console.error(
        `Engine ${resolution.requested} not available for "${resolved.summary.title}".`,
      );
      console.error(`Available versions: ${resolution.available.join(", ")}`);
      const picked = await promptEngineVersion(resolution.available);
      if (!picked) return null;
      return resolveAsset(tokens, resolved.summary.id, picked);

    case "none":
      console.error(
        `No engine versions found for "${resolved.summary.title}".`,
      );
      return null;
  }
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

async function cmdList(): Promise<number> {
  const tokens = await loadAndRefresh();
  if (!tokens) {
    console.error("Not authenticated. Run: epic-fab auth");
    return EXIT_NOT_AUTHENTICATED;
  }

  try {
    const items = await listLibrary(tokens);
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

async function cmdDownload(argv: ReadonlyArray<string>, engineVersion: string): Promise<number> {
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
  try {
    const resolved = await resolveAsset(tokens, assetId, engineVersion);
    const finalResolved = await handleEngineResolution(tokens, resolved);
    if (!finalResolved) return EXIT_USER_ERROR;

    const asset = await fetchAssetDetail(tokens, finalResolved);
    const result = await downloadAsset(asset, {
      targetDir: resolve(into),
      preserveStructure: true,
    });
    console.log(
      JSON.stringify(
        {
          asset: { id: asset.id, title: asset.title },
          files: result.files,
          bytesTotal: result.bytesTotal,
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

async function cmdSync(argv: ReadonlyArray<string>, engineVersion: string): Promise<number> {
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

  const fabRoot = join(resolvedProject, "Content", "Fab");
  try {
    const items = await listLibrary(tokens);
    const synced: Array<{ id: string; title: string; files: number; bytes: number }> = [];

    for (const item of items) {
      const resolved = await resolveAsset(tokens, item.id, engineVersion);
      const finalResolved = await handleEngineResolution(tokens, resolved);
      if (!finalResolved) {
        console.error(`Skipping "${item.title}" (no compatible engine version)`);
        continue;
      }

      const detail = await fetchAssetDetail(tokens, finalResolved);
      const targetDir = join(fabRoot, assetSlug(detail));
      const result = await downloadAsset(detail, { targetDir, preserveStructure: true });
      synced.push({
        id: detail.id,
        title: detail.title,
        files: result.files.length,
        bytes: result.bytesTotal,
      });
    }

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
  const engineVersion = findFlagValue(argv, "--engine") ?? "UE_5.7";

  if (!ENGINE_VERSION_RE.test(engineVersion)) {
    console.error(`Invalid --engine value: "${engineVersion}". Expected format: UE_X.Y (e.g., UE_5.7)`);
    return EXIT_USER_ERROR;
  }

  switch (command) {
    case "auth":
      return cmdAuth();
    case "list":
      return cmdList();
    case "download":
      return cmdDownload(rest, engineVersion);
    case "sync":
      return cmdSync(rest, engineVersion);
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
