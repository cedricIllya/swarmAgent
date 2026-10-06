"use client";

import { useState } from "react";
import { Linkified } from "./linkified";
import { splitCodes } from "./secret-text";

/** Пароль или код: тёмная плашка, чтобы секрет не сливался с журналом. */
export function SecretValue({ kind, value }: { kind: "password" | "code"; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className={`secret secret-${kind}`}>
      <span className="secret-kicker">{kind === "password" ? "Пароль" : "Код"}</span>
      <code className="secret-value">{value}</code>
      <button type="button" className="secret-copy" onClick={() => void copy()}>
        {copied ? "Скопировано" : "Копировать"}
      </button>
    </span>
  );
}

/** Текст шага или сообщения: коды подтверждения вынесены в плашки. */
export function StepText({ text }: { text: string }) {
  const parts = splitCodes(text);
  return (
    <>
      {parts.map((part, i) =>
        part.type === "code" ? (
          <SecretValue key={i} kind="code" value={part.value} />
        ) : (
          <Linkified key={i} text={part.value} />
        ),
      )}
    </>
  );
}
