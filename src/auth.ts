// Epic OAuth 2.0 device-code grant.
// Endpoints + client-ID surface to be finalized by the Research subagent.
// Token storage: ~/.config/epic-fab/auth.json, mode 600.

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
