"use client";

import { useEffect, useState } from "react";
import type { Agent } from "@swarm/contracts";
import { ModelSelect } from "../model-select";

/**
 * Модель агента: название как кнопка, по клику — селект без поиска.
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
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setModel(agent.model);
  }, [agent.model]);

  async function save(next: string) {
    setEditing(false);
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
    <div className="model-control">
      {editing ? (
        <ModelSelect
          id={`agent-model-${agent.id}`}
          className="model-control-select"
          value={model}
          onChange={(v) => void save(v)}
          onBlur={() => setEditing(false)}
          disabled={busy}
          autoFocus
        />
      ) : (
        <button
          type="button"
          className="model-chip"
          title="Сменить модель"
          disabled={busy}
          onClick={() => {
            setError(null);
            setNote(null);
            setEditing(true);
          }}
        >
          <span className="model-chip-label">модель</span>
          <span className="mono">{model}</span>
        </button>
      )}
      {busy && <span className="faint small">Сохраняем…</span>}
      {note && !error && <span className="faint small">{note}</span>}
      {error && <span className="small" style={{ color: "var(--danger)" }}>{error}</span>}
    </div>
  );
}
