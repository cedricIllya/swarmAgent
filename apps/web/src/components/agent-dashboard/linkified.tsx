const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Текст сообщения, где ссылки кликабельны и открываются в новой вкладке. */
export function Linkified({ text }: { text: string }) {
  const parts: Array<string | { href: string }> = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    // завершающая пунктуация обычно не часть ссылки
    const href = m[0].replace(/[.,;:!?]+$/, "");
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ href });
    last = start + href.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
            {p.href}
          </a>
        ),
      )}
    </>
  );
}
