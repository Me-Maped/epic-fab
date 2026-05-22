// Fab REST API client. Endpoints sourced from docs/api-surface.md §3 (verbatim from
// AchetaGames/egs-api-rs src/api/fab.rs — the only complete recent Fab integration).
// Auth model: the Epic access_token from §1 is the Fab bearer; no separate Fab token exchange.

import type { AuthTokens } from "./auth.ts";
import { parseManifest, type ChunkInfo, type ChunkPart } from "./manifestParser.ts";

// docs/api-surface.md §3.1 — use /e/ and /p/ URL families exclusively; Bearer-only, no cookies.
const FAB_HOST = "https://www.fab.com";
const LIBRARY_PAGE_SIZE = 100;

// docs/api-surface.md §4.2 — UA not strictly required for Fab (egs-api-rs uses reqwest default)
// but identifying ourselves is polite and may avoid future 403s under Cloudflare.
const FAB_USER_AGENT = "epic-fab/0.1 (+linux)";

export interface FabAssetSummary {
  id: string;
  title: string;
  type: string;
  ownedAt: string;
  // docs/api-surface.md §3.2 — exact library-item field names are [UNCERTAIN]; the raw payload
  // is preserved here so callers (and a verification spike) can inspect what Fab actually returns.
  raw: Record<string, unknown>;
}

// FabDownloadFile = one logical file in the asset, plus everything download.ts needs to
// reassemble it from chunks. The shape diverges from the brief's earlier `{url, size, filename}`
// because Epic files are not 1:1 with CDN URLs — each file is built from N chunk parts, and
// chunks are shared across files. See docs/api-surface.md §3.4 step 2.
//
// Design (Option A from the task brief): the parser hands back per-file `chunkParts` + a shared
// `chunkInfoById` table + the CDN base URL. download.ts walks the parts, fetches/caches chunks,
// and reassembles. Keeps api.ts a thin transport layer.
export interface FabDownloadFile {
  filename: string;
  size: number;
  fileHash: string;
  chunkParts: ReadonlyArray<ChunkPart>;
}

export interface FabAssetDetail extends FabAssetSummary {
  // docs/api-surface.md §3.4 — `manifest_url` is a signed CDN URL pointing at Epic's binary
  // manifest format. Each entry is a candidate distribution point (multi-CDN failover).
  manifestPointers: ReadonlyArray<{ manifestUrl: string; distributionBaseUrl: string }>;
  downloadUrls: ReadonlyArray<FabDownloadFile>;
  // Shared chunk database — every file's chunkParts[].guid resolves here.
  chunkInfoById: ReadonlyMap<string, ChunkInfo>;
  // Manifest version drives the chunk-directory name (ChunksV3/V4/V5).
  manifestVersion: number;
  // Distribution point picked for this asset. CDN URLs in this manifest are signed against
  // this host; switching hosts mid-download requires re-requesting the manifest.
  distributionBaseUrl: string;
  artifactId: string;
  namespace: string;
}

interface FabLibraryResponse {
  cursors?: { next?: string | null };
  results?: ReadonlyArray<Record<string, unknown>>;
}

interface FabManifestPointer {
  manifest_url?: string;
  manifestUrl?: string;
  distribution_point_base_url?: string;
  distributionPointBaseUrl?: string;
}

interface FabManifestResponse {
  download_info?: ReadonlyArray<FabManifestPointer>;
  downloadInfo?: ReadonlyArray<FabManifestPointer>;
}

function authHeaders(tokens: AuthTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/json",
    "User-Agent": FAB_USER_AGENT,
  };
}

function stringField(record: Record<string, unknown>, ...candidates: string[]): string {
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function summarizeLibraryItem(record: Record<string, unknown>): FabAssetSummary {
  // docs/api-surface.md §3.2 — field names [UNCERTAIN] until a real library call confirms them.
  // The candidates below are the names observed across community sources (egs-api-rs struct,
  // Subtixx gist, wikiti gist). Verify against a live response before relying on any single one.
  return {
    id: stringField(record, "asset_id", "assetId", "uid", "artifact_id", "artifactId"),
    title: stringField(record, "title", "name"),
    type: stringField(record, "distribution_method", "distributionMethod", "category", "type"),
    ownedAt: stringField(record, "added_at", "addedAt", "owned_at", "ownedAt"),
    raw: record,
  };
}

async function fetchJson<T>(url: string, tokens: AuthTokens): Promise<T> {
  const response = await fetch(url, { headers: authHeaders(tokens) });
  if (!response.ok) {
    throw new Error(`Fab GET ${url} failed: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function listLibrary(tokens: AuthTokens): Promise<FabAssetSummary[]> {
  const items: FabAssetSummary[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ count: String(LIBRARY_PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const url = `${FAB_HOST}/e/accounts/${encodeURIComponent(tokens.accountId)}/ue/library?${params.toString()}`;

    const page = await fetchJson<FabLibraryResponse>(url, tokens);
    for (const record of page.results ?? []) {
      items.push(summarizeLibraryItem(record));
    }

    const next = page.cursors?.next;
    cursor = typeof next === "string" && next.length > 0 ? next : undefined;
  } while (cursor);

  return items;
}

export async function getAsset(tokens: AuthTokens, assetId: string): Promise<FabAssetDetail> {
  // Library results carry the artifact_id + namespace needed for the manifest call. We re-walk
  // the library to find the matching record rather than caching, because the listing is cheap
  // and Fab's TTL on the manifest pointers makes stale lookups risky anyway.
  const library = await listLibrary(tokens);
  const match = library.find((item) => item.id === assetId);
  if (!match) {
    throw new Error(`Asset ${assetId} not found in library`);
  }

  // docs/api-surface.md §3.4 — manifest call requires artifact_id (path) + item_id + namespace (body).
  // Both field names are [UNCERTAIN]; we try the most-cited names first.
  const artifactId = stringField(match.raw, "artifact_id", "artifactId", "asset_id", "assetId");
  const namespace = stringField(match.raw, "namespace", "ns");
  if (artifactId.length === 0 || namespace.length === 0) {
    throw new Error(
      `Asset ${assetId} lacks artifact_id or namespace in library response — see docs/api-surface.md §3.2 [UNCERTAIN] for field-name candidates`,
    );
  }

  const manifestUrl = `${FAB_HOST}/e/artifacts/${encodeURIComponent(artifactId)}/manifest`;
  const manifestResponse = await fetch(manifestUrl, {
    method: "POST",
    headers: {
      ...authHeaders(tokens),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      item_id: match.id,
      namespace,
      platform: "Windows",
    }),
  });

  if (!manifestResponse.ok) {
    throw new Error(`Fab manifest POST failed for ${assetId}: HTTP ${manifestResponse.status}`);
  }

  const manifestPayload = (await manifestResponse.json()) as FabManifestResponse;
  const rawPointers = manifestPayload.download_info ?? manifestPayload.downloadInfo ?? [];
  const manifestPointers = rawPointers
    .map((entry) => ({
      manifestUrl: entry.manifest_url ?? entry.manifestUrl ?? "",
      distributionBaseUrl: entry.distribution_point_base_url ?? entry.distributionPointBaseUrl ?? "",
    }))
    .filter((entry) => entry.manifestUrl.length > 0);

  if (manifestPointers.length === 0) {
    throw new Error(
      `Fab manifest response for ${assetId} contained no manifest URLs — see docs/api-surface.md §3.4 (response shape [UNCERTAIN])`,
    );
  }

  // docs/api-surface.md §3.4 step 2 — fetch + parse the signed binary manifest, then resolve it
  // into per-file chunk-part lists. We use the first pointer; if it goes stale (signed URL
  // expiry) the caller can re-fetch via getAsset(). Multi-CDN failover lives in download.ts.
  const primary = manifestPointers[0];
  if (!primary) {
    throw new Error(`Fab manifest response for ${assetId} had no usable pointer`);
  }
  const manifest = await parseManifest(primary.manifestUrl);

  const chunkInfoById = new Map<string, ChunkInfo>();
  for (const chunk of manifest.chunkDataList) chunkInfoById.set(chunk.guid, chunk);

  const downloadUrls: FabDownloadFile[] = manifest.fileManifestList.map((file) => ({
    filename: file.filename,
    size: file.fileSize,
    fileHash: file.fileHash,
    chunkParts: file.chunkParts,
  }));

  return {
    ...match,
    artifactId,
    namespace,
    manifestPointers,
    downloadUrls,
    chunkInfoById,
    manifestVersion: manifest.version,
    distributionBaseUrl: primary.distributionBaseUrl,
  };
}

export function whoami(tokens: AuthTokens): { displayName: string; accountId: string } {
  return { displayName: tokens.displayName, accountId: tokens.accountId };
}
