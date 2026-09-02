// Amos System UI — core: app registry + router + home screen.
// Provides a tiny DOM helper and a shell for app screens.

window.Amos = (() => {
  const apps = new Map(); // id -> app definition
  let current = null;     // { app, node } or null when on home
  let viewEl = null;
  let jiggling = false;

  // ---- Mobile-OS shell state ----
  let locked = false;         // lock screen active (blocks app access)
  let lockTimer = null;       // live clock interval on the lock screen
  let brightnessOverlay = null; // full-screen dim layer
  let recents = loadRecents();  // most-recently-opened app ids

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
  // Curated, muted "refined" palette (avoid loud saturated greens/reds). Used
  // for every home/dock icon so the launcher reads as elegant and consistent.
  const ICON_GRADIENTS = {
    phone: ["#a4b0c4", "#6d7b91"],
    messages: ["#86b3a5", "#51796b"],
    camera: ["#9aa8b5", "#5f6d7b"],
    photos: ["#c7b6d9", "#846f9c"],
    settings: ["#a6adb6", "#6d747d"],
    calculator: ["#adb0c3", "#6d7085"],
    weather: ["#95c2d4", "#4f7d96"],
    music: ["#d9b892", "#9b7040"],
    clock: ["#99a5c9", "#606c92"],
    maps: ["#a7c19c", "#6c8a65"],
    files: ["#c8b7a1", "#8d7558"],
    notes: ["#d6c792", "#a18a44"],
    android: ["#91a0b8", "#5e6c83"],
    ai: ["#93a0db", "#56639f"],
    interpreter: ["#7d98ca", "#4b6596"],
  };
  const DEFAULT_GRADIENT = ["#8d96a6", "#5c6470"];
  function iconTile(app) {
    const g = ICON_GRADIENTS[app.id] || app.gradient || DEFAULT_GRADIENT;
    return el("div", {
      class: "tile",
      style: { background: `linear-gradient(145deg, ${g[0]}, ${g[1]})` },
    }, app.icon);
  }

  // Unread count for an app icon from the shared notification store. Notifications
  // carry the display name (`n.app`) which matches `app.name`.
  function notifCountFor(id) {
    const name = apps.has(id) ? apps.get(id).name : "";
    if (!name) return 0;
    try {
      const list = JSON.parse(safeGet("amos.notifications", "[]"));
      if (!Array.isArray(list)) return 0;
      return list.filter((n) => n && n.app === name).length;
    } catch (_) { return 0; }
  }

  // ---- Home icon (long-press jiggle, − badge, drag & drop) ----
  function makeIcon(app, inDock) {
    const btn = el("button", {
      class: "app-icon" + (jiggling ? " jiggling" : ""),
      draggable: jiggling ? "true" : "false",
      // Accessible name: dock labels are visually hidden (display:none), so the
      // button itself must carry the app name for assistive tech / tooltips.
      "aria-label": app.name,
      title: app.name,
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

    // Unread-notification badge (Apple-style red dot) when this app has unseen
    // notifications. Removed when the app is opened (see openApp).
    const n = notifCountFor(app.id);
    if (n > 0) btn.appendChild(el("span", { class: "app-badge" }, n > 99 ? "99+" : String(n)));

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
    // Fixed Spotlight trigger (not an app, not movable / removable). Stays at the
    // end of the dock so it never displaces the draggable app icons above.
    dock.appendChild(el("button", {
      class: "dock-search",
      "aria-label": "搜索",
      title: "搜索",
      onclick: () => { if (jiggling) exitJiggle(); showSearch(); },
    }, "🔍"));

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
    hideSearch(); // returning home should dismiss the Spotlight overlay too
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
    if (locked) return;
    hideSearch(); // launching an app always dismisses any open Spotlight overlay
    // Opening an app marks its notifications as read (iOS behaviour).
    const appName = apps.has(id) ? apps.get(id).name : "";
    try {
      const list = JSON.parse(safeGet("amos.notifications", "[]"));
      if (Array.isArray(list) && appName && list.some((x) => x && x.app === appName)) {
        storeWrite("amos.notifications", JSON.stringify(list.filter((x) => x && x.app !== appName)));
      }
    } catch (_) {}
    pushRecent(id);
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

  // -----------------------------------------------------------------------
  // Mobile-OS shell: lock screen, recents (app switcher), theme & brightness
  // -----------------------------------------------------------------------

  // ---- small helpers ----
  function loadRecents() {
    try { const r = JSON.parse(safeGet("amos.recents", "[]")); return Array.isArray(r) ? r : []; } catch (_) { return []; }
  }
  function readSettings() {
    try { return JSON.parse(safeGet("amos.settings", "{}")) || {}; } catch (_) { return {}; }
  }
  function readLockConfig() {
    try { return JSON.parse(safeGet("amos.lock", "{}")) || {}; } catch (_) { return {}; }
  }
  function previewNotifs() {
    try { const n = JSON.parse(safeGet("amos.notifications", "[]")); return Array.isArray(n) ? n.slice(0, 3) : []; } catch (_) { return []; }
  }
  function fmtClock(d) { const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; }
  function fmtDate(d) { const W = ["日", "一", "二", "三", "四", "五", "六"]; return `${d.getMonth() + 1}月${d.getDate()}日 周${W[d.getDay()]}`; }

  // ---- Lock screen ----
  function renderLock() {
    const cfg = readLockConfig();
    const now = new Date();
    const lock = el("div", { class: "lock-screen" });
    lock.appendChild(el("div", { class: "lock-clock", id: "lock-clock" }, fmtClock(now)));
    lock.appendChild(el("div", { class: "lock-date", id: "lock-date" }, fmtDate(now)));

    const notifs = previewNotifs();
    if (notifs.length) {
      lock.appendChild(el("div", { class: "lock-hint" }, "通知"));
      notifs.forEach((n) => lock.appendChild(el("div", { class: "card lock-notif" }, [
        el("div", { class: "row" }, [el("span", { style: { fontSize: "20px" } }, n.icon || "🔔"), el("span", { style: { fontWeight: "600" } }, n.title || n.app || "通知")]),
        el("div", { class: "muted", style: { marginTop: "2px" } }, n.body || ""),
      ])));
    }

    lock.appendChild(el("div", { class: "lock-hint" }, "滑动或点击解锁"));

    if (cfg.enabled && cfg.pin) {
      lock.appendChild(pinPad(cfg.pin));
    } else {
      lock.appendChild(el("button", { class: "btn unlock-btn", onclick: () => hideLock() }, "🔓 解锁"));
    }

    // Swipe-up anywhere to unlock (PIN-less mode only).
    let startY = null;
    lock.addEventListener("pointerdown", (e) => { startY = e.clientY || 0; });
    lock.addEventListener("pointerup", (e) => {
      if (!cfg.enabled && startY != null && ((e.clientY || 0) - startY) < -40) hideLock();
      startY = null;
    });

    viewEl.classList.remove("home");
    viewEl.innerHTML = "";
    viewEl.appendChild(lock);
  }

  // Numeric PIN pad used by the lock screen when a lock PIN is configured.
  function pinPad(pin) {
    const disp = el("div", { class: "pin-display", id: "lock-pin-display" }, "····");
    const pad = el("div", { class: "pin-pad" });
    const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];
    const build = (k) => el("button", {
      class: "pin-key",
      onclick: () => {
        if (k === "⌫") {
          disp.textContent = disp.textContent.length > 1 && disp.textContent !== "✗" && disp.textContent !== "····"
            ? disp.textContent.slice(0, -1)
            : "····";
        } else if (k === "✓") {
          if (disp.textContent === pin) hideLock();
          else { disp.textContent = "✗"; setTimeout(() => { disp.textContent = "····"; }, 600); }
        } else {
          disp.textContent = (disp.textContent === "····" || disp.textContent === "✗")
            ? k
            : disp.textContent + k;
        }
      },
    }, k);
    KEYS.forEach((k) => pad.appendChild(build(k)));
    return el("div", { class: "lock-pin" }, [disp, pad]);
  }

  function startLockClock() {
    if (lockTimer) clearInterval(lockTimer);
    lockTimer = setInterval(() => {
      const c = document.getElementById && document.getElementById("lock-clock");
      const d = document.getElementById && document.getElementById("lock-date");
      if (c) c.textContent = fmtClock(new Date());
      if (d) d.textContent = fmtDate(new Date());
    }, 1000);
  }

  function showLock() {
    locked = true;
    renderLock();
    startLockClock();
  }

  function hideLock() {
    if (!locked) return;
    landHome();
  }

  // Go straight to the home launcher unlocked (used to skip past the lock /
  // onboarding wall so a demo lands on a usable home screen).
  function landHome() {
    locked = false;
    if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
    renderHome();
  }

  // ---- Recents / app switcher ----
  function pushRecent(id) {
    recents = [id, ...recents.filter((r) => r !== id)].slice(0, 8);
    safeSet("amos.recents", JSON.stringify(recents));
  }

  function showRecents() {
    if (locked) return;
    viewEl.classList.remove("home");
    viewEl.innerHTML = "";
    const list = recents.length ? recents : Array.from(apps.keys()).slice(0, 4);
    const row = el("div", { class: "recents-row" });
    list.forEach((id) => {
      const app = apps.get(id);
      if (!app) return;
      row.appendChild(el("button", {
        class: "recents-card",
        onclick: () => openApp(id),
      }, [iconTile(app), el("span", { class: "label" }, app.name)]));
    });
    viewEl.appendChild(el("div", { class: "recents-screen" }, [
      el("div", { class: "recents-header" }, "最近使用"),
      row,
      el("button", { class: "btn secondary recents-close", onclick: () => hideRecents() }, "完成"),
    ]));
  }

  function hideRecents() { renderHome(); }

  // ---- Spotlight app search (dock 🔍, iPhone-style) ----
  // Tapping the dock search control opens a full-screen "Spotlight" sheet with a
  // search field + results and an on-screen keyboard. Matching is done on app
  // name / id plus aliases below (so pinyin like `shezhi` or English ids like
  // `camera` find the Chinese-named apps).
  const SEARCH_ALIASES = {
    settings: ["shezhi", "shèzhì", "sz"],
    phone: ["dianhua", "diànhuà", "dh", "call"],
    camera: ["xiangji", "xiàngjī", "xj"],
    photos: ["xiangce", "xiàngcè", "xc", "album", "相册"],
    calculator: ["jisuanqi", "jìsuànqì", "jsq", "calc"],
    weather: ["tianqi", "tiānqì", "tq"],
    clock: ["shizhong", "shízhōng", "naozhong", "闹钟"],
    files: ["wenjian", "wénjiàn", "wj", "file"],
    maps: ["ditu", "dìtú", "map"],
    messages: ["xinxi", "xìnxī", "sms", "message", "短信"],
    music: ["yinyue", "yīnyuè", "yy", "song"],
    notes: ["beiwanglu", "bèiwànglù", "bwl", "note", "memo"],
    ai: ["agent", "zhineng", "zhìnéng", "人工智能", "ai"],
    android: ["anzhuo", "ānzhuó", "android", "apk", "安卓"],
    interpreter: ["tongchuan", "tónɡchuán", "tc", "translate", "同传", "翻译"],
  };
  function searchApps(query) {
    const q = String(query == null ? "" : query).trim().toLowerCase();
    const out = [];
    for (const a of apps.values()) {
      const name = (a.name || "").toLowerCase();
      const id = a.id.toLowerCase();
      const keys = (SEARCH_ALIASES[a.id] || []).concat(Array.isArray(a.search) ? a.search : []);
      let rank = -1;
      if (!q) rank = 0;
      else if (name === q) rank = 1;
      else if (name.startsWith(q)) rank = 2;
      else if (id.startsWith(q)) rank = 3;
      else if (name.includes(q)) rank = 4;
      else if (id.includes(q)) rank = 5;
      else if (keys.some((k) => { const s = String(k).toLowerCase(); return s === q || s.startsWith(q) || s.includes(q); })) rank = 6;
      if (rank >= 0) out.push({ app: a, rank });
    }
    if (q) out.sort((x, y) => x.rank - y.rank);
    return out.map((o) => o.app);
  }

  // Spotlight overlay state (built once, then shown/hidden on demand).
  let spotRoot = null, spotInput = null, spotResults = null, spotLast = [];
  const KB_TOP = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  const KB_MID = ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"];
  const KB_HOME = ["a", "s", "d", "f", "g", "h", "j", "k", "l"];
  const KB_BOT = ["z", "x", "c", "v", "b", "n", "m"];

  function spotKeyRow(keys) {
    const row = el("div", { class: "spot-kb-row" });
    keys.forEach((k) => row.appendChild(el("button", {
      class: "spot-key", "aria-label": k, onclick: () => spotType(k),
    }, k)));
    return row;
  }
  function spotType(ch) {
    if (!spotInput) return;
    spotInput.value = String(spotInput.value) + ch;
    spotRefresh();
  }
  function spotBackspace() {
    if (!spotInput) return;
    spotInput.value = String(spotInput.value).slice(0, -1);
    spotRefresh();
  }
  function spotClear() {
    if (spotInput) { spotInput.value = ""; spotRefresh(); }
  }
  function spotRefresh() {
    if (!spotResults) return;
    const q = spotInput ? String(spotInput.value) : "";
    const list = searchApps(q);
    spotLast = list;
    spotResults.innerHTML = "";
    const shown = list.slice(0, 24);
    if (!shown.length) {
      spotResults.appendChild(el("div", { class: "spot-empty muted" }, `未找到「${q || "…"}」`));
      return;
    }
    shown.forEach((app) => {
      spotResults.appendChild(el("button", {
        class: "spot-row",
        onclick: () => { const id = app.id; hideSearch(); openApp(id); },
      }, [iconTile(app), el("span", { class: "spot-name" }, app.name), el("span", { class: "muted spot-open" }, "打开")]));
    });
  }
  function spotOpenFirst() {
    const first = spotLast && spotLast[0];
    if (first) { const id = first.id; hideSearch(); openApp(id); }
    else hideSearch();
  }
  function buildSpotlight() {
    const body = (typeof document !== "undefined" && document.body) ? document.body : null;
    if (!body) return null;
    const fieldRow = el("div", { class: "spot-field" }, [
      el("span", { class: "spot-mag" }, "🔍"),
      (spotInput = el("input", {
        class: "spot-input",
        placeholder: "搜索应用：设置 / camera / shezhi…",
        autocomplete: "off", spellcheck: "false",
        oninput: () => spotRefresh(),
        onkeydown: (e) => {
          if (e && e.key === "Enter") spotOpenFirst();
          else if (e && e.key === "Escape") hideSearch();
        },
      })),
      el("button", { class: "spot-clear", "aria-label": "清空", onclick: () => spotClear() }, "✕"),
    ]);
    spotResults = el("div", { class: "spot-results" });
    const kb = el("div", { class: "spot-kb" }, [
      spotKeyRow(KB_TOP), spotKeyRow(KB_MID), spotKeyRow(KB_HOME), spotKeyRow(KB_BOT),
      el("div", { class: "spot-kb-row spot-action" }, [
        el("button", { class: "spot-key wide", onclick: () => spotType(" ") }, "空格"),
        el("button", { class: "spot-key", onclick: () => spotBackspace() }, "⌫"),
        el("button", { class: "spot-key return", onclick: () => spotOpenFirst() }, "打开"),
      ]),
    ]);
    spotRoot = el("div", { class: "spotlight", onclick: (e) => { if (e && e.target === spotRoot) hideSearch(); } }, [
      el("div", { class: "spot-head" }, [
        el("span", { class: "spot-title" }, "搜索"),
        el("button", { class: "btn secondary spot-done", onclick: () => hideSearch() }, "完成"),
      ]),
      fieldRow,
      spotResults,
      kb,
    ]);
    body.appendChild(spotRoot);
    spotRefresh(); // default state: list every app
    return spotRoot;
  }
  function showSearch() {
    if (locked) return;
    const body = (typeof document !== "undefined" && document.body) ? document.body : null;
    if (!body) return;
    if (!spotRoot) buildSpotlight();
    if (spotRoot) spotRoot.style.display = "flex";
    spotClear();
    setTimeout(() => { try { if (spotInput) spotInput.focus(); } catch (_) {} }, 30);
  }
  function hideSearch() {
    if (spotRoot) spotRoot.style.display = "none";
  }

  // ---- Theme & brightness (make the Settings toggles actually do something) ----
  function updateBrightness(v) {
    const val = v != null ? Number(v) : 70;
    const body = (typeof document !== "undefined" && document.body) ? document.body : null;
    if (!body) return;
    if (!brightnessOverlay) {
      brightnessOverlay = el("div", { class: "brightness-overlay" });
      body.appendChild(brightnessOverlay);
    }
    brightnessOverlay.style.opacity = String((100 - val) / 100);
  }

  // ---- Background display methods (配置文件定义) ----
  // The wallpaper image is never painted as a raw, fully opaque photo. It is
  // rendered through one of several "display methods" (显示方式) that recede /
  // soften it. Default is `ghost` (若隐若现) so a busy scenic image stays
  // tasteful and never upstages the launcher icons. Each method maps to CSS
  // custom properties consumed by the wallpaper layers in styles.css:
  //   --wp-alpha   opacity of the image layer   (0..1)
  //   --wp-blur    gaussian blur radius         (px)
  //   --wp-sat     saturation factor            (0..2)
  //   --wp-bright  brightness factor            (0..2)
  // To add a method, push a new entry here — the first entry is the default.
  const BACKGROUND_MODES = [
    { id: "ghost", label: "若隐若现 · 朦胧",
      desc: "缺省 · 背景淡雅朦胧、若隐若现，不喧宾夺主",
      style: { alpha: 0.58, blur: 9, sat: 0.92, bright: 1.02 } },
    { id: "soft", label: "柔和 · 透亮",
      desc: "更亮更通透，带一层轻纱质感",
      style: { alpha: 0.8, blur: 3, sat: 1.0, bright: 1.05 } },
    { id: "muted", label: "素净 · 淡墨",
      desc: "极淡水墨感，几乎退为底色，适合低干扰",
      style: { alpha: 0.42, blur: 14, sat: 0.6, bright: 0.96 } },
    { id: "vivid", label: "明快 · 清晰",
      desc: "接近原图质感（默认不启用，以保持含蓄）",
      style: { alpha: 0.95, blur: 0, sat: 1.08, bright: 1.0 } },
  ];
  const BG_DEFAULT = "ghost";
  function bgStyle(id) {
    const m = BACKGROUND_MODES.find((m) => m.id === (id || BG_DEFAULT));
    return (m || BACKGROUND_MODES[0]).style;
  }
  function bgMode(id) {
    return BACKGROUND_MODES.find((m) => m.id === (id || BG_DEFAULT)) || BACKGROUND_MODES[0];
  }

  // iOS-style "automatic appearance": a pure day/night decision by local time.
  // Dark window ~19:00–07:00. When `autoAppearance` is off we fall back to the
  // stored darkmode toggle (which defaults to dark).
  function decideDark(darkmode, autoAppearance, hour) {
    if (autoAppearance) return hour < 7 || hour >= 19;
    return !darkmode;
  }
  function applyTheme() {
    const s = readSettings();
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const dark = decideDark(!!s.darkmode, !!s.autoappearance, hour);
    const root = (typeof document !== "undefined" && (document.documentElement || document.body)) ? (document.documentElement || document.body) : null;
    if (root) root.setAttribute("data-theme", dark ? "dark" : "light");
    const url = resolveWallpaper(dark, s.wallpaper);
    if (root && root.style) root.style.setProperty("--wp", url ? `url("${url}")` : "none");
    // Apply the selected background display method (default 若隐若现/ghost).
    if (root) root.setAttribute("data-bg", bgMode(s.background).id);
    const st = bgStyle(s.background);
    if (root && root.style) {
      root.style.setProperty("--wp-alpha", String(st.alpha));
      root.style.setProperty("--wp-blur", `${st.blur}px`);
      root.style.setProperty("--wp-sat", String(st.sat));
      root.style.setProperty("--wp-bright", String(st.bright));
    }
    // The screensaver/lock image renders crisp by default (lockClear); turning the
    // setting off makes it follow the home display method instead.
    const CLEAR = { alpha: 0.9, blur: 0, sat: 1.0, bright: 1.0 };
    const ls = s.lockClear === false ? st : CLEAR;
    if (root && root.style) {
      root.style.setProperty("--lock-alpha", String(ls.alpha));
      root.style.setProperty("--lock-blur", `${ls.blur}px`);
      root.style.setProperty("--lock-sat", String(ls.sat));
      root.style.setProperty("--lock-bright", String(ls.bright));
    }
    updateBrightness(s.brightness);
  }

  // ---- Wallpaper registry ----
  // Built-in wallpapers referenced from `frontend/`. `--wp` (set in applyTheme)
  // drives the home/lock background-image. Users can also point `wallpaper` at
  // a custom data:/http(s):/file: URL or blob.
  const WALLPAPER_FILES = {
    dark: "./wallpaper-dark.png",
    light: "./wallpaper-light.png",
    landscape: "./wallpaper-landscape.png",
    dawn: "./wallpaper-dawn.png",
    abyss: "./wallpaper-abyss.png",
  };
  const WALLPAPER_PRESETS = [
    { id: "auto", label: "自动 · 随深浅切换" },
    { id: "dark", label: "极光夜" },
    { id: "light", label: "晴日山丘" },
    { id: "landscape", label: "暮色原野" },
    { id: "dawn", label: "晨雾玫瑰" },
    { id: "abyss", label: "墨蓝深谷" },
  ];
  function isCustomWallpaper(w) {
    return typeof w === "string" && /^(data:|blob:|https?:|file:)/.test(w);
  }
  // Pure: pick the image URL for the given theme + stored wallpaper choice.
  function resolveWallpaper(dark, w) {
    if (w === "landscape" || w === "dark" || w === "light" || w === "dawn" || w === "abyss") return WALLPAPER_FILES[w];
    if (isCustomWallpaper(w)) return w;
    return dark ? WALLPAPER_FILES.dark : WALLPAPER_FILES.light; // auto / unset
  }

  // Re-apply the theme whenever settings change (darkmode / brightness toggles).
  onStore("amos.settings", () => applyTheme());
  // Refresh home/dock unread badges when the shared notification store changes.
  onStore("amos.notifications", () => { if (!current && viewEl) renderHome(); });
  // Re-render the lock screen if the PIN config changes while locked.
  onStore("amos.lock", () => { if (locked) renderLock(); });

  applyTheme();

  // ---- First-run onboarding (shown before the lock screen on first boot) ----
  let onbPage = 0;
  function renderOnboarding() {
    const wrap = el("div", { class: "onb-screen" });
    if (onbPage === 0) {
      wrap.appendChild(el("div", { class: "onb-hero" }, "📱"));
      wrap.appendChild(el("div", { class: "onb-title" }, "欢迎使用 Amos OS"));
      wrap.appendChild(el("div", { class: "muted", style: { maxWidth: "320px", textAlign: "center" } },
        "AI 优先的移动操作系统。上滑解锁、上滑切换应用、长按整理主屏。"));
      wrap.appendChild(el("div", { class: "onb-row" }, [
        el("button", { class: "btn onb-next", onclick: () => { onbPage = 1; renderOnboarding(); } }, "开始"),
        el("button", { class: "btn secondary onb-skip", onclick: () => skipOnboarding() }, "跳过 → 主屏"),
      ]));
    } else {
      const dark = !!readSettings().darkmode;
      const pin = el("input", {
        class: "field onb-pin", type: "text", inputmode: "numeric", maxlength: "6",
        placeholder: "设置锁屏密码（可选，4-6 位数字）", style: { marginTop: "10px", maxWidth: "320px" },
      });
      const pick = (mode) => {
        const s = readSettings(); s.darkmode = mode; storeWrite("amos.settings", JSON.stringify(s)); applyTheme();
        renderOnboarding();
      };
      wrap.appendChild(el("div", { class: "onb-title" }, "快速设置"));
      wrap.appendChild(el("div", { class: "onb-row" }, [
        el("button", { class: "btn secondary" + (dark ? " onb-sel" : ""), onclick: () => pick(true) }, "🌙 深色"),
        el("button", { class: "btn secondary" + (!dark ? " onb-sel" : ""), onclick: () => pick(false) }, "☀️ 浅色"),
      ]));
      wrap.appendChild(pin);
      wrap.appendChild(el("button", { class: "btn onb-next", onclick: () => {
        const v = String(pin.value || "").trim();
        if (v) { const l = readLockConfig(); l.enabled = true; l.pin = v; storeWrite("amos.lock", JSON.stringify(l)); }
        finishOnboarding();
      } }, "完成"));
    }
    viewEl.classList.remove("home");
    viewEl.innerHTML = "";
    viewEl.appendChild(wrap);
  }

  function showOnboarding() { onbPage = 0; renderOnboarding(); }

  // Finish the guided flow. With no lock PIN the user lands straight on the home
  // launcher (no lock-screen wall); with a PIN we go to the lock screen to match.
  function finishOnboarding() {
    storeWrite("amos.onboarded", "1");
    onbPage = 0;
    const cfg = readLockConfig();
    if (cfg.enabled && cfg.pin) showLock();
    else landHome();
  }

  // Skip onboarding entirely (no PIN): mark done and go straight to home.
  function skipOnboarding() {
    storeWrite("amos.onboarded", "1");
    onbPage = 0;
    landHome();
  }

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
    showLock,
    hideLock,
    showRecents,
    hideRecents,
    pushRecent,
    searchApps,
    showSearch,
    hideSearch,
    applyTheme,
    showOnboarding,
    finishOnboarding,
    skipOnboarding,
    resolveWallpaper,
    wallpaperPresets: WALLPAPER_PRESETS,
    isCustomWallpaper,
    backgroundModes: BACKGROUND_MODES,
    defaultBackgroundMode: BG_DEFAULT,
    resolveBackgroundMode: bgMode,
    decideDark,
    get isLocked() { return locked; },
    init(v) { viewEl = v; },
  };
})();

// ---- Hardware buttons (Home / Voice / AI) ----
// The Rust core (`amos-tauri/src/buttons.rs`) emits a `hardware-button` event
// when a physical button is pressed; `main.js` forwards it here. `press(name)`
// drives the same path via the `simulate_button` command (desktop dev / tests),
// falling back to `handle` when not running inside Tauri.
window.AmosButtons = (() => {
  const A = window.Amos;
  return {
    handle(button) {
      const n = String(button || "").toLowerCase();
      if (n === "home" || n === "home_button") { A.systemHome(); return; }
      if (n === "voice") { A.openApp("ai"); return; }
      if (n === "ai" || n === "ai_assistant" || n === "assistant" || n === "aibutton") { A.openApp("ai"); return; }
    },
    press(name) {
      const I = window.__TAURI_INTERNALS__;
      if (I) { I.invoke("simulate_button", { button: name }).catch(() => {}); }
      else this.handle(name);
    },
  };
})();

// ---- Voice input (ASR) ----
// The AI/translate app captures audio (e.g. via getUserMedia) and calls
// `AmosVoice.transcribe(bytes)`; this forwards to the `transcribe_audio`
// command, which runs the translate daemon's ASR recognizer. Without Tauri it
// resolves to an empty, unrecognized result so callers can degrade gracefully.
window.AmosVoice = (() => ({
  async transcribe(audioBytes, opts = {}) {
    const I = window.__TAURI_INTERNALS__;
    if (!I) return { text: "", recognized: false };
    const bytes = Array.from(audioBytes || []);
    return I.invoke("transcribe_audio", {
      audio: bytes,
      language: opts.language || "",
      format: opts.format || "wav",
    });
  },
  // Translate a text segment through the translate daemon.
  async translate(text, opts = {}) {
    const I = window.__TAURI_INTERNALS__;
    if (!I) return "";
    return I.invoke("translate_text", {
      text,
      source_lang: opts.source_lang || "",
      target_lang: opts.target_lang || "",
    });
  },
}))();

// ---- Interpretation session (同声传译) ----
// Bridges `interpret_*` commands so the UI can run a live interpretation
// session. Outputs arrive as `interpret-output` events (wired in main.js) and
// are routed to `onOutput` (a hook apps can override). Without Tauri these are
// no-ops so a non-Tauri build degrades gracefully.
window.AmosInterp = (() => {
  const I = window.__TAURI_INTERNALS__;
  let sessionId = null;
  return {
    // Hook for `interpret-output` events; apps may replace it.
    onOutput(payload) {
      if (payload && payload.kind === "segment_final") {
        console.log("[interp]", payload.source_text, "→", payload.target_text);
      }
    },
    get sessionId() { return sessionId; },
    async start(opts = {}) {
      if (!I) return null;
      sessionId = await I.invoke("interpret_start", {
        source_lang: opts.source || "auto",
        target_lang: opts.target || "zh",
      });
      return sessionId;
    },
    async text(text) {
      if (!I || !sessionId) return;
      return I.invoke("interpret_text", { text, sessionId });
    },
    async audio(chunk) {
      if (!I || !sessionId) return;
      return I.invoke("interpret_audio", { chunk: Array.from(chunk || []), sessionId });
    },
    async endOfSpeech() {
      if (!I || !sessionId) return;
      return I.invoke("interpret_end_of_speech", { sessionId });
    },
    async pause() { if (I && sessionId) return I.invoke("interpret_pause", { sessionId }); },
    async resume() { if (I && sessionId) return I.invoke("interpret_resume", { sessionId }); },
    async stop() { if (I && sessionId) return I.invoke("interpret_stop", { sessionId }); },
    async restart() { if (I && sessionId) return I.invoke("interpret_restart", { sessionId }); },
    async abort() { if (I && sessionId) return I.invoke("interpret_abort", { sessionId }); },
    async status() { if (!I) return null; return I.invoke("interpret_status"); },
  };
})();

// ---- Text-to-speech (同传播报) ----
// Synthesizes translated text to playable PCM via the `tts_synthesize` command.
// Without Tauri it returns null so callers degrade gracefully.
window.AmosTts = (() => {
  const I = window.__TAURI_INTERNALS__;
  return {
    async synthesize(text, opts = {}) {
      if (!I) return null;
      return I.invoke("tts_synthesize", { text, lang: opts.lang || "zh" });
    },
  };
})();
