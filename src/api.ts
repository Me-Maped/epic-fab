// Fab REST API client.
// Endpoint surface to be finalized by the Research subagent.

import type { AuthTokens } from "./auth.ts";

export interface FabAssetSummary {
  id: string;
  title: string;
  type: string;
  ownedAt: string;
}

export interface FabAssetDetail extends FabAssetSummary {
  downloadUrls: ReadonlyArray<{ url: string; size: number; filename: string }>;
}

export async function listLibrary(_tokens: AuthTokens): Promise<FabAssetSummary[]> {
  throw new Error("api.ts: listLibrary not implemented — awaiting Research output");
}

export async function getAsset(_tokens: AuthTokens, _assetId: string): Promise<FabAssetDetail> {
  throw new Error("api.ts: getAsset not implemented — awaiting Research output");
}
