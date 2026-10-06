"use client";

import { useState } from "react";
import type { ChatMessage, PendingApproval } from "@swarm/contracts";
import { fmtTime } from "./format";
import { StepText } from "./secret-value";

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

function composeAnswer(option: string | null, text: string): string {
  const extra = text.trim();
  if (option && extra) return `${option}\n${extra}`;
  return (option ?? extra).trim();
}

/** Вопрос модели в журнале задачи: кнопки вариантов и поле для своего ответа или ключа. */
export function QuestionCard({
  prompt,
  options,
  busy,
  onAnswer,
  title = "Нужен ответ",
  placeholder,
}: {
  prompt: string;
  options: string[];
  busy: boolean;
  onAnswer: (text: string) => void | Promise<void>;
  title?: string;
  placeholder?: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = composeAnswer(picked, text);

  if (sent) {
    return <p className="faint small" style={{ margin: "10px 0 0" }}>Ответ отправлен, задача продолжается.</p>;
  }

  async function submit() {
    if (!answer || busy) return;
    setError(null);
    try {
      await onAnswer(answer);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить ответ");
    }
  }

  return (
    <div className="list-item list-item-warn question-row">
      <div className="small" style={{ color: "var(--warn)", fontWeight: 500 }}>
        {title}
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>
        <StepText text={prompt} />
      </div>
      <form
        className="question-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {options.length > 0 && (
          <div className="question-options">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                className={`btn btn-sm${picked === option ? " is-selected" : ""}`}
                aria-pressed={picked === option}
                disabled={busy}
                onClick={() => setPicked((cur) => (cur === option ? null : option))}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        <textarea
          className="textarea"
          value={text}
          disabled={busy}
          placeholder={placeholder ?? (options.length ? "Вставьте ключ или напишите свой вариант" : "Напишите ответ")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="row">
          <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !answer}>
            {busy ? "…" : "Ответить"}
          </button>
        </div>
        {error && (
          <p className="small" style={{ margin: 0, color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

/** Ожидание, у которого нет своей карточки в ленте: показывается над чатом. */
export function ApprovalRow({
  approval,
  busy = false,
  onDecide,
  onAnswer,
}: {
  approval: PendingApproval;
  busy?: boolean;
  onDecide: (approved: boolean) => void;
  onAnswer?: (text: string) => void | Promise<void>;
}) {
  if (approval.kind === "question") {
    return (
      <QuestionCard
        prompt={approval.description}
        options={approval.options ?? []}
        busy={busy}
        onAnswer={onAnswer ?? (() => undefined)}
      />
    );
  }
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
