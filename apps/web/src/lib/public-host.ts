const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Публичный сайт отвечает только на хосте из APP_URL.
 * localhost оставлен для локальной разработки и проверок на машине.
 * Адрес *.fly.dev Fly не отключает, поэтому чужой Host закрывается здесь.
 */
export function publicHostAllowed(hostHeader: string | null, appUrl: string | undefined): boolean {
  const host = hostHeader?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d+$/, "");
  if (LOCAL_HOSTS.has(hostname)) return true;
  if (!appUrl) return false;
  try {
    return new URL(appUrl).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
