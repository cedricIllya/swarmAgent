/**
 * Дополнительные origin для CSRF-проверки better-auth.
 * `baseURL` библиотека доверяет сама. Если запрос пришёл на другой hostname,
 * Origin браузера не совпадает с baseURL, и POST вроде удаления аккаунта
 * отвечает «Invalid origin», хотя запрос свой.
 *
 * Свой origin доверяем, только если его host совпал с Host запроса.
 * Чужой сайт прислать такой Host не может: браузер ставит Host по адресу,
 * куда ушёл запрос.
 */
export function originsFromRequest(request: Request | undefined, extra: string[] = []): string[] {
  const origins = new Set<string>();
  for (const value of extra) {
    const origin = httpOrigin(value);
    if (origin) origins.add(origin);
  }
  if (!request) return [...origins];

  const raw = request.headers.get("origin");
  if (!raw || raw === "null") return [...origins];
  const originUrl = httpOrigin(raw);
  if (!originUrl) return [...origins];

  const host = request.headers.get("host")?.split(",")[0]?.trim().toLowerCase();
  if (host && new URL(originUrl).host.toLowerCase() === host) origins.add(originUrl);
  return [...origins];
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
