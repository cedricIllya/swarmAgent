"use client";

import { useState, type FormEvent } from "react";
import type { Agent } from "@swarm/contracts";
import { ModelSelect } from "./model-select";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export function CreateAgentForm({ ownerLogin, onCreated }: { ownerLogin: string; onCreated: (a: Agent) => void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [localPart, setLocalPart] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        <span className="faint small">Адрес соберётся из вашего логина и имени: Владимир Ленин → {ownerLogin}.vladimir.lenin@…</span>
      </div>
      <div className="field">
        <label className="label">Адрес вручную (необязательно)</label>
        <input
          className="input mono"
          value={localPart}
          onChange={(e) => setLocalPart(e.target.value)}
          pattern="[A-Za-z0-9._\-]+"
          placeholder="только буквы, цифры, точки, дефисы, подчёркивания"
        />
      </div>
      <div className="field">
        <label className="label">Модель (OpenRouter)</label>
        <ModelSelect value={model} onChange={setModel} disabled={busy} />
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
