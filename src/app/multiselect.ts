/* Ephemeral multi-selection of worktrees for bulk actions (delete).

   In-memory only: a selection is a transient intent, not a preference, so it
   isn't persisted and resets on reload. Modeled on the pins.ts external-store
   pattern so components subscribe via useSyncExternalStore. */
import { useSyncExternalStore } from "react";

let selected = new Set<string>();
// the last plainly-touched row — the fixed end of a Shift-click range
let anchor: string | null = null;
const listeners = new Set<() => void>();
let snapshot: readonly string[] = Object.freeze([]);

function commit() {
  snapshot = Object.freeze([...selected]);
  listeners.forEach((l) => l());
}

export function isSelected(wtKey: string): boolean {
  return selected.has(wtKey);
}

/** ⌘/Ctrl-click: add or remove one worktree, and make it the range anchor. */
export function toggle(wtKey: string) {
  if (selected.has(wtKey)) selected.delete(wtKey);
  else selected.add(wtKey);
  anchor = wtKey;
  commit();
}

/** Shift-click: add the inclusive range between the anchor and `wtKey` in the
    given visible order. With no anchor yet, behaves like a toggle. */
export function selectRange(order: string[], wtKey: string) {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(wtKey);
  if (a === -1 || b === -1) {
    toggle(wtKey);
    return;
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) selected.add(order[i]);
  commit();
}

/** Remember a row as the anchor without changing the selection (plain click). */
export function setAnchor(wtKey: string) {
  anchor = wtKey;
}

export function clear() {
  if (selected.size === 0 && anchor === null) return;
  selected = new Set();
  anchor = null;
  commit();
}

/** Drop keys that no longer exist (after a tree change / removal). */
export function retain(validKeys: Iterable<string>) {
  const valid = new Set(validKeys);
  let changed = false;
  for (const k of selected) {
    if (!valid.has(k)) {
      selected.delete(k);
      changed = true;
    }
  }
  if (changed) commit();
}

/** Subscribe to the selection. Returns the selected wtKeys. */
export function useMultiSelect(): readonly string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}
