import { openRouterCostUsd } from "@swarm/usage";
import type { LlmCostLedger } from "./cost-ledger";

const UPSTREAM = "https://openrouter.ai/api/v1";

/**
 * Прокси OpenRouter на машине агента. Hermes ходит сюда вместо openrouter.ai,
 * и каждый успешный вызов модели пишет в журнал ту сумму, которую OpenRouter
 * вернул в `usage.cost`, а не оценку по прайсу.
 */
export async function proxyOpenRouter(
  req: Request,
  ledger: LlmCostLedger,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const marker = "/openrouter/v1";
  const at = url.pathname.indexOf(marker);
  const rest = at >= 0 ? url.pathname.slice(at + marker.length) || "/" : url.pathname;
  const target = `${UPSTREAM}${rest}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  const track = req.method === "POST" && /\/(chat\/completions|completions|responses)$/.test(rest);
  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : withUsageAccounting(await req.arrayBuffer(), track);
  const upstream = await fetchImpl(target, { method: req.method, headers, ...(body ? { body } : {}) });
  if (!track || !upstream.ok || !upstream.body) return passthrough(upstream);

  const type = upstream.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) return streamCost(upstream, ledger, headers.get("authorization") ?? "", fetchImpl);
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const cost = await costFromBody(bytes, headers.get("authorization") ?? "", fetchImpl);
  ledger.note(cost);
  return new Response(bytes, { status: upstream.status, headers: forwardHeaders(upstream.headers) });
}

function passthrough(upstream: Response): Response {
  return new Response(upstream.body, { status: upstream.status, headers: forwardHeaders(upstream.headers) });
}

function forwardHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  return out;
}

/** Просим OpenRouter вернуть `usage.cost`. Без флага старые ответы приходят только с токенами. */
function withUsageAccounting(body: ArrayBuffer, track: boolean): Uint8Array {
  if (!track) return new Uint8Array(body);
  try {
    const json = JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
    const current = json["usage"];
    json["usage"] =
      current && typeof current === "object" && !Array.isArray(current) ? { ...current, include: true } : { include: true };
    return Buffer.from(JSON.stringify(json));
  } catch {
    return new Uint8Array(body);
  }
}

async function streamCost(upstream: Response, ledger: LlmCostLedger, authorization: string, fetchImpl: typeof fetch): Promise<Response> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let cost: number | null = null;
  let generationId: string | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = carry + decoder.decode();
        if (tail) ({ cost, generationId } = consumeSse(tail, cost, generationId));
        const billed = cost ?? (generationId ? await generationCost(generationId, authorization, fetchImpl) : 0);
        ledger.note(billed);
        controller.close();
        return;
      }
      controller.enqueue(value);
      const combined = carry + decoder.decode(value, { stream: true });
      const lines = combined.split("\n");
      carry = lines.pop() ?? "";
      if (lines.length) ({ cost, generationId } = consumeSse(lines.join("\n"), cost, generationId));
    },
  });
  return new Response(stream, { status: upstream.status, headers: forwardHeaders(upstream.headers) });
}

function consumeSse(
  text: string,
  cost: number | null,
  generationId: string | null,
): { cost: number | null; generationId: string | null } {
  let nextCost = cost;
  let nextId = generationId;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data) as { id?: unknown };
      const billed = openRouterCostUsd(json);
      if (billed != null) nextCost = billed;
      if (typeof json.id === "string" && json.id.startsWith("gen-")) nextId = json.id;
    } catch {
      // неполный или чужой кадр
    }
  }
  return { cost: nextCost, generationId: nextId };
}

async function costFromBody(bytes: Uint8Array, authorization: string, fetchImpl: typeof fetch): Promise<number> {
  let json: { id?: unknown } | null = null;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8")) as { id?: unknown };
  } catch {
    return 0;
  }
  const billed = openRouterCostUsd(json);
  if (billed != null) return billed;
  return typeof json.id === "string" && json.id.startsWith("gen-") ? generationCost(json.id, authorization, fetchImpl) : 0;
}

async function generationCost(id: string, authorization: string, fetchImpl: typeof fetch): Promise<number> {
  try {
    const res = await fetchImpl(`${UPSTREAM}/generation?id=${encodeURIComponent(id)}`, {
      headers: authorization ? { Authorization: authorization } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return 0;
    return openRouterCostUsd(await res.json()) ?? 0;
  } catch {
    return 0;
  }
}
