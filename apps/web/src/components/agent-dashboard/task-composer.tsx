"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Agent } from "@swarm/contracts";

/** Поле задачи: без ленты чатов. История и кнопки живут в журнале задачи. */
export function TaskComposer({ agent }: { agent: Agent }) {
  const [autonomous, setAutonomous] = useState(agent.autonomous);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = agent.status === "running";

  useEffect(() => {
    setAutonomous(agent.autonomous);
  }, [agent.autonomous]);

  async function toggle(v: boolean) {
    setAutonomous(v);
    await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomous: v }),
    });
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/agents/${agent.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "Не удалось отправить задачу");
      return;
    }
    setText("");
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Задача</h2>
          <span className="muted small">Ссылка-приглашение, ключ или что сделать</span>
        </div>
        <label className="switch" title="Агент не будет спрашивать одобрение перед изменениями">
          <input type="checkbox" checked={autonomous} onChange={(e) => void toggle(e.target.checked)} />
          <span className="switch-track" />
          <span className="small">Разрешать все действия без человека</span>
        </label>
      </div>
      <form onSubmit={(e) => void send(e)} className="row" style={{ alignItems: "flex-end" }}>
        <textarea
          className="textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={running ? "Ссылка-приглашение, API-ключ или задача" : "Агент ещё поднимается…"}
          disabled={!running}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={!running || busy || !text.trim()}>
          {busy ? "…" : "Отправить"}
        </button>
      </form>
      {error && (
        <p className="small" style={{ margin: "8px 0 0", color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </section>
  );
}
