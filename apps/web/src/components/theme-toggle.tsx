"use client";

import { useLayoutEffect, useState } from "react";
import { t, type MessageKey } from "@/i18n";
import {
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  applyTheme,
  commitTheme,
  readThemePreference,
  type ThemePreference,
} from "@/lib/theme";

const OPTIONS: { id: ThemePreference; label: MessageKey }[] = [
  { id: "light", label: "settings.themeLight" },
  { id: "dark", label: "settings.themeDark" },
  { id: "system", label: "settings.themeSystem" },
];

function currentThemeLabel(): string {
  return document.documentElement.dataset.theme === "dark" ? t("settings.themeToLight") : t("settings.themeToDark");
}

export function ThemeWatcher() {
  useLayoutEffect(() => {
    const applySystem = () => {
      if (readThemePreference() !== "system") return;
      applyTheme("system");
      window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    };
    applyTheme(readThemePreference());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      applyTheme(readThemePreference());
      window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    };
    media.addEventListener("change", applySystem);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", applySystem);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}

export function ThemeToggle() {
  const [label, setLabel] = useState(t("settings.themeToggle"));

  useLayoutEffect(() => {
    const sync = () => setLabel(currentThemeLabel());
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return (
    <button
      type="button"
      className="btn btn-sm theme-toggle"
      aria-label={label}
      onClick={() => commitTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")}
    >
      <SunIcon />
      <MoonIcon />
    </button>
  );
}

export function ThemePreference() {
  const [pref, setPref] = useState<ThemePreference | null>(null);

  useLayoutEffect(() => {
    const sync = () => setPref(readThemePreference());
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{t("settings.appearance")}</h2>
          <span className="muted small">{t("settings.appearanceLead")}</span>
        </div>
      </div>
      <fieldset className="theme-choices">
        <legend className="sr-only">{t("settings.themeLegend")}</legend>
        {OPTIONS.map((option) => (
          <label key={option.id} className="theme-choice">
            <input
              type="radio"
              name="swarm-theme"
              value={option.id}
              checked={pref === option.id}
              onChange={() => commitTheme(option.id)}
            />
            {t(option.label)}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function SunIcon() {
  return (
    <svg className="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 14.6A7.8 7.8 0 0 1 9.4 4 6.6 6.6 0 1 0 20 14.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
