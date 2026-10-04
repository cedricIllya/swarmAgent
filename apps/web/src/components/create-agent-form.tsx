"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Agent } from "@swarm/contracts";

interface ModelOption {
  id: string;
  name: string;
  promptPerM: number;
  completionPerM: number;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export function CreateAgentForm({ onCreated }: { onCreated: (a: Agent) => void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [localPart, setLocalPart] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((j: { models: ModelOption[] }) => setModels(j.models ?? []))
      .catch(() => setModels([]));
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? models.filter((m) => m.id.includes(f) || m.name.toLowerCase().includes(f)) : models;
    return list.slice(0, 60);
  }, [models, filter]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, model, ...(localPart ? { localPart } : {}) }),
    });
    const json = (await res.json()) as { agent?: Agent; error?: string };
    setBusy(false);
    if (!res.ok || !json.agent) {
      setError(json.error ?? "Не получилось");
      return;
    }
    onCreated(json.agent);
  }

  return (
    <form onSubmit={submit}>
      <h2 style={{ marginBottom: 14 }}>Новый агент</h2>
      <div className="field">
        <label className="label">Имя</label>
        <input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Владимир Ленин" />
        <span className="faint small">Адрес соберётся из имени: Владимир Ленин → vladimir.lenin@…</span>
      </div>
      <div className="field">
        <label className="label">Адрес вручную (необязательно)</label>
        <input
          className="input mono"
          value={localPart}
          onChange={(e) => setLocalPart(e.target.value)}
          pattern="[A-Za-z0-9._-]+"
          placeholder="только буквы, цифры, точки, дефисы, подчёркивания"
        />
      </div>
      <div className="field">
        <label className="label">Модель (OpenRouter)</label>
        <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Поиск по моделям…" />
        <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
          {!shown.some((m) => m.id === model) && <option value={model}>{model}</option>}
          {shown.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} — ${m.promptPerM.toFixed(2)} / ${m.completionPerM.toFixed(2)} за 1M
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" type="submit" disabled={busy || !name}>
          {busy ? "Создаём…" : "Создать"}
        </button>
      </div>
    </form>
  );
}
