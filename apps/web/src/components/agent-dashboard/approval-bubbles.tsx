"use client";

import type { ChatMessage, PendingApproval } from "@swarm/contracts";
import { fmtTime } from "./format";

interface Labels {
  title: string;
  yes: string;
  no: string;
}

const APPROVAL: Labels = { title: "Нужно одобрение", yes: "Да", no: "Нет" };
/** Агент упёрся в барьер и ждёт человека: человек доделывает в браузере и возвращает управление. */
const HANDOFF: Labels = { title: "Нужна помощь в браузере", yes: "Я доделал, продолжай", no: "Отменить" };
const SERVICE_WAIT: Labels = { title: "Жду одобрения в сервисе", yes: "Одобрил, продолжай", no: "Отменить" };

function LiveLink({ url }: { url: string | null | undefined }) {
  if (!url) return null;
  const own = /skyvern\.com/i.test(url);
  return (
    <a className="btn btn-sm" href={url} target="_blank" rel="noopener noreferrer">
      {own ? "открыть браузер агента" : "открыть страницу"}
    </a>
  );
}

/** Вопрос агента в ленте чата с кнопками, пока решение не принято. */
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
  const labels = message.serviceWait ? SERVICE_WAIT : message.handoff ? HANDOFF : APPROVAL;
  return (
    <div className="bubble bubble-agent bubble-approval">
      <div className="small" style={{ color: "var(--warn)", fontWeight: 500 }}>
        {labels.title}
      </div>
      <div>{message.text}</div>
      {open ? (
        <div className="approval-actions">
          {message.handoff && !message.serviceWait && <LiveLink url={message.liveUrl} />}
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onDecide(true)}>
            {labels.yes}
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => onDecide(false)}>
            {labels.no}
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
export function ApprovalRow({
  approval,
  busy = false,
  onDecide,
}: {
  approval: PendingApproval;
  busy?: boolean;
  onDecide: (approved: boolean) => void;
}) {
  const handoff = approval.kind === "handoff";
  const labels = approval.serviceWait ? SERVICE_WAIT : handoff ? HANDOFF : APPROVAL;
  return (
    <div className="list-item list-item-warn">
      <div>
        <div className="small" style={{ color: "var(--warn)", fontWeight: 500 }}>{labels.title}</div>
        <div>{approval.description}</div>
      </div>
      <div className="row">
        {handoff && !approval.serviceWait && <LiveLink url={approval.liveUrl} />}
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onDecide(true)}>{labels.yes}</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => onDecide(false)}>{labels.no}</button>
      </div>
    </div>
  );
}
