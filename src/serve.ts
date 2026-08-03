// Local web UI server. Serves the static SPA from src/ui/ plus a small JSON API that wraps
// the same auth/library/download building blocks the CLI uses. Download jobs run async
// in-process; state is pushed to the page over a single SSE channel (/api/events).

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";

import {
  clearTokens,
  exchangeAuthCode,
  getBrowserAuthUrl,
  loadTokens,
  refreshIfNeeded,
} from "./auth.ts";
import { getAsset, listLibraryCached, type FabAssetSummary } from "./api.ts";
import { downloadAsset } from "./download.ts";

export interface UiServerOptions {
  port: number;
  /** Best-effort xdg-open of the UI URL after binding. Default false. */
  openBrowser?: boolean;
}

export interface JobState {
  jobId: string;
  assetId: string;
  title: string;
  status: "resolving" | "downloading" | "done" | "error" | "cancelled";
  filesDone: number;
  fileTotal: number;
  bytesDone: number;
  bytesTotal: number;
  currentFile: string | null;
  error: string | null;
  targetDir: string;
}

/** How often progress ticks for one job may hit SSE clients. Terminal states bypass this. */
const PROGRESS_THROTTLE_MS = 100;

const jobs = new Map<string, JobState>();
const controllers = new Map<string, AbortController>();
const sseClients = new Set<ReadableStreamDefaultController<string>>();
const lastBroadcastAt = new Map<string, number>();
let pendingBroadcast: ReturnType<typeof setTimeout> | null = null;

// Copied from cli.ts — same slug rules so UI downloads land in the same folders the CLI
// would pick.
function assetSlug(asset: FabAssetSummary): string {
  const candidate = asset.title.length > 0 ? asset.title : asset.id;
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : asset.id;
}

function thumbnailFor(raw: Record<string, unknown>): string | null {
  // Field names are [UNCERTAIN] per api.ts — probe the likely candidates, then the first
  // entry of image/thumbnail arrays.
  const direct = raw["thumbnailUrl"] ?? raw["thumbnail"] ?? raw["thumbUrl"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const key of ["images", "thumbnails"] as const) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    const first = list[0];
    if (typeof first !== "object" || first === null) continue;
    const url = (first as Record<string, unknown>)["url"];
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

function fabUrlFor(item: FabAssetSummary): string {
  // Probe raw payload for a canonical listing URL first; field names are [UNCERTAIN] per
  // api.ts, so try the likely candidates in order.
  for (const key of ["listingUrl", "fabUrl", "productUrl", "url"] as const) {
    const value = item.raw[key];
    if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  }
  // Fallback: Fab listing pages are keyed by the dashed asset UUID. Library ids come back
  // as 32 hex chars (dashes stripped) — re-insert 8-4-4-4-12 grouping.
  const dashed = /^[0-9a-f]{32}$/i.test(item.id)
    ? `${item.id.slice(0, 8)}-${item.id.slice(8, 12)}-${item.id.slice(12, 16)}-${item.id.slice(16, 20)}-${item.id.slice(20)}`
    : item.id;
  return `https://www.fab.com/listings/${dashed}`;
}

function jobsSnapshot(): JobState[] {
  return [...jobs.values()];
}

function broadcastNow(): void {
  const payload = `data: ${JSON.stringify({ jobs: jobsSnapshot() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.enqueue(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

/**
 * Fan a job change out to SSE clients. Progress ticks are throttled per job (with a trailing
 * flush so the final in-flight state always arrives); status changes and terminal states go
 * immediately.
 */
function notifyJobChanged(job: JobState, immediate: boolean): void {
  const now = Date.now();
  const last = lastBroadcastAt.get(job.jobId) ?? 0;
  if (immediate || now - last >= PROGRESS_THROTTLE_MS) {
    lastBroadcastAt.set(job.jobId, now);
    broadcastNow();
    return;
  }
  if (pendingBroadcast === null) {
    pendingBroadcast = setTimeout(() => {
      pendingBroadcast = null;
      lastBroadcastAt.set(job.jobId, Date.now());
      broadcastNow();
    }, PROGRESS_THROTTLE_MS - (now - last));
  }
}

async function runJob(job: JobState, into: string | undefined): Promise<void> {
  const controller = new AbortController();
  controllers.set(job.jobId, controller);
  try {
    const tokens = await loadTokens();
    if (!tokens) {
      throw new Error("Not authenticated");
    }
    const fresh = await refreshIfNeeded(tokens);

    const asset = await getAsset(fresh, job.assetId);
    job.title = asset.title;
    job.targetDir = resolve(into ?? join(homedir(), "Downloads", assetSlug(asset)));
    job.fileTotal = asset.downloadUrls.length;
    job.status = "downloading";
    notifyJobChanged(job, true);

    await downloadAsset(asset, {
      targetDir: job.targetDir,
      preserveStructure: true,
      signal: controller.signal,
      onProgress: (progress) => {
        // Manifest "checking" and "downloading" phases both read as downloading to the UI.
        job.status = progress.phase === "done" ? "done" : "downloading";
        job.filesDone = progress.filesDone;
        job.fileTotal = progress.fileTotal;
        job.bytesDone = progress.bytesDone;
        job.bytesTotal = progress.bytesTotal;
        job.currentFile = progress.currentFile;
        notifyJobChanged(job, progress.phase === "done");
      },
    });

    job.status = "done";
    job.currentFile = null;
    notifyJobChanged(job, true);
  } catch (err) {
    if (controller.signal.aborted) {
      // Cancelled — clean up the partially-written target dir and mark terminal.
      job.status = "cancelled";
      job.error = null;
      job.currentFile = null;
      if (job.targetDir.length > 0) {
        await rm(job.targetDir, { recursive: true, force: true }).catch(() => {});
      }
      notifyJobChanged(job, true);
    } else {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.currentFile = null;
      notifyJobChanged(job, true);
    }
  } finally {
    controllers.delete(job.jobId);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorJson(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await req.json()) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty-object return — callers validate required fields.
  }
  return {};
}

function staticFile(name: string, contentType: string): Response {
  const file = Bun.file(new URL(`./ui/${name}`, import.meta.url));
  return new Response(file, { headers: { "Content-Type": contentType } });
}

function eventsResponse(): Response {
  let client: ReadableStreamDefaultController<string> | null = null;
  const stream = new ReadableStream<string>({
    start(controller) {
      client = controller;
      sseClients.add(controller);
      // Snapshot on connect so late-joining pages see in-flight jobs immediately.
      controller.enqueue(`data: ${JSON.stringify({ jobs: jobsSnapshot() })}\n\n`);
    },
    cancel() {
      if (client) sseClients.delete(client);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function handleApi(req: Request, path: string, url: URL): Promise<Response> {
  if (req.method === "GET" && path === "/api/status") {
    const tokens = await loadTokens();
    return json({
      authenticated: tokens !== null,
      displayName: tokens?.displayName ?? null,
      accountId: tokens?.accountId ?? null,
    });
  }

  if (req.method === "GET" && path === "/api/auth/url") {
    return json({ url: getBrowserAuthUrl() });
  }

  if (req.method === "POST" && path === "/api/auth") {
    const body = await readJsonBody(req);
    const code = typeof body["code"] === "string" ? body["code"] : "";
    if (code.trim().length === 0) {
      return errorJson(400, "Missing authorization code");
    }
    try {
      const tokens = await exchangeAuthCode(code);
      return json({ authenticated: true, displayName: tokens.displayName });
    } catch (err) {
      return errorJson(400, err instanceof Error ? err.message : String(err));
    }
  }

  if (req.method === "POST" && path === "/api/logout") {
    await clearTokens();
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "/api/library") {
    const tokens = await loadTokens();
    if (!tokens) {
      return errorJson(401, "Not authenticated");
    }
    try {
      const fresh = await refreshIfNeeded(tokens);
      const items = await listLibraryCached(fresh, {
        forceRefresh: url.searchParams.get("refresh") === "1",
      });
      return json({
        assets: items.map((item) => ({
          id: item.id,
          title: item.title,
          type: item.type,
          thumbnail: thumbnailFor(item.raw),
          fabUrl: fabUrlFor(item),
        })),
      });
    } catch (err) {
      return errorJson(500, err instanceof Error ? err.message : String(err));
    }
  }

  if (req.method === "POST" && path === "/api/download") {
    const tokens = await loadTokens();
    if (!tokens) {
      return errorJson(401, "Not authenticated");
    }
    const body = await readJsonBody(req);
    const assetId = typeof body["assetId"] === "string" ? body["assetId"] : "";
    if (assetId.length === 0) {
      return errorJson(400, "Missing assetId");
    }
    const into = typeof body["into"] === "string" && body["into"].length > 0 ? body["into"] : undefined;

    const job: JobState = {
      jobId: crypto.randomUUID(),
      assetId,
      title: assetId,
      status: "resolving",
      filesDone: 0,
      fileTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      currentFile: null,
      error: null,
      targetDir: "",
    };
    jobs.set(job.jobId, job);
    notifyJobChanged(job, true);
    void runJob(job, into);
    return json({ jobId: job.jobId });
  }

  if (req.method === "GET" && path === "/api/jobs") {
    return json({ jobs: jobsSnapshot() });
  }

  if (req.method === "GET" && path === "/api/events") {
    return eventsResponse();
  }

  // POST /api/download/<jobId>/cancel — abort an in-flight download job.
  if (req.method === "POST" && path.startsWith("/api/download/") && path.endsWith("/cancel")) {
    const jobId = path.slice("/api/download/".length, -"/cancel".length);
    const job = jobs.get(jobId);
    if (!job) {
      return errorJson(404, `Unknown job: ${jobId}`);
    }
    // Terminal jobs are already finished — idempotent no-op.
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      return json({ ok: true });
    }
    const controller = controllers.get(jobId);
    controller?.abort();
    job.status = "cancelled";
    job.error = null;
    job.currentFile = null;
    if (job.targetDir.length > 0) {
      await rm(job.targetDir, { recursive: true, force: true }).catch(() => {});
    }
    notifyJobChanged(job, true);
    return json({ ok: true });
  }

  return errorJson(404, `Unknown route: ${req.method} ${path}`);
}

export function startUiServer(opts: UiServerOptions): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: opts.port,
    // Default 10s kills slow cold-cache library fetches and idle SSE streams. Max is 255s;
    // EventSource auto-reconnects past that.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "GET") {
        if (path === "/") return staticFile("index.html", "text/html; charset=utf-8");
        if (path === "/styles.css") return staticFile("styles.css", "text/css; charset=utf-8");
        if (path === "/app.js") return staticFile("app.js", "text/javascript; charset=utf-8");
      }

      if (path.startsWith("/api/")) {
        return handleApi(req, path, url);
      }

      return errorJson(404, `Unknown route: ${req.method} ${path}`);
    },
  });

  process.stderr.write(`epic-fab UI → http://localhost:${opts.port}\n`);

  if (opts.openBrowser) {
    try {
      Bun.spawn(["xdg-open", `http://localhost:${opts.port}`], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // Best effort — headless systems may lack xdg-open.
    }
  }

  return server;
}
