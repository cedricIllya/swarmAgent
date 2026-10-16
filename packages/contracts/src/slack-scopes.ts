/** Права пользовательского токена Slack. Токен без какого-то из них надо выдать заново. */
export const SLACK_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
] as const;

/** Каких прав из `SLACK_USER_SCOPES` нет в строке `scope` от Slack. */
export function missingSlackScopes(scope: string | undefined): string[] {
  const granted = new Set((scope ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  return SLACK_USER_SCOPES.filter((item) => !granted.has(item));
}
