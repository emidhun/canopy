import React, { useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import Popover from "./popover/Popover";
import { initSync, useStore } from "./store";
import { hasBackend } from "./ipc";
import { applyPlatformClass } from "./platform";
import "./styles/tokens.css";
import "./styles/popover.css";

applyPlatformClass();

const GUTTER_X = 0; // window hugs the card (no shadow gutter)
const GUTTER_Y = 0;

function PopoverRoot() {
  const ref = useRef<HTMLDivElement>(null);
  const tree = useStore((s) => s.tree);

  useEffect(() => initSync(), []);

  // Fit the window to the content, capped at the available screen height
  // (menu bar → dock; screen.availHeight already excludes both). When the list
  // is taller than that, the window stops growing and .wm-groups scrolls inside.
  useEffect(() => {
    if (!hasBackend() || !ref.current) return;
    const el = ref.current;
    let raf = 0;
    const measure = async () => {
      const pop = el.querySelector(".wm-pop") as HTMLElement | null;
      const groups = el.querySelector(".wm-groups") as HTMLElement | null;
      // full content height even when the list is clamped + scrolling
      const base = pop ? pop.clientHeight : el.offsetHeight;
      const overflow = groups ? Math.max(0, groups.scrollHeight - groups.clientHeight) : 0;
      const natural = Math.ceil(base + overflow) + GUTTER_Y;
      // window top sits ~6px below the menu bar; leave a small margin off the dock
      const maxH = Math.max(260, window.screen.availHeight - 14);
      const h = Math.min(natural, maxH);
      const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
      getCurrentWindow()
        .setSize(new LogicalSize(284 + GUTTER_X, h))
        .catch(() => {});
    };
    // measure after layout settles, and again once more to converge if clamped
    raf = requestAnimationFrame(() => {
      measure();
      raf = requestAnimationFrame(measure);
    });
    return () => cancelAnimationFrame(raf);
  }, [tree]);

  return (
    <div className="pop-gutter">
      <div ref={ref}>
        <Popover />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PopoverRoot />
  </React.StrictMode>,
);
