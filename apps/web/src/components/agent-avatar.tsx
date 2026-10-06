"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Avatar, { genConfig } from "react-nice-avatar";
import {
  CreatedAvatarSchema,
  encodeCreatedAvatar,
  parseCreatedAvatar,
  type Agent,
  type CreatedAvatar,
} from "@swarm/contracts";

const TONES = ["#f3d7a1", "#f0c7b0", "#d9e4c8", "#d4e2f0", "#e6d4f0", "#f3e3b8"];
const FACE = ["#F9C9B6", "#AC6651"];
const HAIR = ["#000", "#fff", "#77311D", "#FC909F", "#D2EFF3", "#506AF4", "#F48150"];
const SHIRT = ["#9287FF", "#6BD9E9", "#FC909F", "#F4D150", "#77311D"];
const BG = ["#9287FF", "#6BD9E9", "#FC909F", "#F4D150", "#E0DDFF", "#D2EFF3", "#FFEDEF", "#FFEBA4", "#506AF4", "#F48150", "#74D153"];

const HAIR_MAN = ["normal", "thick", "mohawk"] as const;
const HAIR_WOMAN = ["normal", "womanLong", "womanShort"] as const;

function tone(name: string): string {
  let n = 0;
  for (const ch of name) n = (n + ch.charCodeAt(0)) % TONES.length;
  return TONES[n] ?? TONES[0]!;
}

function initials(agent: Pick<Agent, "name" | "firstName" | "lastName">): string {
  const first = agent.firstName?.trim().charAt(0);
  const last = agent.lastName?.trim().charAt(0);
  if (first && last) return (first + last).toUpperCase();
  const parts = agent.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]!.charAt(0)}${parts[1]!.charAt(0)}`.toUpperCase();
  return (parts[0]?.slice(0, 2) ?? "?").toUpperCase();
}

function freeze(input: Parameters<typeof genConfig>[0]): CreatedAvatar {
  const full = genConfig(input ?? {});
  return CreatedAvatarSchema.parse({
    sex: full.sex,
    faceColor: full.faceColor,
    earSize: full.earSize,
    hairColor: full.hairColor,
    hairStyle: full.hairStyle,
    hatColor: full.hatColor,
    hatStyle: full.hatStyle,
    eyeStyle: full.eyeStyle,
    eyeBrowStyle: full.eyeBrowStyle === "upWoman" ? "upWoman" : "up",
    glassesStyle: full.glassesStyle,
    noseStyle: full.noseStyle,
    mouthStyle: full.mouthStyle,
    shirtStyle: full.shirtStyle,
    shirtColor: full.shirtColor,
    bgColor: full.bgColor.startsWith("#") ? full.bgColor : "#E0DDFF",
  });
}

/** Библиотека ставит одни и те же id у масок. У каждого экземпляра они свои, иначе лица на списке слипаются. */
function IsolatedAvatar({ config }: { config: CreatedAvatar }) {
  const ref = useRef<HTMLDivElement>(null);
  const suffix = useId().replace(/[^a-zA-Z0-9]/g, "");
  const key = JSON.stringify(config);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of [...root.querySelectorAll("[id]")]) {
      const id = el.id;
      if (!id || id.endsWith(suffix)) continue;
      const next = `${id}-${suffix}`;
      const from = `url(#${id})`;
      const to = `url(#${next})`;
      el.id = next;
      for (const node of root.querySelectorAll("*")) {
        for (const attr of [...node.attributes]) {
          if (attr.value.includes(from)) attr.value = attr.value.split(from).join(to);
        }
      }
    }
  }, [key, suffix]);

  return (
    <div ref={ref} className="agent-face-canvas">
      <Avatar shape="square" hairColorRandom style={{ width: "100%", height: "100%" }} {...config} />
    </div>
  );
}

/** Квадрат агента: собранное лицо или инициалы. */
export function AgentFace({
  agent,
  size = "md",
}: {
  agent: Pick<Agent, "name" | "firstName" | "lastName" | "avatar">;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const created = parseCreatedAvatar(agent.avatar);
  return (
    <div
      className={`agent-face agent-face-${size}`}
      style={created ? undefined : { background: tone(agent.name), color: "#3a2a12" }}
      aria-hidden
    >
      {created ? <IsolatedAvatar config={created} /> : initials(agent)}
    </div>
  );
}

/** Кнопка на карточке агента: собрать лицо или вернуть инициалы. */
export function AgentAvatarControl({
  agent,
  onUpdated,
}: {
  agent: Agent;
  onUpdated: (agent: Agent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(avatar: string | null) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar }),
    });
    const json = (await res.json().catch(() => null)) as { agent?: Agent; error?: string } | null;
    setBusy(false);
    if (!res.ok || !json?.agent) {
      setError(json?.error ?? "Не получилось сохранить аватар");
      return;
    }
    onUpdated(json.agent);
    setOpen(false);
  }

  return (
    <div className="agent-avatar-edit">
      <div
        className="agent-avatar-btn"
        role="button"
        tabIndex={0}
        title="Собрать аватар"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <AgentFace agent={agent} size="lg" />
        <span className="agent-avatar-hint">{busy ? "…" : "собрать"}</span>
      </div>
      {agent.avatar && (
        <button type="button" className="agent-avatar-clear" disabled={busy} onClick={() => void save(null)}>
          Убрать
        </button>
      )}
      {error && <span className="agent-avatar-error">{error}</span>}
      {open && (
        <AvatarStudio
          agent={agent}
          busy={busy}
          onClose={() => setOpen(false)}
          onSave={(avatar) => void save(avatar)}
        />
      )}
    </div>
  );
}

function AvatarStudio({
  agent,
  busy,
  onClose,
  onSave,
}: {
  agent: Agent;
  busy: boolean;
  onClose: () => void;
  onSave: (avatar: string) => void;
}) {
  const [draft, setDraft] = useState<CreatedAvatar>(() => parseCreatedAvatar(agent.avatar) ?? freeze(agent.email || agent.name));
  const preview = { ...agent, avatar: encodeCreatedAvatar(draft) };

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function patch(next: Partial<CreatedAvatar>) {
    setDraft((prev) => {
      const sex = next.sex ?? prev.sex;
      const allowed: readonly CreatedAvatar["hairStyle"][] = sex === "man" ? HAIR_MAN : HAIR_WOMAN;
      const requested = next.hairStyle ?? prev.hairStyle;
      const hairStyle = allowed.includes(requested) ? requested : sex === "man" ? "normal" : "womanLong";
      return {
        ...prev,
        ...next,
        sex,
        hairStyle,
        eyeBrowStyle: sex === "man" ? "up" : (next.eyeBrowStyle ?? (prev.sex === "man" ? "upWoman" : prev.eyeBrowStyle)),
      };
    });
  }

  const hairOptions = (draft.sex === "man" ? HAIR_MAN : HAIR_WOMAN).map((id) => ({
    id,
    label: { normal: "обычные", thick: "густые", mohawk: "ирокез", womanLong: "длинные", womanShort: "короткие" }[id],
  }));

  const sheet = (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal-avatar"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-studio-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="avatar-studio-title">Аватар</h2>
        <p className="muted small" style={{ marginTop: 4 }}>
          Соберите лицо для {agent.name}. Случайный вариант можно покрутить и поправить.
        </p>
        <div className="avatar-studio">
          <div className="avatar-preview">
            <AgentFace agent={preview} size="xl" />
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDraft(freeze({}))}>
              Случайный
            </button>
          </div>
          <div className="avatar-options">
            <Choice label="Пол" value={draft.sex} options={[{ id: "man", label: "мужчина" }, { id: "woman", label: "женщина" }]} onChange={(sex) => patch({ sex })} />
            <Choice label="Волосы" value={draft.hairStyle} options={hairOptions} onChange={(hairStyle) => patch({ hairStyle })} />
            <Swatches label="Цвет волос" value={draft.hairColor} colors={HAIR} onChange={(hairColor) => patch({ hairColor })} />
            <Choice label="Шапка" value={draft.hatStyle} options={[{ id: "none", label: "нет" }, { id: "beanie", label: "шапка" }, { id: "turban", label: "тюрбан" }]} onChange={(hatStyle) => patch({ hatStyle })} />
            {draft.hatStyle !== "none" && <Swatches label="Цвет шапки" value={draft.hatColor} colors={HAIR} onChange={(hatColor) => patch({ hatColor })} />}
            <Choice label="Уши" value={draft.earSize} options={[{ id: "small", label: "маленькие" }, { id: "big", label: "большие" }]} onChange={(earSize) => patch({ earSize })} />
            <Choice label="Глаза" value={draft.eyeStyle} options={[{ id: "circle", label: "круглые" }, { id: "oval", label: "овальные" }, { id: "smile", label: "улыбка" }]} onChange={(eyeStyle) => patch({ eyeStyle })} />
            <Choice label="Очки" value={draft.glassesStyle} options={[{ id: "none", label: "нет" }, { id: "round", label: "круглые" }, { id: "square", label: "квадратные" }]} onChange={(glassesStyle) => patch({ glassesStyle })} />
            <Choice label="Нос" value={draft.noseStyle} options={[{ id: "short", label: "короткий" }, { id: "long", label: "длинный" }, { id: "round", label: "круглый" }]} onChange={(noseStyle) => patch({ noseStyle })} />
            <Choice label="Рот" value={draft.mouthStyle} options={[{ id: "laugh", label: "смех" }, { id: "smile", label: "улыбка" }, { id: "peace", label: "спокойный" }]} onChange={(mouthStyle) => patch({ mouthStyle })} />
            <Swatches label="Кожа" value={draft.faceColor} colors={FACE} onChange={(faceColor) => patch({ faceColor })} />
            <Choice label="Одежда" value={draft.shirtStyle} options={[{ id: "hoody", label: "худи" }, { id: "short", label: "футболка" }, { id: "polo", label: "поло" }]} onChange={(shirtStyle) => patch({ shirtStyle })} />
            <Swatches label="Цвет одежды" value={draft.shirtColor} colors={SHIRT} onChange={(shirtColor) => patch({ shirtColor })} />
            <Swatches label="Фон" value={draft.bgColor} colors={BG} onChange={(bgColor) => patch({ bgColor })} />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onSave(encodeCreatedAvatar(draft))}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
}) {
  return (
    <div className="avatar-row">
      <span className="avatar-row-label">{label}</span>
      <div className="avatar-choices">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={option.id === value ? "avatar-choice on" : "avatar-choice"}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Swatches({
  label,
  value,
  colors,
  onChange,
}: {
  label: string;
  value: string;
  colors: string[];
  onChange: (color: string) => void;
}) {
  return (
    <div className="avatar-row">
      <span className="avatar-row-label">{label}</span>
      <div className="avatar-choices">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            className={color.toLowerCase() === value.toLowerCase() ? "avatar-swatch on" : "avatar-swatch"}
            style={{ background: color }}
            aria-label={color}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  );
}
