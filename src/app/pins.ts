/* Worktree pinning — what keeps the two or three worktrees you actually live
   in above a long tail of branches.

   TODO(#56): this is localStorage, which is per-webview. The popover window
   can't see these pins, they don't travel with the config file the way every
   other preference does, and nothing prunes entries for removed worktrees.
   When `pinned` lands on WorktreeNode (or Settings), this module collapses to
   an ipc call and the storage code goes away. */
import { useSyncExternalStore } from "react";

const KEY = "canopy.pinned";

let pins: Set<string> = load();
const listeners = new Set<() => void>();
/** useSyncExternalStore compares by identity, so hand out a stable snapshot
    and only replace it when the set actually changes. */
let snapshot: readonly string[] = Object.freeze([...pins]);

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function commit() {
  snapshot = Object.freeze([...pins]);
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* private mode / quota — pins stay in memory for this session */
  }
  listeners.forEach((l) => l());
}

export function isPinned(wtKey: string): boolean {
  return pins.has(wtKey);
}

export function togglePin(wtKey: string) {
  if (pins.has(wtKey)) pins.delete(wtKey);
  else pins.add(wtKey);
  commit();
}

/** Subscribe to the pin set. Returns the pinned wtKeys. */
export function usePins(): readonly string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}
