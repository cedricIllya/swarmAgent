"use client";

import type { ChatMessage, PendingApproval } from "@swarm/contracts";
import { fmtTime } from "./format";

/** Вопрос агента в ленте чата с кнопками «Да» и «Нет», пока решение не принято. */
export function ApprovalBubble({
  message,
  open,
  busy,
  onDecide,
}: {
  message: ChatMessage;
  open: boolean;
  busy: boolean;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div className="bubble bubble-agent bubble-approval">
      <div className="small" style={{ color: "var(--warn)", fontWeight: 500 }}>
        Нужно одобрение
      </div>
      <div>{message.text}</div>
      {open ? (
        <div className="approval-actions">
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onDecide(true)}>
            Да
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => onDecide(false)}>
            Нет
          </button>
        </div>
      ) : (
        <span className="faint small">Решение принято</span>
      )}
      <span className="bubble-time">{fmtTime(message.at)}</span>
    </div>
  );
}

/** Ожидание, у которого нет своей карточки в ленте: показывается над чатом. */
export function ApprovalRow({ approval, onDecide }: { approval: PendingApproval; onDecide: (approved: boolean) => void }) {
  return (
    <div className="list-item list-item-warn">
      <div>
        <div className="small" style={{ color: "var(--warn)", fontWeight: 500 }}>Нужно одобрение</div>
        <div>{approval.description}</div>
      </div>
      <div className="row">
        <button className="btn btn-sm btn-primary" onClick={() => onDecide(true)}>Да</button>
        <button className="btn btn-sm" onClick={() => onDecide(false)}>Нет</button>
      </div>
    </div>
  );
}
