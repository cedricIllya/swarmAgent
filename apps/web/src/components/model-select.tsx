"use client";

import { useEffect, useState } from "react";

export interface ModelOption {
  id: string;
  name: string;
  promptPerM: number | null;
  completionPerM: number | null;
}

function priceLabel(m: ModelOption): string {
  if (m.promptPerM === null || m.completionPerM === null) return "цена зависит от маршрута";
  return `$${m.promptPerM.toFixed(2)} / $${m.completionPerM.toFixed(2)} за 1M`;
}

/** Список моделей OpenRouter с `/api/models`. Грузится один раз на компонент. */
export function useModelOptions(): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((j: { models: ModelOption[] }) => setModels(j.models ?? []))
      .catch(() => setModels([]));
  }, []);
  return models;
}

/** Селект моделей OpenRouter без поиска. */
export function ModelSelect({
  value,
  onChange,
  onBlur,
  disabled,
  id,
  autoFocus,
  className,
}: {
  value: string;
  onChange: (model: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  id?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const models = useModelOptions();
  const shown = models.slice(0, 60);

  return (
    <select
      id={id}
      className={className ? `select ${className}` : "select"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      disabled={disabled}
      autoFocus={autoFocus}
    >
      {!shown.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {shown.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} — {priceLabel(m)}
        </option>
      ))}
    </select>
  );
}
