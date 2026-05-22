// Fab REST API client. Endpoints sourced from docs/api-surface.md §3 (verbatim from
// AchetaGames/egs-api-rs src/api/fab.rs — the only complete recent Fab integration).
// Auth model: the Epic access_token from §1 is the Fab bearer; no separate Fab token exchange.

import type { AuthTokens } from "./auth.ts";

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

export interface FabDownloadFile {
  url: string;
  size: number;
  filename: string;
}

export interface FabAssetDetail extends FabAssetSummary {
  // docs/api-surface.md §3.4 — `manifest_url` is a signed CDN URL pointing at Epic's binary
  // manifest format. Parsing that format (chunks + reassembly) is non-trivial and is deliberately
  // deferred — see download.ts. Each entry is a candidate distribution point (multi-CDN).
  manifestPointers: ReadonlyArray<{ manifestUrl: string; distributionBaseUrl: string }>;
  downloadUrls: ReadonlyArray<FabDownloadFile>;
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

  // TODO: parse Epic's binary manifest format from manifestPointers[0].manifestUrl to get
  // the real per-file chunk list. Until that lands, downloadUrls treats the signed manifest
  // URL itself as a single opaque blob to fetch. See docs/api-surface.md §3.4 step 2 and
  // VastBlast/EpicManifestDownloader for reference parsers.
  const downloadUrls: FabDownloadFile[] = manifestPointers.map((pointer, index) => ({
    url: pointer.manifestUrl,
    size: 0,
    filename: `manifest-${index}.bin`,
  }));

  return {
    ...match,
    artifactId,
    namespace,
    manifestPointers,
    downloadUrls,
  };
}

export function whoami(tokens: AuthTokens): { displayName: string; accountId: string } {
  return { displayName: tokens.displayName, accountId: tokens.accountId };
}
