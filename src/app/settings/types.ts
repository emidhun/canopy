// The prop bundle every Settings page receives. The shell owns all of this
// state; a page reads what it needs and calls back to change it.
import { type RepoCfg, type Settings } from "../../ipc";
import { type FileCardT } from "./provision";
import { type PageId } from "./catalog";
import type { IncompleteRow } from "./incomplete";

export type PageProps = {
  repo: RepoCfg | null;
  patchRepo: (p: Partial<RepoCfg>) => void;
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  markDirty: (id: PageId) => void;
  flash: (m: string) => void;
  cards: FileCardT[];
  setCards: (c: FileCardT[]) => void;
  setup: string[];
  setSetup: (s: string[]) => void;
  onRemoveRepo: () => void;
  onExportJson: () => void;
  onImportJson: () => void;
  onCopyJson: () => void;
  selKey: string | null;
  /** rows the save step refused, keyed by rowKey() — the editors mark these (#43) */
  invalid: ReadonlyMap<string, IncompleteRow>;
};
