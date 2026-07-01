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

// Verified Fab manifest response 2026-05-23: downloadInfo is an array of artifact entries
// (typically one per asset), each carrying parallel arrays of signed manifest URLs +
// distribution point base URLs across multiple CDNs (CloudFront, Akamai, Fastly).
interface FabDistributionPoint {
  manifestUrl?: string;
  manifest_url?: string;
  signatureExpiration?: string;
}

interface FabManifestArtifact {
  artifactId?: string;
  buildVersion?: string;
  manifestHash?: string;
  distributionPoints?: ReadonlyArray<FabDistributionPoint>;
  distributionPointBaseUrls?: ReadonlyArray<string>;
}

interface FabManifestResponse {
  downloadInfo?: ReadonlyArray<FabManifestArtifact>;
  download_info?: ReadonlyArray<FabManifestArtifact>;
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

// Verified against live Fab response 2026-05-23: assets carry an array of `projectVersions`,
// each with an `artifactId` and an `engineVersions: ["UE_5.7", ...]` list. Multi-engine assets
// (e.g., Stack O Bot) ship 8 separate projectVersions; single-engine assets ship 1.
interface ProjectVersion {
  artifactId: string;
  engineVersions: string[];
}

function projectVersions(record: Record<string, unknown>): ProjectVersion[] {
  const raw = record.projectVersions;
  if (!Array.isArray(raw)) return [];
  const result: ProjectVersion[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const artifactId = typeof obj.artifactId === "string" ? obj.artifactId : "";
    if (artifactId.length === 0) continue;
    const engineVersions = Array.isArray(obj.engineVersions)
      ? obj.engineVersions.filter((v): v is string => typeof v === "string")
      : [];
    result.push({ artifactId, engineVersions });
  }
  return result;
}

export const ENGINE_VERSION_RE = /^UE_\d+\.\d+$/;

// UE_5.7 → 507 (major*100 + minor), for ordering. Returns -1 on unparseable strings.
export function parseEngineVersion(s: string): number {
  const match = s.match(/^UE_(\d+)\.(\d+)/);
  if (!match) return -1;
  return parseInt(match[1] ?? "0", 10) * 100 + parseInt(match[2] ?? "0", 10);
}

export interface EngineResolution {
  artifactId: string;
  matchType: "exact" | "fallback" | "higher-only" | "none";
  requested: string;
  selected: string;
  available: string[];
}

function pickArtifact(versions: ProjectVersion[], preferredEngine: string): EngineResolution {
  const available = [...new Set(versions.flatMap((v) => v.engineVersions))].sort(
    (a, b) => parseEngineVersion(a) - parseEngineVersion(b),
  );

  // Exact match wins (e.g., asset offers UE_5.7 and we target UE_5.7).
  const exact = versions.find((v) => v.engineVersions.includes(preferredEngine));
  if (exact) {
    return { artifactId: exact.artifactId, matchType: "exact", requested: preferredEngine, selected: preferredEngine, available };
  }

  const target = parseEngineVersion(preferredEngine);

  // Try versions <= target first (forward-compatible — UE opens older content fine).
  let bestLower: ProjectVersion | undefined;
  let bestLowerScore = -Infinity;
  // Track versions > target separately.
  let bestHigher: ProjectVersion | undefined;
  let bestHigherScore = Infinity;

  for (const v of versions) {
    const maxVersion = v.engineVersions.reduce((acc, ev) => Math.max(acc, parseEngineVersion(ev)), -1);
    if (maxVersion <= target) {
      if (maxVersion > bestLowerScore) {
        bestLowerScore = maxVersion;
        bestLower = v;
      }
    } else {
      if (maxVersion < bestHigherScore) {
        bestHigherScore = maxVersion;
        bestHigher = v;
      }
    }
  }

  if (bestLower) {
    const selected = bestLower.engineVersions.reduce((a, b) => (parseEngineVersion(a) > parseEngineVersion(b) ? a : b));
    return { artifactId: bestLower.artifactId, matchType: "fallback", requested: preferredEngine, selected, available };
  }

  if (bestHigher) {
    const selected = bestHigher.engineVersions.reduce((a, b) => (parseEngineVersion(a) < parseEngineVersion(b) ? a : b));
    return { artifactId: bestHigher.artifactId, matchType: "higher-only", requested: preferredEngine, selected, available };
  }

  return { artifactId: "", matchType: "none", requested: preferredEngine, selected: "", available };
}

function summarizeLibraryItem(record: Record<string, unknown>): FabAssetSummary {
  // Field names verified against live Fab response 2026-05-23 (LiminalGlitch library).
  // `assetId` and `assetNamespace` are the canonical top-level keys; older candidate names
  // (asset_id, namespace, etc.) kept as defensive fallbacks for forward compatibility.
  return {
    id: stringField(record, "assetId", "asset_id", "uid"),
    title: stringField(record, "title", "name", "description"),
    type: stringField(record, "distributionMethod", "distribution_method", "listingType", "category"),
    // `ownedAt`/purchase date is not exposed on the /ue/library endpoint as of 2026-05-23.
    // Field kept on the type for forward-compat in case Fab adds it later.
    ownedAt: stringField(record, "addedAt", "added_at", "ownedAt", "owned_at"),
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

export interface ResolvedAsset {
  summary: FabAssetSummary;
  namespace: string;
  resolution: EngineResolution;
}

export async function resolveAsset(
  tokens: AuthTokens,
  assetId: string,
  engineVersion: string = "UE_5.7",
): Promise<ResolvedAsset> {
  const library = await listLibrary(tokens);
  const match = library.find((item) => item.id === assetId);
  if (!match) {
    throw new Error(`Asset ${assetId} not found in library`);
  }

  const namespace = stringField(match.raw, "assetNamespace", "namespace", "ns");
  const versions = projectVersions(match.raw);
  const resolution = pickArtifact(versions, engineVersion);

  if (namespace.length === 0) {
    throw new Error(
      `Asset ${assetId} lacks assetNamespace in library response`,
    );
  }

  return { summary: match, namespace, resolution };
}

export async function fetchAssetDetail(
  tokens: AuthTokens,
  resolved: ResolvedAsset,
): Promise<FabAssetDetail> {
  const { summary: match, namespace, resolution } = resolved;
  const { artifactId } = resolution;

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
    throw new Error(`Fab manifest POST failed for ${match.id}: HTTP ${manifestResponse.status}`);
  }

  const manifestPayload = (await manifestResponse.json()) as FabManifestResponse;
  const artifacts = manifestPayload.downloadInfo ?? manifestPayload.download_info ?? [];

  // Each downloadInfo entry holds parallel arrays: distributionPoints[i].manifestUrl pairs
  // with distributionPointBaseUrls[i] (same CDN, same index). We flatten across all artifacts
  // and all CDNs into a single pointer list — the first usable one drives the download, and
  // download.ts can later fall back to subsequent CDNs if one returns a stale signature.
  const manifestPointers: Array<{ manifestUrl: string; distributionBaseUrl: string }> = [];
  for (const artifact of artifacts) {
    const points = artifact.distributionPoints ?? [];
    const baseUrls = artifact.distributionPointBaseUrls ?? [];
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const manifestUrl = point?.manifestUrl ?? point?.manifest_url ?? "";
      const distributionBaseUrl = baseUrls[i] ?? "";
      if (manifestUrl.length > 0 && distributionBaseUrl.length > 0) {
        manifestPointers.push({ manifestUrl, distributionBaseUrl });
      }
    }
  }

  if (manifestPointers.length === 0) {
    throw new Error(
      `Fab manifest response for ${match.id} contained no manifest URLs (received ${artifacts.length} artifact entries)`,
    );
  }

  // docs/api-surface.md §3.4 step 2 — fetch + parse the signed binary manifest, then resolve it
  // into per-file chunk-part lists. We use the first pointer; if it goes stale (signed URL
  // expiry) the caller can re-fetch via getAsset(). Multi-CDN failover lives in download.ts.
  const primary = manifestPointers[0];
  if (!primary) {
    throw new Error(`Fab manifest response for ${match.id} had no usable pointer`);
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

export async function getAsset(
  tokens: AuthTokens,
  assetId: string,
  engineVersion: string = "UE_5.7",
): Promise<FabAssetDetail> {
  const resolved = await resolveAsset(tokens, assetId, engineVersion);
  if (resolved.resolution.artifactId.length === 0) {
    throw new Error(
      `No engine version match for ${assetId} (requested ${engineVersion}, available: ${resolved.resolution.available.join(", ") || "none"})`,
    );
  }
  return fetchAssetDetail(tokens, resolved);
}

export function whoami(tokens: AuthTokens): { displayName: string; accountId: string } {
  return { displayName: tokens.displayName, accountId: tokens.accountId };
}
