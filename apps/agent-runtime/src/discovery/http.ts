/** Чтение ответов по кусочку: страницы и пробы MCP не должны тянуть мегабайты. */

export async function readHead(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < maxBytes) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 2_500)),
      ]);
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return out;
}

export function discardBody(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

export function httpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
