"use client";

import { useState } from "react";

/** Адрес агента под именем: моноширинный текст и иконка копирования. */
export function AgentEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="agent-email">
      <code className="agent-email-value">{email}</code>
      <button
        type="button"
        className="icon-btn"
        onClick={() => void copy()}
        aria-label={copied ? "Адрес скопирован" : "Скопировать адрес"}
        title={copied ? "Скопировано" : "Скопировать адрес"}
      >
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="5.5" y="5.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </button>
      <span className={`agent-email-copied${copied ? " show" : ""}`} aria-live="polite">
        {copied ? "Скопировано" : ""}
      </span>
    </div>
  );
}
