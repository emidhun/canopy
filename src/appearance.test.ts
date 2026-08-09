import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppearance, getAppearance, setAppearance, type Appearance } from "./appearance";

const KEY = "canopy.appearance";
const DEFAULTS: Appearance = { theme: "dark", density: "comfortable", accent: "teal" };

beforeEach(() => {
  localStorage.clear();
  const r = document.documentElement;
  delete r.dataset.theme;
  delete r.dataset.density;
  delete r.dataset.accent;
});

describe("getAppearance", () => {
  it("defaults to dark / comfortable / teal with nothing stored", () => {
    expect(getAppearance()).toEqual(DEFAULTS);
  });

  it("reads a fully valid stored appearance", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "light", density: "compact", accent: "violet" }));
    expect(getAppearance()).toEqual({ theme: "light", density: "compact", accent: "violet" });
  });

  it("quarantines out-of-enum values field-by-field back to defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "neon", density: "roomy", accent: "chartreuse" }));
    expect(getAppearance()).toEqual(DEFAULTS);
  });

  it("keeps the valid fields when only some are bad", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "light", density: "roomy", accent: "green" }));
    expect(getAppearance()).toEqual({ theme: "light", density: "comfortable", accent: "green" });
  });

  it("survives corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getAppearance()).toEqual(DEFAULTS);
  });
});

describe("applyAppearance", () => {
  it("writes the theme/density/accent data-attributes tokens.css keys off", () => {
    applyAppearance({ theme: "light", density: "compact", accent: "amber" });
    const r = document.documentElement;
    expect(r.dataset.theme).toBe("light");
    expect(r.dataset.density).toBe("compact");
    expect(r.dataset.accent).toBe("amber");
  });

  it('resolves "system" against prefers-color-scheme: light', () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("light"), media: q, addEventListener() {}, removeEventListener() {} }));
    applyAppearance({ theme: "system", density: "comfortable", accent: "teal" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it('resolves "system" to dark when the OS is not light', () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    applyAppearance({ theme: "system", density: "comfortable", accent: "teal" });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("setAppearance", () => {
  it("merges a patch over the current value and persists the whole thing", () => {
    const next = setAppearance({ accent: "green" });
    expect(next).toEqual({ ...DEFAULTS, accent: "green" });
    expect(getAppearance()).toEqual({ ...DEFAULTS, accent: "green" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ ...DEFAULTS, accent: "green" });
  });

  it("applies live and notifies via the canopy:appearance event", () => {
    const seen: Appearance[] = [];
    const onEvt = (e: Event) => seen.push((e as CustomEvent<Appearance>).detail);
    window.addEventListener("canopy:appearance", onEvt);
    const next = setAppearance({ density: "compact" });
    window.removeEventListener("canopy:appearance", onEvt);
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(seen).toEqual([next]);
  });

  it("builds on the previously stored value, not the defaults", () => {
    setAppearance({ theme: "light" });
    setAppearance({ accent: "amber" });
    expect(getAppearance()).toEqual({ theme: "light", density: "comfortable", accent: "amber" });
  });
});
