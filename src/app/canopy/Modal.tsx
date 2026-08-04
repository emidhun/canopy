/* The modal shell every dialog is built on.

   Every modal ends the same way: a ghost dismiss plus ONE primary that names
   its action — the same "next action" contract as the main window. If a
   button could sensibly say "OK", the dialog hasn't decided what it's for.

   The card floats, so it carries radius and shadow. Its interior is flat. */
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { Cube, X } from "../../icons";

export default function Modal({
  icon: Icon = Cube,
  danger,
  title,
  sub,
  wide,
  narrow,
  busy,
  onClose,
  children,
  foot,
}: {
  icon?: ComponentType<{ size?: number }>;
  danger?: boolean;
  title: string;
  sub?: string;
  wide?: boolean;
  narrow?: boolean;
  /** while busy the dialog refuses Escape and scrim-dismiss — a half-finished
      worktree create should not be dismissable by a stray click */
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // aria-modal="true" promises focus cannot leave the dialog. Without a trap
    // Tab walks straight into the app behind the scrim, so the promise was
    // false for assistive tech and keyboard users alike.
    const opener = document.activeElement as HTMLElement | null;
    const FOCUSABLE =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !card.current) return;
      const items = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !card.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap, true);

    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        // capture phase + stopPropagation: the app-level Escape handler would
        // otherwise also close the palette or attention queue behind us
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", k, true);
    const first = card.current?.querySelector<HTMLElement>("input,textarea,select,button.cx-btn--primary");
    const t = setTimeout(() => first?.focus(), 40);
    return () => {
      document.removeEventListener("keydown", k, true);
      document.removeEventListener("keydown", trap, true);
      clearTimeout(t);
      // hand focus back to whatever opened us, so the keyboard doesn't reset
      // to the top of the document
      opener?.focus?.();
    };
  }, [busy, onClose]);

  return (
    <div
      className="cx-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={"cx-modal" + (wide ? " cx-modal--wide" : "") + (narrow ? " cx-modal--narrow" : "")}
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="cx-modal__head">
          <span className={"cx-modal__ic" + (danger ? " cx-modal__ic--danger" : "")}>
            <Icon size={14} />
          </span>
          <span className="cx-modal__title">
            <b>{title}</b>
            {sub && <span>{sub}</span>}
          </span>
          <button className="cx-ib" onClick={onClose} disabled={busy} title="Close">
            <X size={13} />
          </button>
        </div>
        <div className="cx-modal__body">{children}</div>
        {foot && <div className="cx-modal__foot">{foot}</div>}
      </div>
    </div>
  );
}

/** The footer's supporting line — always the elastic item, so the actions
    beside it never shrink or wrap. */
export function Hint({ icon: Icon, children, tone }: { icon?: ComponentType<{ size?: number }>; children: ReactNode; tone?: "warn" }) {
  return (
    <span className="cx-modal__hint" style={tone === "warn" ? { color: "var(--state-attention)" } : undefined}>
      {Icon && <Icon size={11} />}
      <span>{children}</span>
    </span>
  );
}

export const Spacer = () => <span className="cxs-spacer" />;
