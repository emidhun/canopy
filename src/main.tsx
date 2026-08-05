import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { applyPlatformClass } from "./platform";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/terminal.css";
// The redesigned shell loads last so its rules win where a class name is
// shared with the older screens (Settings, the modals, onboarding) that
// app.css still owns.
import "./styles/canopy-components.css";
import "./styles/canopy-shell.css";
import "./styles/canopy-modals.css";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
