export const THEME_STORAGE_KEY = "swarm-theme";
export const THEME_CHANGE_EVENT = "swarm-theme";

export type ThemePreference = "light" | "dark" | "system";
export type Theme = "light" | "dark";

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === "light" || preference === "dark") return preference;
  return systemDark ? "dark" : "light";
}

/** До первой отрисовки: та же логика, что resolveTheme. Без скрипта страница остаётся светлой. */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");if(p!=="light"&&p!=="dark")p="system";var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var t=d?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.dataset.themePref=p;}catch(e){}})();`;

export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Приватный режим может запретить хранилище: тема всё равно применится на этот визит.
  }
}

export function applyTheme(preference: ThemePreference): Theme {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = resolveTheme(preference, systemDark);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePref = preference;
  root.style.colorScheme = theme;
  return theme;
}

export function commitTheme(preference: ThemePreference): Theme {
  writeThemePreference(preference);
  const theme = applyTheme(preference);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  return theme;
}
