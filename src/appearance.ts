// Appearance settings — theme + density + accent (the "Appearance" section of
// Settings).
//
// Persisted in localStorage, which every Canopy window shares (they're all the
// same origin), and applied as root data-attributes that tokens.css keys off.
// Appearance applies LIVE and instantly — it never goes through the Settings
// save step. A `storage` event re-applies it in the app's other windows, and a
// `prefers-color-scheme` listener re-resolves "system" when the OS flips.
//
// The updater / crash-report toggles (#78) stay coming-soon — they need a
// backend.
export type Theme = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";
export type Accent = "teal" | "green" | "amber" | "violet";

export interface Appearance {
  theme: Theme;
  density: Density;
  accent: Accent;
}

const KEY = "canopy.appearance";
const THEMES: Theme[] = ["dark", "light", "system"];
const ACCENTS: Accent[] = ["teal", "green", "amber", "violet"];

export function getAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Appearance>;
      return {
        theme: THEMES.includes(p.theme as Theme) ? (p.theme as Theme) : "dark",
        density: p.density === "compact" ? "compact" : "comfortable",
        accent: ACCENTS.includes(p.accent as Accent) ? (p.accent as Accent) : "teal",
      };
    }
  } catch {
    /* corrupt or unavailable storage — fall through to defaults */
  }
  return { theme: "dark", density: "comfortable", accent: "teal" };
}

/** "system" resolves to the OS scheme; everything else is literal. */
function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

export function applyAppearance(a: Appearance = getAppearance()): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(a.theme);
  root.dataset.density = a.density;
  root.dataset.accent = a.accent;
}

/** Persist + apply live, and notify this window's UI and the app's others. */
export function setAppearance(patch: Partial<Appearance>): Appearance {
  const next = { ...getAppearance(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — still apply for this session */
  }
  applyAppearance(next);
  window.dispatchEvent(new CustomEvent("canopy:appearance", { detail: next }));
  return next;
}

/** Apply on startup and keep in sync with other windows + the OS scheme. */
export function initAppearance(): void {
  applyAppearance();
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) applyAppearance();
  });
  // re-resolve "system" when the OS theme flips (a no-op for explicit themes)
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => applyAppearance());
}
