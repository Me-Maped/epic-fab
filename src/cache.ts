// Local library cache. The Fab /ue/library walk is the hot path — getAsset() re-walks it
// for every resolution, so a sync over N assets used to cost N+1 full fetches. This module
// persists the summarized library per-account under the XDG cache dir; callers decide
// freshness vs. stale-fallback policy.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { FabAssetSummary } from "./api.ts";

export const LIBRARY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export interface LibraryCache {
  /** ISO timestamp of the successful network fetch. */
  fetchedAt: string;
  accountId: string;
  assets: FabAssetSummary[];
}

export function libraryCachePath(accountId: string): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "epic-fab", `library-${accountId}.json`);
}

function parseCache(raw: string, accountId: string): LibraryCache | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "fetchedAt" in parsed &&
      "accountId" in parsed &&
      "assets" in parsed &&
      typeof (parsed as LibraryCache).fetchedAt === "string" &&
      Array.isArray((parsed as LibraryCache).assets)
    ) {
      const cache = parsed as LibraryCache;
      // Cache is per-account — never serve another user's library.
      if (cache.accountId !== accountId) return null;
      return cache;
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadLibraryCache(
  accountId: string,
  maxAgeMs: number = LIBRARY_CACHE_TTL_MS,
): Promise<LibraryCache | null> {
  let raw: string;
  try {
    raw = await readFile(libraryCachePath(accountId), "utf8");
  } catch {
    return null;
  }
  const cache = parseCache(raw, accountId);
  if (!cache) return null;
  const fetchedMs = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedMs) || Date.now() - fetchedMs > maxAgeMs) {
    // Stale — return null and let the caller decide whether to refetch or fall back.
    return null;
  }
  return cache;
}

export async function loadLibraryCacheAllowStale(accountId: string): Promise<LibraryCache | null> {
  let raw: string;
  try {
    raw = await readFile(libraryCachePath(accountId), "utf8");
  } catch {
    return null;
  }
  return parseCache(raw, accountId);
}

export async function saveLibraryCache(
  accountId: string,
  assets: FabAssetSummary[],
): Promise<void> {
  const path = libraryCachePath(accountId);
  await mkdir(dirname(path), { recursive: true });
  const payload: LibraryCache = {
    fetchedAt: new Date().toISOString(),
    accountId,
    assets,
  };
  const tmp = `${path}.tmp`;
  // Write sibling .tmp then rename — a killed process never leaves a truncated cache.
  await writeFile(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o644 });
  await rename(tmp, path);
}
