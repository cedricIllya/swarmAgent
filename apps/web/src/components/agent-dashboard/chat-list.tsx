"use client";

import type { ChatThread, PendingApproval } from "@swarm/contracts";
import { fmtTime } from "./format";

export function ChatList({
  chats,
  activeId,
  approvals,
  onSelect,
}: {
  chats: ChatThread[];
  activeId: string | null;
  approvals: PendingApproval[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="chat-list">
      <button className="btn btn-sm" type="button" onClick={() => onSelect("new")}>
        Новый чат
      </button>
      {chats.map((c) => (
        <ChatListItem
          key={c.id}
          chat={c}
          active={c.id === activeId}
          waiting={approvals.some((p) => p.chatId === c.id)}
          onSelect={() => onSelect(c.id)}
        />
      ))}
    </div>
  );
}

function ChatListItem({
  chat,
  active,
  waiting,
  onSelect,
}: {
  chat: ChatThread;
  active: boolean;
  waiting: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`chat-list-item${active ? " active" : ""}`} onClick={onSelect}>
      <span className="row" style={{ justifyContent: "space-between", gap: 6 }}>
        <span>{chat.title}</span>
        {chat.busy && <span className="badge-dot pulse" title="агент работает" />}
        {waiting && <span className="badge badge-warn">ждёт</span>}
      </span>
      {chat.lastMessage && <span className="faint small chat-preview">{chat.lastMessage}</span>}
      <span className="faint small">{fmtTime(chat.updatedAt)}</span>
    </button>
  );
}
