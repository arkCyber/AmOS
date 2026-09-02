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
window.AmosDock = ["phone", "messages", "camera", "settings", "ai", "interpreter"];

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

  // Home indicator: tap → home, swipe up → app switcher (Recents).
  const homeInd = document.getElementById("home-indicator");
  if (homeInd) {
    let homeY = null;
    homeInd.addEventListener("pointerdown", (e) => { homeY = e.clientY || 0; });
    homeInd.addEventListener("pointerup", (e) => {
      const dy = (e.clientY || 0) - (homeY || 0);
      homeY = null;
      if (dy < -24) window.Amos.showRecents();
      else window.Amos.systemHome();
    });
  }

  // Subscribe to the Rust shared store so settings/notifications sync across windows.
  window.Amos.listenStore();

  // First boot → onboarding; otherwise boot straight into the lock screen.
  if (!window.Amos.safeGet("amos.onboarded")) {
    window.Amos.showOnboarding();
  } else {
    window.Amos.showLock();
  }

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
    await I.listen("ai-card-received", (e) => {
      if (window.AmosAi) window.AmosAi.showCard(e.payload);
    });
    // Hardware buttons emitted by the Rust core (Home / Voice / AI).
    await I.listen("hardware-button", (e) => {
      if (window.AmosButtons) window.AmosButtons.handle(e.payload);
    });
    // Interpretation session outputs (同声传译).
    await I.listen("interpret-output", (e) => {
      if (window.AmosInterp) window.AmosInterp.onOutput(e.payload);
    });
  }

  // Desktop dev convenience: keyboard shortcuts for the three hardware buttons.
  if (window.AmosButtons) {
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "h") window.AmosButtons.press("home");
      else if (k === "v") window.AmosButtons.press("voice");
      else if (k === "a") window.AmosButtons.press("ai");
    });
  }
}

init().catch((e) => console.error("Amos boot failed", e));
