"use client";

import { useEffect, useState } from "react";
import type { Agent } from "@swarm/contracts";
import { ModelSelect } from "../model-select";

/**
 * Смена модели у уже созданного агента.
 * PATCH обновляет БД и runtime; при смене Hermes переписывается и машина перезапускается.
 */
export function AgentModelControl({
  agent,
  onUpdated,
}: {
  agent: Agent;
  onUpdated: (agent: Agent) => void;
}) {
  const [model, setModel] = useState(agent.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setModel(agent.model);
  }, [agent.model]);

  async function save(next: string) {
    if (next === agent.model || busy) {
      setModel(next);
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    setModel(next);
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: next }),
    });
    const json = (await res.json().catch(() => null)) as { agent?: Agent; error?: string } | null;
    setBusy(false);
    if (!res.ok || !json?.agent) {
      setModel(agent.model);
      setError(json?.error ?? "Не получилось сменить модель");
      return;
    }
    onUpdated(json.agent);
    setNote("Модель сохранена. Машина агента перезапускается с новым config.yaml.");
  }

  return (
    <div className="field" style={{ marginTop: 12, marginBottom: 0, maxWidth: 420 }}>
      <label className="label" htmlFor={`agent-model-${agent.id}`}>
        Модель
      </label>
      <ModelSelect id={`agent-model-${agent.id}`} value={model} onChange={(v) => void save(v)} disabled={busy} />
      {busy && <span className="faint small">Сохраняем…</span>}
      {note && !error && <span className="faint small">{note}</span>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
