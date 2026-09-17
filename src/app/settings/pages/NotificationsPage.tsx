// Notifications — what Canopy is allowed to interrupt you for.
import { TRow, Soon } from "../primitives";

export default function NotificationsPage() {
  return (
    <div className="sec">
      <div className="slab">Notify me when</div>
      <Soon>Notification preferences aren't stored yet. Canopy surfaces service crashes and blocked agents in the in-app attention queue regardless.</Soon>
      <div className="soonwrap">
        <TRow title="A service crashes" hint="The only notification on by default — it needs you." on disabled />
        <TRow title="An agent needs a decision" hint="An agent is blocked waiting on input." on disabled />
        <TRow title="Setup finishes" hint="Provisioning and setup tasks completed." on={false} disabled />
      </div>
    </div>
  );
}
