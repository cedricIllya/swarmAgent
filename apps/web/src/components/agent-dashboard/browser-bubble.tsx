"use client";

import { useEffect, useState } from "react";
import type { Agent, BrowserSession, ChatMessage } from "@swarm/contracts";
import { t } from "@/i18n";
import { fmtTime } from "./format";

function actionLine(action: Record<string, unknown>): string {
  const type = String(action.type ?? t("browser.step"));
  const extra = action.url ?? action.instruction ?? action.kind ?? "";
  return extra ? `${type}: ${String(extra)}` : type;
}

function shotFiles(actions: Array<Record<string, unknown>>): string[] {
  return actions
    .filter((a) => a.type === "screenshot" && /^\d{1,3}\.jpg$/.test(String(a.file ?? "")))
    .map((a) => String(a.file));
}

/** Кадры сессии: грузит журнал и показывает jpeg после каждого шага. */
export function SessionShots({
  agentId,
  sessionId,
  fallback,
}: {
  agentId: string;
  sessionId: string;
  fallback?: string;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let cancel = false;
    void fetch(`/api/agents/${agentId}/browser-sessions/${sessionId}/actions`).then(async (res) => {
      if (!res.ok || cancel) return;
      const data = (await res.json()) as { actions?: Array<Record<string, unknown>> };
      if (!cancel) setFiles(shotFiles(data.actions ?? []));
    });
    return () => {
      cancel = true;
    };
  }, [agentId, sessionId]);
  if (files === null) return <span className="faint small">{t("browser.loadingFrames")}</span>;
  if (!files.length) return fallback ? <span className="faint small">{fallback}</span> : null;
  return <BrowserShots agentId={agentId} sessionId={sessionId} files={files} />;
}

/** Кадры своего браузера: что страница показывала после каждого шага. */
export function BrowserShots({ agentId, sessionId, files }: { agentId: string; sessionId: string; files: string[] }) {
  if (!files.length) return null;
  return (
    <div className="shot-list">
      {files.map((file, i) => (
        <a key={file} href={`/api/agents/${agentId}/browser-sessions/${sessionId}/shots/${file}`} target="_blank" rel="noopener noreferrer">
          <img src={`/api/agents/${agentId}/browser-sessions/${sessionId}/shots/${file}`} alt={t("browser.stepAlt", { n: i + 1 })} />
        </a>
      ))}
    </div>
  );
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
  const [loaded, setLoaded] = useState<Array<Record<string, unknown>> | null>(null);
  const live = Boolean(session && !session.finishedAt && session.liveUrl);
  // Страница Skyvern не встраивается в iframe и даёт «взять управление» — туда ведём ссылкой.
  const embeddable = live && session?.provider !== "skyvern";
  const sessionId = message.sessionId!;

  useEffect(() => {
    let cancel = false;
    void fetch(`/api/agents/${agent.id}/browser-sessions/${sessionId}/actions`).then(async (res) => {
      if (!res.ok || cancel) return;
      const data = (await res.json()) as { actions?: Array<Record<string, unknown>> };
      setLoaded(data.actions ?? []);
    });
    return () => {
      cancel = true;
    };
  }, [agent.id, sessionId]);

  const seen = new Set<string>();
  const actions = [...(loaded ?? []), ...liveActions].filter((a) => {
    const key = JSON.stringify(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const shots = shotFiles(actions);

  return (
    <div className="bubble bubble-agent bubble-browser">
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span>
          {live && <span className="badge-dot pulse" style={{ marginRight: 6 }} />}
          {message.text}
        </span>
        {embeddable && session?.liveUrl && (
          <a className="small" href={session.liveUrl} target="_blank" rel="noopener noreferrer">
            {t("browser.openTab")}
          </a>
        )}
      </div>
      {live && session?.liveUrl ? (
        <>
          {embeddable ? (
            <iframe
              className="live-frame"
              src={session.liveUrl}
              sandbox="allow-same-origin allow-scripts"
              allow="clipboard-read; clipboard-write"
              title={session.purpose}
            />
          ) : (
            <div className="approval-actions">
              <a className="btn btn-sm btn-primary" href={session.liveUrl} target="_blank" rel="noopener noreferrer">
                {t("browser.watch")}
              </a>
              <span className="faint small">{t("browser.takeControl")}</span>
            </div>
          )}
          <BrowserShots agentId={agent.id} sessionId={sessionId} files={shots} />
          {actions.length > 0 && (
            <div className="steps">
              {actions.filter((a) => a.type !== "screenshot").slice(-8).map((a, i) => (
                <div key={i} className="step">{actionLine(a)}</div>
              ))}
            </div>
          )}
        </>
      ) : session?.hasVideo ? (
        <video controls preload="none" src={`/api/agents/${agent.id}/browser-sessions/${session.id}/video`} />
      ) : shots.length > 0 ? (
        <BrowserShots agentId={agent.id} sessionId={sessionId} files={shots} />
      ) : (
        <span className="faint small">
          {!session
            ? t("browser.missing")
            : loaded === null
              ? t("browser.loadingSteps")
              : session.finishedAt
                ? t("browser.finished")
                : t("browser.waitingFrame")}
        </span>
      )}
      <span className="bubble-time">{fmtTime(message.at)}</span>
    </div>
  );
}
