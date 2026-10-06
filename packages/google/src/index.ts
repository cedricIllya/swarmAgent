/**
 * Google OAuth для агента: ссылка на согласие, обмен кода, формат
 * `google_token.json`, который понимает google-workspace скилл Hermes.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export function buildConsentUrl(cfg: GoogleOAuthConfig, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string;
  email: string | null;
}

export async function exchangeCode(cfg: GoogleOAuthConfig, code: string): Promise<GoogleTokens> {
  const f = cfg.fetchImpl ?? fetch;
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    id_token?: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    scope: json.scope,
    email: json.id_token ? emailFromIdToken(json.id_token) : null,
  };
}

export async function refreshAccessToken(
  cfg: GoogleOAuthConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string; scope: string }> {
  const f = cfg.fetchImpl ?? fetch;
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number; scope: string };
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    scope: json.scope,
  };
}

/** Отозвать refresh token, чтобы сохранённые копии больше не давали доступ к Google. */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  // Google отвечает 400, если токен уже недействителен — желаемое состояние достигнуто.
  if (!res.ok && res.status !== 400) {
    throw new Error(`Google token revoke failed: ${res.status} ${await res.text()}`);
  }
}

function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Формат файла `google_token.json`, как его пишет google-auth-oauthlib
 * (`Credentials.to_json()`), который читает скилл Hermes.
 */
export function toGoogleTokenJson(
  cfg: Pick<GoogleOAuthConfig, "clientId" | "clientSecret">,
  tokens: { accessToken: string; refreshToken: string; expiresAt: string; scope: string },
): Record<string, unknown> {
  return {
    token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scopes: tokens.scope.split(" ").filter(Boolean),
    universe_domain: "googleapis.com",
    account: "",
    expiry: tokens.expiresAt.replace(/\.\d{3}Z$/, "Z"),
  };
}
