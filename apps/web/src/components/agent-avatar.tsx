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
import { t, type MessageKey } from "@/i18n";

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
      setError(json?.error ?? t("agent.avatarSaveFailed"));
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
        title={t("agent.buildAvatar")}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <AgentFace agent={agent} size="lg" />
        <span className="agent-avatar-hint">{busy ? t("common.ellipsis") : t("agent.build")}</span>
      </div>
      {agent.avatar && (
        <button type="button" className="agent-avatar-clear" disabled={busy} onClick={() => void save(null)}>
          {t("agent.removeAvatar")}
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

  const hairLabel: Record<CreatedAvatar["hairStyle"], MessageKey> = {
    normal: "avatar.hairNormal",
    thick: "avatar.hairThick",
    mohawk: "avatar.hairMohawk",
    womanLong: "avatar.hairLong",
    womanShort: "avatar.hairShort",
  };
  const hairOptions = (draft.sex === "man" ? HAIR_MAN : HAIR_WOMAN).map((id) => ({
    id,
    label: t(hairLabel[id]),
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
        <h2 id="avatar-studio-title">{t("avatar.title")}</h2>
        <p className="muted small" style={{ marginTop: 4 }}>
          {t("avatar.lead", { name: agent.name })}
        </p>
        <div className="avatar-studio">
          <div className="avatar-preview">
            <AgentFace agent={preview} size="xl" />
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDraft(freeze({}))}>
              {t("avatar.random")}
            </button>
          </div>
          <div className="avatar-options">
            <Choice label={t("avatar.sex")} value={draft.sex} options={[{ id: "man", label: t("avatar.man") }, { id: "woman", label: t("avatar.woman") }]} onChange={(sex) => patch({ sex })} />
            <Choice label={t("avatar.hair")} value={draft.hairStyle} options={hairOptions} onChange={(hairStyle) => patch({ hairStyle })} />
            <Swatches label={t("avatar.hairColor")} value={draft.hairColor} colors={HAIR} onChange={(hairColor) => patch({ hairColor })} />
            <Choice label={t("avatar.hat")} value={draft.hatStyle} options={[{ id: "none", label: t("avatar.hatNone") }, { id: "beanie", label: t("avatar.hatBeanie") }, { id: "turban", label: t("avatar.hatTurban") }]} onChange={(hatStyle) => patch({ hatStyle })} />
            {draft.hatStyle !== "none" && <Swatches label={t("avatar.hatColor")} value={draft.hatColor} colors={HAIR} onChange={(hatColor) => patch({ hatColor })} />}
            <Choice label={t("avatar.ears")} value={draft.earSize} options={[{ id: "small", label: t("avatar.earsSmall") }, { id: "big", label: t("avatar.earsBig") }]} onChange={(earSize) => patch({ earSize })} />
            <Choice label={t("avatar.eyes")} value={draft.eyeStyle} options={[{ id: "circle", label: t("avatar.eyesCircle") }, { id: "oval", label: t("avatar.eyesOval") }, { id: "smile", label: t("avatar.eyesSmile") }]} onChange={(eyeStyle) => patch({ eyeStyle })} />
            <Choice label={t("avatar.glasses")} value={draft.glassesStyle} options={[{ id: "none", label: t("avatar.hatNone") }, { id: "round", label: t("avatar.glassesRound") }, { id: "square", label: t("avatar.glassesSquare") }]} onChange={(glassesStyle) => patch({ glassesStyle })} />
            <Choice label={t("avatar.nose")} value={draft.noseStyle} options={[{ id: "short", label: t("avatar.noseShort") }, { id: "long", label: t("avatar.noseLong") }, { id: "round", label: t("avatar.noseRound") }]} onChange={(noseStyle) => patch({ noseStyle })} />
            <Choice label={t("avatar.mouth")} value={draft.mouthStyle} options={[{ id: "laugh", label: t("avatar.mouthLaugh") }, { id: "smile", label: t("avatar.mouthSmile") }, { id: "peace", label: t("avatar.mouthPeace") }]} onChange={(mouthStyle) => patch({ mouthStyle })} />
            <Swatches label={t("avatar.skin")} value={draft.faceColor} colors={FACE} onChange={(faceColor) => patch({ faceColor })} />
            <Choice label={t("avatar.clothes")} value={draft.shirtStyle} options={[{ id: "hoody", label: t("avatar.clothesHoody") }, { id: "short", label: t("avatar.clothesShirt") }, { id: "polo", label: t("avatar.clothesPolo") }]} onChange={(shirtStyle) => patch({ shirtStyle })} />
            <Swatches label={t("avatar.clothesColor")} value={draft.shirtColor} colors={SHIRT} onChange={(shirtColor) => patch({ shirtColor })} />
            <Swatches label={t("avatar.background")} value={draft.bgColor} colors={BG} onChange={(bgColor) => patch({ bgColor })} />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onSave(encodeCreatedAvatar(draft))}>
            {busy ? t("common.saving") : t("common.save")}
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
