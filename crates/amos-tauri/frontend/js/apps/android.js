// Amos app: 安卓应用 — lists legacy Android apps (from the Waydroid / demo
// runtime via the shared gRPC pipe) and launches them on tap.
window.Amos.register({
  id: "android",
  name: "安卓应用",
  icon: "🤖",
  gradient: ["#3ddc84", "#00a854"],
  render() {
    const A = window.Amos;
    const I = window.__TAURI_INTERNALS__;
    const RECENT_KEY = "amos.android.recent";

    const readRecent = () => {
      try { return JSON.parse(A.safeGet(RECENT_KEY, "[]")) || []; } catch (_) { return []; }
    };
    const writeRecent = (list) => A.safeSet(RECENT_KEY, JSON.stringify(list.slice(0, 6)));

    const status = A.el("div", { class: "muted", style: { marginBottom: "10px" } }, "加载中…");
    const recent = A.el("div", { class: "android-recent", style: { marginBottom: "10px" } });
    const grid = A.el("div", {
      class: "android-grid",
      style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "14px 8px" },
    });

    const renderRecent = () => {
      recent.innerHTML = "";
      const list = readRecent();
      if (!list.length) return;
      recent.appendChild(A.el("div", { class: "muted", style: { marginBottom: "6px" } }, "最近启动"));
      list.forEach((r) =>
        recent.appendChild(
          A.el("button", {
            class: "recent-chip",
            style: {
              margin: "0 6px 6px 0", padding: "6px 12px", borderRadius: "999px",
              background: "rgba(255,255,255,0.12)", color: "#fff", border: "0", cursor: "pointer",
              fontSize: "12px",
            },
            onclick: () => launch(r.package_name),
          }, `${r.name || r.package_name}`)
        )
      );
    };

    const bytesToDataUri = (bytes) => {
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return "data:image/png;base64," + btoa(bin);
    };

    const appTile = (a) => {
      const fallback = A.el("span", {}, "🤖");
      const img = A.el("img", {
        alt: a.name || a.package_name,
        style: {
          position: "absolute", inset: "0", width: "100%", height: "100%",
          objectFit: "cover", display: "none", background: "#2c6b49",
        },
      });
      const tile = A.el("div", {
        style: {
          position: "relative", width: "52px", height: "52px", borderRadius: "14px",
          background: "linear-gradient(145deg, #2c6b49, #00a854)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "26px", overflow: "hidden",
        },
      }, [fallback, img]);

      // Load a real icon over gRPC; fall back to the emoji if unavailable.
      if (I) {
        I.invoke("get_android_app_icon", { packageName: a.package_name }).then((bytes) => {
          if (bytes && bytes.length) {
            img.src = bytesToDataUri(bytes);
            img.style.display = "block";
            fallback.style.display = "none";
          }
        }).catch(() => {});
      }

      return A.el("button", {
        class: "android-app",
        style: {
          display: "flex", flexDirection: "column", alignItems: "center", gap: "6px",
          background: "none", border: "0", cursor: "pointer",
        },
        onclick: () => launch(a.package_name),
      }, [
        tile,
        A.el("span", { style: { fontSize: "11px", color: "#fff", textAlign: "center" } }, a.name || a.package_name),
      ]);
    };

    function launch(pkg) {
      if (!pkg) return;
      if (!I) { status.textContent = "非 Tauri 环境，无法拉起应用"; return; }
      status.textContent = `正在启动 ${pkg}…`;
      I.invoke("launch_android_app", { packageName: pkg })
        .then((r) => {
          if (r.success) {
            const list = readRecent().filter((x) => x.package_name !== pkg);
            list.unshift({ package_name: pkg, name: pkg, ts: Date.now() });
            writeRecent(list);
            renderRecent();
            status.textContent = `已启动 · ${r.window_id}`;
          } else {
            status.textContent = `启动失败：${r.error}`;
          }
        })
        .catch((e) => { status.textContent = `RPC 错误：${e}`; });
    }

    if (!I) {
      status.textContent = "非 Tauri 环境（无法列出安卓应用）";
    } else {
      I.invoke("get_android_apps", {}).then((apps) => {
        if (!apps || !apps.length) { status.textContent = "暂无安卓应用"; return; }
        status.textContent = `${apps.length} 个安卓应用 · 点击启动`;
        apps.forEach((a) => grid.appendChild(appTile(a)));
      }).catch((e) => { status.textContent = `获取失败：${e}`; });
    }

    renderRecent();
    const input = A.el("input", { class: "field", placeholder: "输入包名启动，如 com.tencent.mm" });
    const launchBtn = A.el("button", { class: "btn", onclick: () => launch(input.value.trim()) }, "启动");
    const row = A.el("div", { class: "row", style: { marginTop: "12px" } }, [input, launchBtn]);

    return A.appShell("安卓应用", A.el("div", null, [status, recent, grid, row]));
  },
});
