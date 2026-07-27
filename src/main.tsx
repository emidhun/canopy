import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { applyPlatformClass } from "./platform";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/terminal.css";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
