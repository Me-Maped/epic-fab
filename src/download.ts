// Asset download + extraction module.
// Wraps Fab's signed CDN URLs into local file writes.

import type { FabAssetDetail } from "./api.ts";

export interface DownloadOptions {
  targetDir: string;
  preserveStructure: boolean;
}

export async function downloadAsset(
  _asset: FabAssetDetail,
  _opts: DownloadOptions,
): Promise<{ files: string[]; bytesTotal: number }> {
  throw new Error("download.ts: downloadAsset not implemented");
}
