// Security — how secrets are handled in provisioned files and exports.
import { TRow, Soon } from "../primitives";

export default function SecurityPage() {
  return (
    <>
      <div className="sec">
        <div className="slab">Secrets in provisioned files</div>
        <Soon>Secret masking and export policies aren't stored yet. Provisioned key values are written to the worktree as configured.</Soon>
        <div className="soonwrap">
          <TRow title="Mask values that look like secrets" hint="Tokens and keys render as •••• in previews and logs." on disabled />
          <TRow title="Keep secrets out of exports" hint="Export the key names but not their values." on disabled />
        </div>
      </div>
      <div className="sec">
        <div className="slab">Git credentials</div>
        <div className="soonwrap fgrid">
          <span className="lb">SSH key</span><input className="inp mono" disabled placeholder="~/.ssh/id_ed25519" />
        </div>
      </div>
    </>
  );
}
