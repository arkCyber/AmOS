// Amos System UI — boot script.
// Initialises the launcher, drives the status-bar clock, and wires the global
// AI stream events (from the Tauri Rust core) into the AI app.

const I = window.__TAURI_INTERNALS__;

// Global error boundary: keep the OS UI alive and surface failures to the log.
window.addEventListener("error", (e) => {
  console.error("[Amos] uncaught error:", e.message, e.filename, e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[Amos] unhandled rejection:", e.reason);
});

// Which apps live in the dock (must be registered before first render).
window.AmosDock = ["phone", "messages", "camera", "settings", "ai"];

function tickClock() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const el = document.querySelector(".sb-time");
  if (el) el.textContent = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const bat = document.querySelector(".sb-battery");
  if (bat) bat.textContent = `${100 - now.getSeconds()}%`;
}

async function init() {
  // Clock.
  tickClock();
  setInterval(tickClock, 1000);

  // Router + first render. App windows are opened with a `#window=<id>`
  // fragment and auto-navigate to that app; the launcher renders home. Hydrate
  // the shared store first so this window reflects state written by others.
  window.Amos.init(document.getElementById("view"));
  await window.Amos.hydrateStore();
  if (!window.Amos.routeFromUrl()) {
    window.Amos.renderHome();
  }

  // Home indicator → return to home (delegates to the window manager in Tauri).
  document.getElementById("home-indicator").addEventListener("click", () => window.Amos.systemHome());

  // Subscribe to the Rust shared store so settings/notifications sync across windows.
  window.Amos.listenStore();

  // --- Global AI stream listeners (forward to the AI app if mounted) ---
  if (I) {
    await I.listen("ai-token-received", (e) => {
      if (window.AmosAi && window.AmosAi.mounted) window.AmosAi.pushToken(e.payload);
    });
    await I.listen("ai-chat-complete", () => {
      if (window.AmosAi) window.AmosAi.chatComplete();
    });
    await I.listen("ai-session-complete", (e) => {
      if (window.AmosAi) window.AmosAi.sessionComplete(e.payload);
    });
  }
}

init().catch((e) => console.error("Amos boot failed", e));
