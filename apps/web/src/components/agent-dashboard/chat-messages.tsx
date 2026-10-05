"use client";

import { useEffect, useRef } from "react";
import type { Agent, ChatMessage, PendingApproval, RuntimeState } from "@swarm/contracts";
import { ApprovalBubble } from "./approval-bubbles";
import { BrowserBubble } from "./browser-bubble";
import { fmtTime } from "./format";
import { Linkified } from "./linkified";
import { retryBubbleIndexes } from "./retry-anchor";
import type { LiveActions } from "./use-agent-live";
import { ChatPaneSkeleton } from "../skeleton";

/** Лента одного чата: обычные пузыри, карточки браузера и одобрений, индикатор работы. */
export function ChatMessages({
  agent,
  state,
  messages,
  approvals,
  actionsBySession,
  deciding,
  onDecide,
  working,
  activity,
  retryEnabled,
  onRetry,
  loading,
}: {
  agent: Agent;
  state: RuntimeState | null;
  messages: ChatMessage[];
  approvals: PendingApproval[];
  actionsBySession: LiveActions;
  deciding: string | null;
  onDecide: (approvalId: string, approved: boolean) => void;
  working: boolean;
  activity: string;
  /** Агент на связи и в этом чате сейчас ничего не выполняется. */
  retryEnabled: boolean;
  onRetry: (runId: string) => void;
  loading?: boolean;
}) {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, working, activity]);

  const failedRunIds = new Set(
    (state?.runs ?? [])
      .filter((r) => r.status === "failed" && r.trigger === "chat")
      .map((r) => r.id),
  );
  const retryAt = retryBubbleIndexes(messages, failedRunIds);

  if (loading) return <ChatPaneSkeleton />;

  return (
    <div className="chat">
      {!messages.length && <p className="faint small" style={{ margin: 0 }}>Сообщений пока нет. Ссылка-приглашение, ключ или задача.</p>}
      {messages.map((m, i) =>
        m.kind === "browser" && m.sessionId ? (
          <BrowserBubble
            key={`${m.at}-${i}`}
            agent={agent}
            message={m}
            session={state?.browserSessions.find((s) => s.id === m.sessionId) ?? null}
            liveActions={actionsBySession[m.sessionId] ?? []}
          />
        ) : m.kind === "approval" && m.role === "agent" ? (
          <ApprovalBubble
            key={`${m.at}-${i}`}
            message={m}
            open={approvals.some((p) => p.id === m.approvalId)}
            busy={deciding === m.approvalId}
            onDecide={(approved) => onDecide(m.approvalId ?? "", approved)}
          />
        ) : (
          <div key={`${m.at}-${i}`} className={`bubble ${m.role === "user" ? "bubble-user" : "bubble-agent"}`}>
            <Linkified text={m.text} />
            {retryAt.has(i) && m.runId && (
              <div className="bubble-retry">
                <button type="button" className="btn btn-ghost btn-sm" disabled={!retryEnabled} onClick={() => onRetry(m.runId!)}>
                  Повторить
                </button>
              </div>
            )}
            <span className="bubble-time">{fmtTime(m.at)}</span>
          </div>
        ),
      )}
      {working && (
        <div className="bubble bubble-agent bubble-working">
          <span className="typing" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span>{activity}</span>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}
