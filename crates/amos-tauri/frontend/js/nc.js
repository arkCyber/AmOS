// Amos System UI — Notification Center.
//
// Pull down from the status bar (or tap the bell) to reveal a panel with quick
// settings toggles (shared with the Settings app) and a notification list.
// Written against the same browser-global style as the rest of the launcher, so
// it also runs under the bun test harness (no DOM, minimal stubs).

(function () {
  const A = window.Amos;
  const SET_KEY = "amos.settings";
  const NOTIF_KEY = "amos.notifications";
  const SEED_KEY = "amos.notifs.seeded";

  const QUICK = [
    { key: "wifi", label: "无线", icon: "📶" },
    { key: "bluetooth", label: "蓝牙", icon: "🅱" },
    { key: "airplane", label: "飞行", icon: "✈️" },
    { key: "darkmode", label: "深色", icon: "🌙" },
    { key: "dnd", label: "勿扰", icon: "🌒" },
    { key: "location", label: "定位", icon: "📍" },
  ];

  let open = false;

  function readStore() { return JSON.parse(A.safeGet(SET_KEY, "{}") || "{}"); }
  function writeStore(s) { A.storeWrite(SET_KEY, JSON.stringify(s)); }
  function readNotifs() { try { return JSON.parse(A.safeGet(NOTIF_KEY, "[]")) || []; } catch (_) { return []; } }
  function writeNotifs(list) { A.storeWrite(NOTIF_KEY, JSON.stringify(list.slice(0, 30))); }

  function seed() {
    if (A.safeGet(SEED_KEY)) return;
    const now = Date.now();
    writeNotifs([
      { id: "n1", app: "信息", icon: "💬", title: "小安", body: "Amos 系统感觉怎么样？", time: now },
      { id: "n2", app: "天气", icon: "🌤️", title: "今日天气", body: "北京 26°，多云转晴", time: now - 3600e3 },
      { id: "n3", app: "AI 助手", icon: "🤖", title: "后台任务完成", body: "长文本推理已完成，可查看结果", time: now - 7200e3 },
    ]);
    A.safeSet(SEED_KEY, "1");
  }

  function updateBell() {
    const right = document.querySelector(".sb-right");
    const count = readNotifs().length;
    let bell = document.getElementById("nc-bell");
    if (!right || !bell) return;
    bell.textContent = count > 0 ? `🔔 ${count}` : "🔔";
    bell.classList.toggle("has", count > 0);
  }

  // ---- Panel DOM ----
  function quickTile(key, label, icon) {
    const store = readStore();
    const on = !!store[key];
    return A.el("button", {
      class: "nc-tile" + (on ? " on" : ""),
      style: {
        flex: "1 1 30%", minHeight: "52px", borderRadius: "12px", border: "0",
        background: on ? "rgba(10,132,255,0.85)" : "rgba(255,255,255,0.1)",
        color: "#fff", cursor: "pointer", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: "2px", fontSize: "11px",
      },
      onclick: () => {
        const s = readStore();
        s[key] = !s[key];
        writeStore(s);
        render(); // re-render panel to reflect the change
      },
    }, [A.el("span", { style: { fontSize: "18px" } }, icon), A.el("span", null, label)]);
  }

  function slider(key, label) {
    const store = readStore();
    const val = store[key] ?? 70;
    const valueSpan = A.el("span", { class: "nc-muted" }, `${val}%`);
    const input = A.el("input", {
      type: "range", min: "10", max: "100", value: String(val),
      style: { flex: "1" },
      oninput: (e) => {
        const s = readStore();
        s[key] = +e.target.value;
        writeStore(s);
        valueSpan.textContent = `${e.target.value}%`;
      },
    });
    return A.el("div", { class: "nc-row" }, [
      A.el("span", { style: { width: "40px" } }, label),
      input,
      valueSpan,
    ]);
  }

  function notifItem(n) {
    const when = new Date(n.time || Date.now());
    const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    return A.el("div", { class: "nc-notif" }, [
      A.el("span", { class: "nc-app-icon" }, n.icon || "🔔"),
      A.el("div", { style: { flex: "1", minWidth: "0" } }, [
        A.el("div", { class: "nc-notif-head" }, [
          A.el("span", { class: "nc-notif-app" }, n.app || ""),
          A.el("span", { class: "nc-muted" }, time),
        ]),
        A.el("div", { class: "nc-notif-title" }, n.title || ""),
        A.el("div", { class: "nc-notif-body" }, n.body || ""),
      ]),
      A.el("button", {
        class: "nc-dismiss", title: "清除此通知",
        onclick: (e) => {
          e.stopPropagation();
          writeNotifs(readNotifs().filter((x) => x.id !== n.id));
          render();
        },
      }, "✕"),
    ]);
  }

  function render() {
    const overlay = document.getElementById("nc-overlay");
    if (!overlay) return;
    overlay.innerHTML = "";
    overlay.className = "nc-overlay" + (open ? " open" : "");

    const list = readNotifs();
    const quickGrid = A.el("div", { class: "nc-quick" });
    QUICK.forEach((q) => quickGrid.appendChild(quickTile(q.key, q.label, q.icon)));

    const notifBox = A.el("div", { class: "nc-notifs" });
    if (!list.length) {
      notifBox.appendChild(A.el("div", { class: "nc-muted", style: { textAlign: "center", padding: "16px 0" } }, "暂无通知"));
    } else {
      list.forEach((n) => notifBox.appendChild(notifItem(n)));
    }

    overlay.appendChild(
      A.el("div", { class: "nc-panel" }, [
        A.el("div", { class: "nc-grabber" }),
        A.el("div", { class: "nc-head row spread" }, [
          A.el("span", { style: { fontWeight: "600" } }, "通知中心"),
          A.el("button", { class: "nc-clear btn secondary", onclick: () => { writeNotifs([]); render(); } }, "清空"),
        ]),
        quickGrid,
        A.el("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" } }, [
          slider("brightness", "亮度"),
          slider("volume", "音量"),
        ]),
        notifBox,
      ])
    );
    updateBell();
  }

  // ---- Drag from status bar ----
  function initDrag() {
    const sb = document.getElementById("status-bar");
    const overlay = document.getElementById("nc-overlay");
    if (!sb || !overlay) return;
    let startY = 0;
    let dragging = false;
    sb.addEventListener("pointerdown", (e) => {
      startY = e.clientY || 0;
      dragging = true;
    });
    sb.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dy = Math.max(0, (e.clientY || 0) - startY);
      overlay.style.transform = `translateY(${Math.min(dy, 420)}px)`;
    });
    sb.addEventListener("pointerup", (e) => {
      dragging = false;
      const dy = (e.clientY || 0) - startY;
      overlay.style.transform = "";
      if (dy > 50) api.show();
      else if (Math.abs(dy) < 8) api.toggle();
      render();
    });
    overlay.addEventListener("pointerdown", (e) => {
      if (open) startY = e.clientY || 0;
    });
    overlay.addEventListener("pointerup", (e) => {
      if (open && ((e.clientY || 0) - startY) < -40) api.hide();
    });
    updateBell();
  }

  // ---- Public API ----
  const api = {
    show() { open = true; render(); },
    hide() { open = false; render(); },
    toggle() { open = !open; render(); },
    get open() { return open; },
    post(app, title, body, icon) {
      const list = readNotifs();
      list.unshift({ id: "n" + Date.now(), app, title, body, icon, time: Date.now() });
      writeNotifs(list);
      render();
    },
    clearAll() { writeNotifs([]); render(); },
    render,
  };
  window.AmosNc = api;

  seed();
  render();
  initDrag();

  // React to remote windows mutating shared state (multi-window sync): refresh
  // the panel when open, or at least the status-bar bell count.
  A.onStore(SET_KEY, () => { if (open) render(); });
  A.onStore(NOTIF_KEY, () => { if (open) render(); else updateBell(); });
})();
