// Appearance settings — density + accent (the "Appearance" section of Settings).
//
// Persisted in localStorage, which every Canopy window shares (they're all the
// same origin), and applied as root data-attributes that tokens.css keys off.
// Appearance applies LIVE and instantly — it never goes through the Settings
// save step, and a `storage` event re-applies it in the app's other windows.
//
// Theme (light) and the updater / crash-report toggles stay coming-soon: a
// light theme is a real design exercise the token layer doesn't carry yet, and
// updates / crash reports need a backend.
export type Density = "comfortable" | "compact";
export type Accent = "teal" | "green" | "amber" | "violet";

export interface Appearance {
  density: Density;
  accent: Accent;
}

const KEY = "canopy.appearance";
const ACCENTS: Accent[] = ["teal", "green", "amber", "violet"];

export function getAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Appearance>;
      return {
        density: p.density === "compact" ? "compact" : "comfortable",
        accent: ACCENTS.includes(p.accent as Accent) ? (p.accent as Accent) : "teal",
      };
    }
  } catch {
    /* corrupt or unavailable storage — fall through to defaults */
  }
  return { density: "comfortable", accent: "teal" };
}

export function applyAppearance(a: Appearance = getAppearance()): void {
  const root = document.documentElement;
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

/** Apply on startup and keep in sync when another window changes it. */
export function initAppearance(): void {
  applyAppearance();
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) applyAppearance();
  });
}
