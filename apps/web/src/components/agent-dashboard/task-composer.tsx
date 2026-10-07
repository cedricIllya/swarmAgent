"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { t } from "@/i18n";
import type { Agent } from "@swarm/contracts";

/** Поле задачи: без ленты чатов. История и кнопки живут в журнале задачи. */
export function TaskComposer({
  agent,
  onStage,
}: {
  agent: Agent;
  onStage: (title: string) => { drop: () => void; adopt: (runId: string) => void };
}) {
  const [autonomous, setAutonomous] = useState(agent.autonomous);
  const [text, setText] = useState("");
  const textRef = useRef("");
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

  function write(next: string) {
    textRef.current = next;
    setText(next);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = textRef.current.trim();
    if (!message || !running) return;
    write("");
    setError(null);
    const staged = onStage(message);
    try {
      const res = await fetch(`/api/agents/${agent.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        staged.drop();
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("task.sendFailed"));
        if (!textRef.current.trim()) write(message);
        return;
      }
      const data = (await res.json().catch(() => null)) as { runId?: string } | null;
      if (data?.runId) staged.adopt(data.runId);
    } catch {
      staged.drop();
      setError(t("task.sendFailed"));
      if (!textRef.current.trim()) write(message);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{t("task.title")}</h2>
          <span className="muted small">{t("task.lead")}</span>
        </div>
        <label className="switch" title={t("task.autonomousTitle")}>
          <input type="checkbox" checked={autonomous} onChange={(e) => void toggle(e.target.checked)} />
          <span className="switch-track" />
          <span className="small">{t("task.autonomous")}</span>
        </label>
      </div>
      <form onSubmit={(e) => void send(e)} className="row" style={{ alignItems: "flex-end" }}>
        <textarea
          className="textarea"
          value={text}
          onChange={(e) => write(e.target.value)}
          placeholder={running ? t("task.placeholder") : t("task.waiting")}
          disabled={!running}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={!running || !text.trim()}>
          {t("task.send")}
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
