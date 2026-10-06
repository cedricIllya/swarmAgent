"use client";

import { useState, type FormEvent } from "react";
import type { Agent } from "@swarm/contracts";
import { ModelSelect } from "./model-select";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export function CreateAgentForm({ ownerLogin, onCreated }: { ownerLogin: string; onCreated: (a: Agent) => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), model }),
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
      <div className="name-fields">
        <div className="field">
          <label className="label">Имя</label>
          <input
            className="input"
            required
            maxLength={40}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="Владимир"
            autoComplete="given-name"
          />
        </div>
        <div className="field">
          <label className="label">Фамилия</label>
          <input
            className="input"
            required
            maxLength={40}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Ленин"
            autoComplete="family-name"
          />
        </div>
      </div>
      <p className="faint small" style={{ margin: "-6px 0 14px" }}>
        Адрес соберётся из вашего логина, имени и фамилии: Владимир Ленин → {ownerLogin}.vladimir.lenin@…
      </p>
      <div className="field">
        <label className="label">Модель</label>
        <ModelSelect value={model} onChange={setModel} disabled={busy} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" type="submit" disabled={busy || !firstName.trim() || !lastName.trim()}>
          {busy ? "Создаём…" : "Создать"}
        </button>
      </div>
    </form>
  );
}
