// Asset download module.
// Implements the fetch-and-write half of Fab's two-step download model (docs/api-surface.md §3.4).
//
// Limitation: the second half — parsing Epic's binary manifest into per-file chunks and
// reassembling them — is non-trivial (see VastBlast/EpicManifestDownloader for a reference
// parser). It is deliberately deferred. For now this module fetches each URL in
// `asset.downloadUrls` (currently the signed manifest blob itself) and writes it to disk.
// Once a binary-manifest parser is added, downloadUrls will be populated with the real per-file
// chunk URLs and this same code path will handle them without changes to its contract.
//
// TODO: add retry/backoff. Skipped intentionally for the first cut (per task brief).

import { mkdir } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

import type { FabAssetDetail, FabDownloadFile } from "./api.ts";

export interface DownloadOptions {
  targetDir: string;
  preserveStructure: boolean;
}

function safeRelativePath(filename: string): string {
  // Defense against malicious filenames in API responses: collapse `..`, drop absolute roots,
  // refuse to escape targetDir.
  const normalized = normalize(filename).replace(/^([/\\]+)/, "");
  const parts = normalized.split(sep).filter((part) => part.length > 0 && part !== "..");
  return parts.join(sep);
}

async function writeFileFromResponse(file: FabDownloadFile, targetPath: string): Promise<number> {
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`Download failed for ${file.filename}: HTTP ${response.status}`);
  }

  await mkdir(dirname(targetPath), { recursive: true });

  // Bun.write accepts a Response and streams it to disk without buffering the whole body.
  const bytesWritten = await Bun.write(targetPath, response);

  // docs/api-surface.md §3.4 — when the API reports a size, verify it matches what hit disk.
  // A size of 0 means "unknown" (current path: signed manifest blobs have no advertised size).
  if (file.size > 0 && bytesWritten !== file.size) {
    throw new Error(
      `Byte count mismatch for ${file.filename}: expected ${file.size}, wrote ${bytesWritten}`,
    );
  }

  return bytesWritten;
}

export async function downloadAsset(
  asset: FabAssetDetail,
  opts: DownloadOptions,
): Promise<{ files: string[]; bytesTotal: number }> {
  if (asset.downloadUrls.length === 0) {
    throw new Error(`Asset ${asset.id} has no download URLs`);
  }

  await mkdir(opts.targetDir, { recursive: true });

  const writtenFiles: string[] = [];
  let bytesTotal = 0;

  for (const file of asset.downloadUrls) {
    const relativePath = opts.preserveStructure
      ? safeRelativePath(file.filename)
      : safeRelativePath(file.filename.split(sep).pop() ?? file.filename);
    const targetPath = join(opts.targetDir, relativePath);
    const bytes = await writeFileFromResponse(file, targetPath);
    writtenFiles.push(targetPath);
    bytesTotal += bytes;
  }

  return { files: writtenFiles, bytesTotal };
}
