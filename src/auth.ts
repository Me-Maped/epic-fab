// Epic OAuth 2.0 — authorization_code grant with manual code paste.
// Device-code grant is unavailable for the launcherAppClient2 client that has Fab scope;
// see docs/api-surface.md §"CRITICAL FINDING" for the research that established this.
// Token storage: under the user's XDG config dir, mode 600, atomic via .tmp + rename.

import { mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

// docs/api-surface.md §1.1 — public reverse-engineered launcher credentials.
// Not a secret: shipped in Legendary, egs-api-rs, Heroic, Epic-Asset-Manager since 2019.
const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const CLIENT_SECRET = "daafbccc737745039dffe53d94fc76cf";
const TOKEN_ENDPOINT = "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token";
const BROWSER_AUTH_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;

// docs/api-surface.md §4.2 — Legendary's UA verbatim; required for some Cloudflare-fronted endpoints.
const EPIC_USER_AGENT = "UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit";

// docs/api-surface.md §1.5 — refresh when access token has under 60 seconds remaining (per task brief;
// Legendary uses 600s but the brief here specifies 60s — honor the brief's threshold).
const REFRESH_THRESHOLD_MS = 60_000;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  displayName: string;
  expiresAt: string;
  refreshExpiresAt?: string;
}

interface EpicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  expires_in: number;
  refresh_expires_at?: string;
  refresh_expires?: number;
  account_id: string;
  displayName: string;
  token_type: string;
}

interface EpicErrorResponse {
  errorCode?: string;
  errorMessage?: string;
  numericErrorCode?: number;
}

function authConfigPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "epic-fab", "auth.json");
}

function basicAuthHeader(): string {
  const creds = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds, "utf8").toString("base64")}`;
}

function tokenResponseToAuth(payload: EpicTokenResponse): AuthTokens {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accountId: payload.account_id,
    displayName: payload.displayName,
    expiresAt: payload.expires_at,
    refreshExpiresAt: payload.refresh_expires_at,
  };
}

async function postToken(body: URLSearchParams): Promise<AuthTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": EPIC_USER_AGENT,
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const err = (await response.json()) as EpicErrorResponse;
      if (err.errorMessage) {
        detail = `${detail} — ${err.errorCode ?? "error"}: ${err.errorMessage}`;
      }
    } catch {
      // Body wasn't JSON; the HTTP status alone is the signal.
    }
    throw new Error(`Epic token endpoint rejected request: ${detail}`);
  }

  const payload = (await response.json()) as EpicTokenResponse;
  return tokenResponseToAuth(payload);
}

async function promptAuthCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = await rl.question("Paste authorization code: ");
    return raw.trim();
  } finally {
    rl.close();
  }
}

export async function startBrowserAuth(): Promise<AuthTokens> {
  console.log("Open this URL in your browser, sign in, and copy the `authorizationCode` value:");
  console.log("");
  console.log(`  ${BROWSER_AUTH_URL}`);
  console.log("");

  const code = await promptAuthCode();
  if (code.length === 0) {
    throw new Error("No authorization code provided");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    token_type: "eg1",
  });

  const tokens = await postToken(body);
  await saveTokens(tokens);
  return tokens;
}

export async function loadTokens(): Promise<AuthTokens | null> {
  const path = authConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "accessToken" in parsed &&
      "refreshToken" in parsed &&
      "accountId" in parsed &&
      "displayName" in parsed &&
      "expiresAt" in parsed
    ) {
      return parsed as AuthTokens;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: AuthTokens): Promise<void> {
  const path = authConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  // Write to sibling .tmp then rename — keeps the persisted file intact if the write is interrupted.
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export async function refreshIfNeeded(tokens: AuthTokens): Promise<AuthTokens> {
  const expiresMs = Date.parse(tokens.expiresAt);
  if (Number.isFinite(expiresMs) && expiresMs - Date.now() > REFRESH_THRESHOLD_MS) {
    return tokens;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    token_type: "eg1",
  });

  const refreshed = await postToken(body);
  await saveTokens(refreshed);
  return refreshed;
}

export async function clearTokens(): Promise<void> {
  const path = authConfigPath();
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
