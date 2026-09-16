// #43 — which Settings rows cannot be saved, and how to say so.
//
// A service, custom command or agent row that is missing a required field
// cannot be persisted. It used to be filtered out during save with no warning,
// which reads as data loss. Instead: find those rows, block the save, name the
// first one, and hand back keys the editors use to mark them.
//
// An entirely untouched row is the exception — "+ Add" drops one into the
// editor, and blocking on it would make the button unusable — so it is still
// dropped quietly. It carries nothing to lose.
import type { RepoCfg } from "../../ipc";
import type { PageId } from "./catalog";

export type RowKind = "service" | "command" | "agent";

export type IncompleteRow = {
  kind: RowKind;
  page: PageId;
  /** kind + index: a blank id still addresses the right row */
  key: string;
  label: string;
  /** phrased for a sentence: "needs an id and a command" */
  missing: string[];
};

export const rowKey = (kind: RowKind, index: number) => `${kind}:${index}`;

const PAGE: Record<RowKind, PageId> = { service: "services", command: "commands", agent: "agents" };
const SECTION: Record<RowKind, string> = { service: "Services", command: "Commands", agent: "Agents" };
const NOUN: Record<RowKind, string> = { service: "service", command: "command", agent: "agent" };

const blank = (s: string | undefined) => !s?.trim();

/** the fields the user types into — an all-blank row is an untouched one */
type Spec = { label: string; value: string | undefined; required?: string };

function rowsOf(r: RepoCfg): { kind: RowKind; index: number; fields: Spec[]; label: string }[] {
  return [
    ...r.services.map((s, index) => ({
      kind: "service" as const, index,
      fields: [
        { label: "id", value: s.id, required: "an id" },
        { label: "name", value: s.name },
        { label: "command", value: s.command, required: "a command" },
      ],
      label: s.name?.trim() || s.id?.trim() || "Untitled service",
    })),
    ...(r.customCommands || []).map((c, index) => ({
      kind: "command" as const, index,
      fields: [
        { label: "label", value: c.label, required: "a label" },
        { label: "command", value: c.command, required: "a command" },
      ],
      label: c.label?.trim() || "Untitled command",
    })),
    ...(r.agents || []).map((a, index) => ({
      kind: "agent" as const, index,
      // the id is generated, never typed — it does not count as "touched"
      fields: [
        { label: "name", value: a.name, required: "a name" },
        { label: "command", value: a.command, required: "a command" },
      ],
      label: a.name?.trim() || "Untitled agent",
    })),
  ];
}

export function incompleteRows(r: RepoCfg): IncompleteRow[] {
  const out: IncompleteRow[] = [];
  for (const row of rowsOf(r)) {
    if (row.fields.every((f) => blank(f.value))) continue; // untouched
    const missing = row.fields.filter((f) => f.required && blank(f.value)).map((f) => f.required as string);
    if (!missing.length) continue;
    out.push({ kind: row.kind, page: PAGE[row.kind], key: rowKey(row.kind, row.index), label: row.label, missing });
  }
  return out;
}

const listOf = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function describeIncomplete(rows: IncompleteRow[]): string {
  if (!rows.length) return "";
  if (rows.length === 1) {
    const r = rows[0];
    return `Nothing saved — the ${NOUN[r.kind]} "${r.label}" needs ${listOf(r.missing)}.`;
  }
  const sections = [...new Set(rows.map((r) => SECTION[r.kind]))];
  return `Nothing saved — ${rows.length} incomplete rows in ${listOf(sections)}.`;
}

/** the note shown on the row itself: "needs an id and a command" */
export const missingText = (r: IncompleteRow) => `needs ${listOf(r.missing)}`;
