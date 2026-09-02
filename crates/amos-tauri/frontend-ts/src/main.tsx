import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Optional bridge to the legacy shared store when running inside the Tauri shell
// (window.Amos) so the theme/locale persist across windows. Pure-browser/dev works
// standalone via localStorage.
declare global {
  interface Window {
    Amos?: {
      safeGet?(k: string, d: string): string;
      storeWrite?(k: string, v: string): void;
      applyTheme?(): void;
    };
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
