"use client";

import { useState } from "react";
import type { ChatThread } from "@swarm/contracts";

/** Заголовок чата: двойной клик переименовывает, кнопка удаляет. */
export function ChatTitle({
  chat,
  onRename,
  onRemove,
}: {
  chat: ChatThread | null;
  onRename: (title: string) => Promise<void>;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  async function save() {
    setRenaming(false);
    if (!chat || !draft.trim()) return;
    await onRename(draft.trim());
  }

  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
      {renaming ? (
        <input
          className="input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
      ) : (
        <strong
          onDoubleClick={() => {
            if (!chat) return;
            setDraft(chat.title);
            setRenaming(true);
          }}
        >
          {chat?.title ?? "Новый чат"}
        </strong>
      )}
      {chat && (
        <button className="btn btn-sm" type="button" onClick={onRemove}>
          Удалить чат
        </button>
      )}
    </div>
  );
}
