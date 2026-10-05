export interface ModelOption {
  id: string;
  name: string;
  /** $ за миллион токенов. null — цена зависит от маршрута (OpenRouter отдаёт -1 для роутеров). */
  promptPerM: number | null;
  completionPerM: number | null;
  context: number;
}

function perMillion(raw: string | undefined): number | null {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

let cache: { at: number; list: ModelOption[] } | null = null;

/** Список моделей OpenRouter, 10 минут в памяти. Без ключа — список публичный. */
export async function listModels(): Promise<ModelOption[]> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  const res = await fetch("https://openrouter.ai/api/v1/models", { next: { revalidate: 600 } });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const json = (await res.json()) as {
    data: Array<{
      id: string;
      name: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      architecture?: { output_modalities?: string[] };
      supported_parameters?: string[];
    }>;
  };
  const list = json.data
    .filter((m) => (m.architecture?.output_modalities ?? ["text"]).includes("text"))
    .filter((m) => (m.supported_parameters ?? []).includes("tools"))
    .map((m) => ({
      id: m.id,
      name: m.name,
      promptPerM: perMillion(m.pricing?.prompt),
      completionPerM: perMillion(m.pricing?.completion),
      context: m.context_length ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), list };
  return list;
}
