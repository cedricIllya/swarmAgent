"use client";

import { useEffect, useState } from "react";
import type { Agent, BrowserSession, ChatMessage } from "@swarm/contracts";
import { fmtTime } from "./format";

function actionLine(action: Record<string, unknown>): string {
  const type = String(action.type ?? "шаг");
  const extra = action.url ?? action.instruction ?? action.kind ?? "";
  return extra ? `${type}: ${String(extra)}` : type;
}

/** Сессия браузера в ленте чата: живой экран, пока открыта, после закрытия — запись. */
export function BrowserBubble({
  agent,
  message,
  session,
  liveActions,
}: {
  agent: Agent;
  message: ChatMessage;
  session: BrowserSession | null;
  liveActions: Array<Record<string, unknown>>;
}) {
  const [loaded, setLoaded] = useState<Array<Record<string, unknown>>>([]);
  const live = Boolean(session && !session.finishedAt && session.liveUrl);
  const sessionId = message.sessionId!;

  useEffect(() => {
    if (!live) return;
    let cancel = false;
    void fetch(`/api/agents/${agent.id}/browser-sessions/${sessionId}/actions`).then(async (res) => {
      if (!res.ok || cancel) return;
      const data = (await res.json()) as { actions?: Array<Record<string, unknown>> };
      setLoaded(data.actions ?? []);
    });
    return () => {
      cancel = true;
    };
  }, [agent.id, sessionId, live]);

  const seen = new Set<string>();
  const actions = [...loaded, ...liveActions].filter((a) => {
    const key = JSON.stringify(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="bubble bubble-agent bubble-browser">
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span>
          {live && <span className="badge-dot pulse" style={{ marginRight: 6 }} />}
          {message.text}
        </span>
        {live && session?.liveUrl && (
          <a className="small" href={session.liveUrl} target="_blank" rel="noopener noreferrer">
            открыть в новой вкладке
          </a>
        )}
      </div>
      {live && session?.liveUrl ? (
        <>
          <iframe
            className="live-frame"
            src={session.liveUrl}
            sandbox="allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write"
            title={session.purpose}
          />
          {actions.length > 0 && (
            <div className="steps">
              {actions.slice(-8).map((a, i) => (
                <div key={i} className="step">{actionLine(a)}</div>
              ))}
            </div>
          )}
        </>
      ) : session?.hasVideo ? (
        <video controls preload="none" src={`/api/agents/${agent.id}/browser-sessions/${session.id}/video`} />
      ) : (
        <span className="faint small">
          {!session
            ? "сессия не найдена"
            : session.finishedAt
              ? "сессия завершена, видео недоступно"
              : session.provider === "skyvern"
                ? "сессия идёт, живой экран для Skyvern недоступен — видео появится после"
                : "сессия идёт, видео появится после"}
        </span>
      )}
      <span className="bubble-time">{fmtTime(message.at)}</span>
    </div>
  );
}
