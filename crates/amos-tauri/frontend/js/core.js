// Amos System UI — core: app registry + router + home screen.
// Provides a tiny DOM helper and a shell for app screens.

window.Amos = (() => {
  const apps = new Map(); // id -> app definition
  let current = null;     // { app, node } or null when on home
  let viewEl = null;
  let jiggling = false;

  const LAYOUT_KEY = "amos.home.layout";
  let layout = null; // { page: [ids], dock: [ids], hidden: [ids] }

  function defaultLayout() {
    const dock = (window.AmosDock || []).filter((id) => apps.has(id));
    const page = Array.from(apps.keys()).filter((id) => !dock.includes(id));
    return { page, dock, hidden: [] };
  }

  function saveLayout() {
    storeWrite(LAYOUT_KEY, JSON.stringify(layout));
  }

  // Storage that never throws (some sandboxed/private contexts block it).
  function safeGet(key, dflt) {
    try { const v = localStorage.getItem(key); return v == null ? dflt : v; } catch (_) { return dflt; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, String(val)); return true; } catch (_) { return false; }
  }

  // Merge any apps not present in a saved layout (so newly registered apps appear).
  function loadLayout() {
    let l = defaultLayout();
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
      if (raw && Array.isArray(raw.page) && Array.isArray(raw.dock)) {
        l = { page: raw.page, dock: raw.dock, hidden: Array.isArray(raw.hidden) ? raw.hidden : [] };
      }
    } catch (_) {}
    const known = (id) => apps.has(id);
    l.page = l.page.filter(known);
    l.dock = l.dock.filter(known);
    l.hidden = l.hidden.filter(known);
    const placed = new Set([...l.page, ...l.dock, ...l.hidden]);
    for (const id of apps.keys()) if (!placed.has(id)) l.page.push(id);
    return l;
  }

  function locate(id) {
    for (const list of [layout.page, layout.dock]) {
      const i = list.indexOf(id);
      if (i >= 0) return { list, index: i };
    }
    return null;
  }

  // Move `draggedId` so it sits just before `targetId` (cross-list aware).
  function moveBefore(draggedId, targetId) {
    const d = locate(draggedId);
    if (!d) return;
    d.list.splice(d.index, 1); // remove dragged
    if (!locate(targetId)) { layout.page.push(draggedId); return; }
    const t = locate(targetId); // recompute after removal
    t.list.splice(t.index, 0, draggedId);
  }

  // ---- DOM helpers ----
  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    attrs = attrs || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else if (k === "html") n.innerHTML = v;
      else if (typeof v === "function") n.addEventListener(k.replace(/^on/, ""), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }

  // ---- App shell (title bar + home button + body) ----
  function appShell(title, contentNode) {
    const body = el("div", { class: "app-body" });
    body.appendChild(contentNode);
    return el("div", { class: "app-screen" }, [
      el("div", { class: "app-titlebar" }, [
        el("button", { class: "home-btn", title: "回到主屏幕", onclick: () => systemHome() }, "⌂"),
        el("span", { class: "title" }, title),
        el("span", { class: "right" }),
      ]),
      body,
    ]);
  }

  // ---- Icon tile ----
  function iconTile(app) {
    const g = app.gradient || ["#5b7cfa", "#3a4f9c"];
    return el("div", {
      class: "tile",
      style: { background: `linear-gradient(145deg, ${g[0]}, ${g[1]})` },
    }, app.icon);
  }

  // ---- Home icon (long-press jiggle, − badge, drag & drop) ----
  function makeIcon(app, inDock) {
    const btn = el("button", {
      class: "app-icon" + (jiggling ? " jiggling" : ""),
      draggable: jiggling ? "true" : "false",
      onclick: () => { if (!jiggling) openApp(app.id); },
    });

    // Long-press enters jiggle/edit mode (only when not already jiggling).
    if (!jiggling) {
      let timer = null;
      const start = () => { timer = setTimeout(enterJiggle, 500); };
      const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
      btn.addEventListener("pointerdown", start);
      btn.addEventListener("pointerup", clear);
      btn.addEventListener("pointerleave", clear);
    }

    btn.appendChild(iconTile(app));
    btn.appendChild(el("span", { class: "label" }, app.name));

    // − badge (iOS edit mode) — only visible while jiggling.
    if (jiggling) {
      btn.appendChild(el("button", {
        class: "remove-badge",
        onclick: (e) => { e.stopPropagation(); deleteApp(app.id, inDock); },
      }, "−"));
    }

    // Drag & drop reorder (meaningful only in jiggle mode).
    btn.addEventListener("dragstart", (e) => {
      if (!jiggling) { e.preventDefault(); return; }
      btn.classList.add("dragging");
      try { e.dataTransfer.setData("text/plain", app.id); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
    });
    btn.addEventListener("dragover", (e) => { if (jiggling) { e.preventDefault(); btn.classList.add("drop-target"); } });
    btn.addEventListener("dragleave", () => btn.classList.remove("drop-target"));
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      btn.classList.remove("drop-target");
      const id = e.dataTransfer && e.dataTransfer.getData("text/plain");
      if (id && id !== app.id) { moveBefore(id, app.id); saveLayout(); renderHome(); }
    });
    btn.addEventListener("dragend", () => btn.classList.remove("dragging"));

    return btn;
  }

  // ---- Home screen ----
  function renderHome() {
    if (!layout) {
      layout = loadLayout();
      saveLayout(); // establish the canonical layout on first render
    }

    const grid = el("div", { class: "app-grid" });
    for (const id of layout.page) grid.appendChild(makeIcon(apps.get(id), false));

    const dock = el("div", {
      class: "dock",
      dragover: (e) => { if (jiggling) { e.preventDefault(); dock.classList.add("drop-target"); } },
      dragleave: () => dock.classList.remove("drop-target"),
      drop: (e) => {
        e.preventDefault();
        dock.classList.remove("drop-target");
        const id = e.dataTransfer && e.dataTransfer.getData("text/plain");
        if (id && locate(id)) {
          locate(id).list.splice(locate(id).index, 1); // remove from wherever it is
          layout.dock.push(id);                        // append to dock
          saveLayout(); renderHome();
        }
      },
    });
    for (const id of layout.dock) dock.appendChild(makeIcon(apps.get(id), true));

    const scroll = el("div", {
      class: "home-scroll",
      onclick: () => { if (jiggling) exitJiggle(); },
    }, [grid, dock]);

    let done = null;
    if (jiggling) {
      done = el("button", { class: "done-btn", onclick: (e) => { e.stopPropagation(); exitJiggle(); } }, "完成");
    }

    viewEl.classList.add("home");
    viewEl.innerHTML = "";
    viewEl.appendChild(scroll);
    if (done) viewEl.appendChild(done);
  }

  // ---- Edit (jiggle) mode ----
  function enterJiggle() {
    if (jiggling || current) return;
    jiggling = true;
    renderHome();
  }

  function exitJiggle() {
    if (!jiggling) return;
    jiggling = false;
    renderHome();
  }

  // Remove from home: page icons get hidden; dock icons return to the page.
  function deleteApp(id, inDock) {
    if (!layout) return;
    if (inDock) {
      const d = locate(id);
      if (d) { d.list.splice(d.index, 1); layout.page.push(id); }
    } else {
      const d = locate(id);
      if (d) { d.list.splice(d.index, 1); layout.hidden.push(id); }
    }
    saveLayout();
    renderHome();
  }

  // ---- Router ----
  function navigate(id) {
    const app = apps.get(id);
    if (!app || (current && current.app.id === id)) return;
    if (current && current.app.onUnmount) current.app.onUnmount(current.node);

    viewEl.classList.remove("home");
    viewEl.innerHTML = "";
    const node = app.render();
    viewEl.appendChild(node);
    current = { app, node };
    if (app.onMount) app.onMount(node);
  }

  function goHome() {
    if (current && current.app.onUnmount) current.app.onUnmount(current.node);
    current = null;
    renderHome();
  }

  // ---- Shared (multi-window) store: settings/notifications sink to Rust ----
  // Writes stay synchronous in `localStorage` (snappy cache + headless test
  // fallback) and are *mirrored* to the Rust `SharedStore`, which broadcasts a
  // `store-updated` event to every window. `applyStoreUpdate` applies remote
  // changes locally so all windows converge on the same state.

  const storeHandlers = new Map(); // key -> Set<fn(value)>

  function storeWrite(key, value) {
    safeSet(key, value);
    const I = window.__TAURI_INTERNALS__;
    if (I) I.invoke("store_set", { key, value: String(value) }).catch(() => {});
  }

  function storeRemove(key) {
    try { localStorage.removeItem(key); } catch (_) {}
    const I = window.__TAURI_INTERNALS__;
    if (I) I.invoke("store_remove", { key }).catch(() => {});
  }

  function onStore(key, fn) {
    if (!storeHandlers.has(key)) storeHandlers.set(key, new Set());
    storeHandlers.get(key).add(fn);
    return () => { const s = storeHandlers.get(key); if (s) s.delete(fn); };
  }

  // Apply a `store-updated` change: refresh the local cache and notify handlers.
  function applyStoreUpdate(key, value) {
    if (value == null) { try { localStorage.removeItem(key); } catch (_) {} }
    else { try { localStorage.setItem(key, value); } catch (_) {} }
    const s = storeHandlers.get(key);
    if (s) s.forEach((fn) => { try { fn(value); } catch (_) {} });
  }

  // Subscribe this window to the Rust store's broadcast (call once at boot).
  function listenStore() {
    const I = window.__TAURI_INTERNALS__;
    if (!I || !I.listen) return;
    I.listen("store-updated", (e) => {
      const p = (e && e.payload) || {};
      if (!p.key) return;
      applyStoreUpdate(p.key, p.value == null ? null : String(p.value));
    }).catch(() => {});
  }

  // Hydrate the local cache from the Rust SharedStore at boot so a freshly
  // opened window reflects state written by other windows. Overwrites any stale
  // local copy (Rust is authoritative for store-managed keys).
  async function hydrateStore() {
    const I = window.__TAURI_INTERNALS__;
    if (!I) return;
    try {
      const snap = await I.invoke("store_snapshot");
      if (snap && typeof snap === "object") {
        for (const k of Object.keys(snap)) applyStoreUpdate(k, String(snap[k]));
      }
    } catch (_) { /* fall back to whatever is in the local cache */ }
  }

  // ---- Multi-window integration (真·OS 阶段) ----
  // In the real Tauri shell, opening an app / going home is delegated to the
  // Rust window manager (`amos-tauri/src/wm.rs`) which creates/focuses real OS
  // windows (creating the App window with a `#window=<id>` fragment). Outside
  // Tauri (dev / browser / tests) we fall back to the in-place SPA router so
  // the launcher keeps working headlessly.

  function openApp(id) {
    const I = window.__TAURI_INTERNALS__;
    if (I) {
      I.invoke("wm_open", { label: id }).catch((e) => {
        console.error("[Amos] wm_open failed, falling back to SPA:", e);
        navigate(id);
      });
      return;
    }
    navigate(id);
  }

  function systemHome() {
    const I = window.__TAURI_INTERNALS__;
    if (I) {
      I.invoke("wm_home").catch((e) => {
        console.error("[Amos] wm_home failed, falling back to SPA:", e);
        goHome();
      });
      return;
    }
    goHome();
  }

  // App windows are opened with a `#window=<id>` fragment; auto-navigate there.
  // Returns true when a URL-driven app was shown (so the caller skips home).
  function routeFromUrl() {
    const loc = typeof window !== "undefined" ? window.location : null;
    if (!loc || !loc.hash) return false;
    const m = /#window=([A-Za-z0-9_-]+)/.exec(loc.hash);
    if (m && apps.has(m[1])) { navigate(m[1]); return true; }
    return false;
  }

  // React to remote layout changes (e.g. "重置主屏布局" in the Settings window):
  // invalidate the in-memory layout cache so the next render reloads it from the
  // (reset) cache, then re-render when this window is on home.
  onStore(LAYOUT_KEY, () => {
    if (!current && viewEl) { layout = null; renderHome(); }
  });

  // ---- Public API ----
  return {
    el,
    appShell,
    register(app) { apps.set(app.id, app); },
    get apps() { return apps; },
    get jiggling() { return jiggling; },
    safeGet,
    safeSet,
    navigate,
    goHome,
    openApp,
    systemHome,
    routeFromUrl,
    storeWrite,
    storeRemove,
    onStore,
    applyStoreUpdate,
    listenStore,
    hydrateStore,
    renderHome,
    enterJiggle,
    exitJiggle,
    init(v) { viewEl = v; },
  };
})();
