"use client";

import { useState } from "react";
import type { Agent } from "@swarm/contracts";

export function EmailCard({ agent }: { agent: Agent }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Подключение сервисов</h2>
        <span className="muted small">Пришлите инвайт на почту или вставьте ссылку и ключ в чат</span>
      </div>
      <div className="email-box">
        <code>{agent.email}</code>
        <button
          className="btn btn-sm"
          onClick={async () => {
            await navigator.clipboard.writeText(agent.email);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
        <span className="muted small row" style={{ gap: 8 }}>
          Google:
          {agent.googleConnected ? (
            <span className="badge badge-ok">{agent.googleEmail ?? "подключён"}</span>
          ) : (
            <span className="badge">не подключён</span>
          )}
        </span>
        <a className="btn btn-sm" href={`/api/agents/${agent.id}/google`}>
          {agent.googleConnected ? "Переподключить Google" : "Подключить Google"}
        </a>
      </div>
    </section>
  );
}
