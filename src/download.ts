// Asset download + chunk reassembly. Implements step 2-and-a-half of docs/api-surface.md §3.4:
// walks the parsed manifest's per-file chunk-part list, fetches each unique chunk from the CDN
// (cached, deduplicated, bounded concurrency), slices the requested byte range out of each
// decoded chunk payload, and assembles the file on disk.

import { mkdir } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

import type { FabAssetDetail, FabDownloadFile } from "./api.ts";
import { chunkPath, decodeChunkPayload, type ChunkInfo, type ChunkPart } from "./manifestParser.ts";

export interface DownloadOptions {
  targetDir: string;
  preserveStructure: boolean;
}

// CDN concurrency cap. Higher = faster on Epic's CDNs, but they will start rate-limiting around
// 16+ for sustained pulls per docs/api-surface.md §4.1. 8 is the well-trodden default used by
// VastBlast's parser and Legendary's downloader pool size.
const CHUNK_CONCURRENCY = 8;

function safeRelativePath(filename: string): string {
  // Defense against malicious filenames in manifest entries: collapse `..`, drop absolute roots.
  // Manifests carry Windows-style backslashes; normalize first so split(sep) catches both.
  const unix = filename.replace(/\\/g, "/");
  const normalized = normalize(unix).replace(/^([/\\]+)/, "");
  const parts = normalized.split(/[/\\]/).filter((part) => part.length > 0 && part !== "..");
  return parts.join(sep);
}

async function fetchChunkBytes(
  chunk: ChunkInfo,
  distributionBaseUrl: string,
  manifestVersion: number,
): Promise<Uint8Array> {
  const url = chunkPath(chunk, distributionBaseUrl, manifestVersion);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Chunk fetch failed for ${chunk.guid}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
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
    private readonly distributionBaseUrl: string,
    private readonly manifestVersion: number,
    private readonly maxConcurrent: number,
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
        const raw = await fetchChunkBytes(chunk, this.distributionBaseUrl, this.manifestVersion);
        return decodeChunkPayload(raw);
      } finally {
        this.release();
      }
    })();
    this.inflight.set(guid, promise);
    return promise;
  }
}

async function assembleFile(
  file: FabDownloadFile,
  cache: ChunkCache,
  targetPath: string,
): Promise<number> {
  const buffer = new Uint8Array(file.size);
  let writeOffset = 0;

  // Sequential chunk-part copy. Within a single file, parts are ordered start-to-end; cache
  // does the parallelism across files. Could parallelize within-file by pre-allocating write
  // offsets, but that gains little since CDN concurrency is the bottleneck.
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
): Promise<{ files: string[]; bytesTotal: number }> {
  if (asset.downloadUrls.length === 0) {
    throw new Error(`Asset ${asset.id} has no files in its manifest`);
  }

  await mkdir(opts.targetDir, { recursive: true });

  const cache = new ChunkCache(
    asset.chunkInfoById,
    asset.distributionBaseUrl,
    asset.manifestVersion,
    CHUNK_CONCURRENCY,
  );

  const writtenFiles: string[] = [];
  let bytesTotal = 0;
  let filesDone = 0;

  for (const file of asset.downloadUrls) {
    const relativePath = opts.preserveStructure
      ? safeRelativePath(file.filename)
      : safeRelativePath(file.filename.split(/[/\\]/).pop() ?? file.filename);
    const targetPath = join(opts.targetDir, relativePath);
    const bytes = await assembleFile(file, cache, targetPath);
    writtenFiles.push(targetPath);
    bytesTotal += bytes;
    filesDone += 1;
    // Progress to stderr so stdout stays JSON-pure for cli.ts consumers.
    process.stderr.write(`[${filesDone}/${asset.downloadUrls.length}] ${relativePath}\n`);
  }

  return { files: writtenFiles, bytesTotal };
}

// Re-export for callers that want types without crossing module boundaries.
export type { ChunkInfo, ChunkPart };
