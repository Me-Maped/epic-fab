// Asset download + chunk reassembly. Implements step 2-and-a-half of docs/api-surface.md §3.4:
// walks the parsed manifest's per-file chunk-part list, fetches each unique chunk from the CDN
// (cached, deduplicated, bounded concurrency), slices the requested byte range out of each
// decoded chunk payload, and assembles the file on disk.

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

import type { FabAssetDetail, FabDownloadFile } from "./api.ts";
import { chunkPath, decodeChunkPayload, type ChunkInfo, type ChunkPart } from "./manifestParser.ts";

export interface DownloadOptions {
  targetDir: string;
  preserveStructure: boolean;
  /** Max concurrent CDN chunk fetches. Default 8; Epic CDNs often rate-limit around 16+. */
  concurrency?: number;
  /** Skip files whose on-disk SHA1 already matches the manifest. Default true. */
  skipExisting?: boolean;
  /** Retries per CDN base URL on transient fetch failures. Default 2. */
  retries?: number;
}

const DEFAULT_CHUNK_CONCURRENCY = 8;
const DEFAULT_RETRIES = 2;

function safeRelativePath(filename: string): string {
  // Defense against malicious filenames in manifest entries: collapse `..`, drop absolute roots.
  // Manifests carry Windows-style backslashes; normalize first so split(sep) catches both.
  const unix = filename.replace(/\\/g, "/");
  const normalized = normalize(unix).replace(/^([/\\]+)/, "");
  const parts = normalized.split(/[/\\]/).filter((part) => part.length > 0 && part !== "..");
  return parts.join(sep);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchChunkBytes(
  chunk: ChunkInfo,
  distributionBaseUrls: ReadonlyArray<string>,
  manifestVersion: number,
  retries: number,
): Promise<Uint8Array> {
  let lastError: Error | undefined;

  for (let baseIndex = 0; baseIndex < distributionBaseUrls.length; baseIndex++) {
    const distributionBaseUrl = distributionBaseUrls[baseIndex]!;
    const url = chunkPath(chunk, distributionBaseUrl, manifestVersion);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return new Uint8Array(await response.arrayBuffer());
        }

        lastError = new Error(
          `Chunk fetch failed for ${chunk.guid}: HTTP ${response.status} (${distributionBaseUrl})`,
        );

        // 403/404: often stale signature or wrong host — retry a bit, then next CDN.
        // 408/429/5xx: transient — retry with backoff, then next CDN.
        // Other 4xx: fail this host immediately and try next base.
        const retryable =
          isRetryableStatus(response.status) ||
          response.status === 403 ||
          response.status === 404;
        if (!retryable) break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < retries) {
        // Exponential backoff with small jitter: 200ms, 400ms, 800ms...
        await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
  }

  throw lastError ?? new Error(`Chunk fetch failed for ${chunk.guid}: no distribution bases`);
}

// Bounded-concurrency primed cache. Multiple files share chunks — we resolve each unique GUID
// exactly once per downloadAsset() call. The Map stores in-flight promises so concurrent callers
// queue on the same fetch instead of racing.
class ChunkCache {
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly chunkInfoById: ReadonlyMap<string, ChunkInfo>,
    private readonly distributionBaseUrls: ReadonlyArray<string>,
    private readonly manifestVersion: number,
    private readonly maxConcurrent: number,
    private readonly retries: number,
  ) {}

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Kick off a fetch without awaiting — fills the concurrency pool. */
  prime(guid: string): void {
    void this.get(guid);
  }

  async get(guid: string): Promise<Uint8Array> {
    const cached = this.inflight.get(guid);
    if (cached) return cached;

    const chunk = this.chunkInfoById.get(guid);
    if (!chunk) {
      throw new Error(`Unknown chunk GUID in file manifest: ${guid}`);
    }

    const promise = (async () => {
      await this.acquire();
      try {
        const raw = await fetchChunkBytes(
          chunk,
          this.distributionBaseUrls,
          this.manifestVersion,
          this.retries,
        );
        return decodeChunkPayload(raw);
      } finally {
        this.release();
      }
    })();
    this.inflight.set(guid, promise);
    return promise;
  }
}

function collectUniqueGuids(files: ReadonlyArray<FabDownloadFile>): string[] {
  const seen = new Set<string>();
  const guids: string[] = [];
  for (const file of files) {
    for (const part of file.chunkParts) {
      if (!seen.has(part.guid)) {
        seen.add(part.guid);
        guids.push(part.guid);
      }
    }
  }
  return guids;
}

function distributionBases(asset: FabAssetDetail): string[] {
  // Primary first, then remaining unique bases from multi-CDN pointers.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    asset.distributionBaseUrl,
    ...asset.manifestPointers.map((p) => p.distributionBaseUrl),
  ];
  for (const base of candidates) {
    const normalized = base.replace(/\/+$/, "");
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

async function fileMatchesHash(targetPath: string, expectedHash: string, expectedSize: number): Promise<boolean> {
  if (expectedHash.length === 0 || expectedHash === "0".repeat(40)) return false;
  try {
    const info = await stat(targetPath);
    if (!info.isFile() || info.size !== expectedSize) return false;
    const bytes = await readFile(targetPath);
    const got = Bun.SHA1.hash(bytes, "hex");
    return got === expectedHash.toLowerCase();
  } catch {
    return false;
  }
}

async function assembleFile(
  file: FabDownloadFile,
  cache: ChunkCache,
  targetPath: string,
): Promise<number> {
  const buffer = new Uint8Array(file.size);
  let writeOffset = 0;

  // Parts stay ordered for correct assembly; cache parallelism comes from prefetch of all
  // unique GUIDs before assemble starts, so awaits here usually hit in-flight/completed work.
  for (const part of file.chunkParts) {
    const payload = await cache.get(part.guid);
    if (part.offset + part.size > payload.length) {
      throw new Error(
        `Chunk ${part.guid} too small for part (need ${part.offset + part.size}, have ${payload.length})`,
      );
    }
    buffer.set(payload.subarray(part.offset, part.offset + part.size), writeOffset);
    writeOffset += part.size;
  }

  if (writeOffset !== file.size) {
    throw new Error(
      `Assembled byte count mismatch for ${file.filename}: wrote ${writeOffset}, expected ${file.size}`,
    );
  }

  if (file.fileHash.length > 0 && file.fileHash !== "0".repeat(40)) {
    const got = Bun.SHA1.hash(buffer, "hex");
    if (got !== file.fileHash.toLowerCase()) {
      throw new Error(
        `SHA1 mismatch for ${file.filename}: got ${got}, want ${file.fileHash.toLowerCase()}`,
      );
    }
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, buffer);
  return buffer.byteLength;
}

export async function downloadAsset(
  asset: FabAssetDetail,
  opts: DownloadOptions,
): Promise<{ files: string[]; bytesTotal: number; skipped: number }> {
  if (asset.downloadUrls.length === 0) {
    throw new Error(`Asset ${asset.id} has no files in its manifest`);
  }

  await mkdir(opts.targetDir, { recursive: true });

  const concurrency = opts.concurrency ?? DEFAULT_CHUNK_CONCURRENCY;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const skipExisting = opts.skipExisting ?? true;
  const bases = distributionBases(asset);
  if (bases.length === 0) {
    throw new Error(`Asset ${asset.id} has no distribution base URLs`);
  }

  const fileTotal = asset.downloadUrls.length;
  const writtenFiles: string[] = [];
  let bytesTotal = 0;
  let filesDone = 0;
  let skipped = 0;

  // Plan first: resolve paths + skip hash matches before any CDN work.
  // Only files that still need download contribute GUIDs to the prefetch set.
  type PlannedFile = {
    file: FabDownloadFile;
    relativePath: string;
    targetPath: string;
  };
  const toDownload: PlannedFile[] = [];

  if (skipExisting) {
    process.stderr.write(`Checking ${fileTotal} on-disk file(s) for SHA1 match…\n`);
  }

  for (const file of asset.downloadUrls) {
    const relativePath = opts.preserveStructure
      ? safeRelativePath(file.filename)
      : safeRelativePath(file.filename.split(/[/\\]/).pop() ?? file.filename);
    const targetPath = join(opts.targetDir, relativePath);

    if (skipExisting && (await fileMatchesHash(targetPath, file.fileHash, file.size))) {
      writtenFiles.push(targetPath);
      bytesTotal += file.size;
      filesDone += 1;
      skipped += 1;
      process.stderr.write(`[${filesDone}/${fileTotal}] skip ${relativePath}\n`);
      continue;
    }

    toDownload.push({ file, relativePath, targetPath });
  }

  if (toDownload.length === 0) {
    process.stderr.write(`Nothing to fetch — all ${skipped} file(s) already match manifest SHA1\n`);
    return { files: writtenFiles, bytesTotal, skipped };
  }

  const cache = new ChunkCache(
    asset.chunkInfoById,
    bases,
    asset.manifestVersion,
    concurrency,
    retries,
  );

  // Prime only chunks needed by files that will actually download.
  // Without prefetch, serial part awaits keep effective concurrency ≈ 1.
  const uniqueGuids = collectUniqueGuids(toDownload.map((p) => p.file));
  process.stderr.write(
    `Prefetching ${uniqueGuids.length} chunk(s) for ${toDownload.length}/${fileTotal} file(s)` +
      ` (concurrency ${concurrency}` +
      (bases.length > 1 ? `, ${bases.length} CDN bases` : "") +
      ")…\n",
  );
  for (const guid of uniqueGuids) {
    cache.prime(guid);
  }

  for (const { file, relativePath, targetPath } of toDownload) {
    process.stderr.write(`[${filesDone + 1}/${fileTotal}] downloading ${relativePath}…\n`);
    const bytes = await assembleFile(file, cache, targetPath);
    writtenFiles.push(targetPath);
    bytesTotal += bytes;
    filesDone += 1;
    process.stderr.write(`[${filesDone}/${fileTotal}] wrote ${relativePath} (${bytes} bytes)\n`);
  }

  return { files: writtenFiles, bytesTotal, skipped };
}

// Re-export for callers that want types without crossing module boundaries.
export type { ChunkInfo, ChunkPart };
