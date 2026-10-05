"use client";

import { useEffect, useMemo, useState } from "react";

export interface ModelOption {
  id: string;
  name: string;
  promptPerM: number;
  completionPerM: number;
}

/** Селект моделей OpenRouter с поиском. Список грузится с `/api/models`. */
export function ModelSelect({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((j: { models: ModelOption[] }) => setModels(j.models ?? []))
      .catch(() => setModels([]));
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? models.filter((m) => m.id.includes(f) || m.name.toLowerCase().includes(f)) : models;
    return list.slice(0, 60);
  }, [models, filter]);

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <input
        className="input"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Поиск по моделям…"
        disabled={disabled}
        aria-label="Поиск модели"
      />
      <select
        id={id}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {!shown.some((m) => m.id === value) && <option value={value}>{value}</option>}
        {shown.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} — ${m.promptPerM.toFixed(2)} / ${m.completionPerM.toFixed(2)} за 1M
          </option>
        ))}
      </select>
    </div>
  );
}
