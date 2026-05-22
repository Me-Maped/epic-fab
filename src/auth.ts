// Epic OAuth 2.0 — authorization_code grant with manual code paste.
// (Device-code grant is unavailable for the launcherAppClient2 client that has Fab scope;
//  see docs/api-surface.md for the research that established this.)
// Endpoints + client credentials finalized by the Research pass.
// Token storage: under the user's XDG config dir, mode 600.

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  displayName: string;
  expiresAt: string;
}

export async function startDeviceAuth(): Promise<never> {
  throw new Error("auth.ts: startDeviceAuth not implemented — awaiting Research output");
}

export async function loadTokens(): Promise<AuthTokens | null> {
  throw new Error("auth.ts: loadTokens not implemented");
}

export async function refreshIfNeeded(_tokens: AuthTokens): Promise<AuthTokens> {
  throw new Error("auth.ts: refreshIfNeeded not implemented");
}
