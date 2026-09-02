// Amos app: 设置 (persistent toggles via localStorage)
window.Amos.register({
  id: "settings",
  name: "设置",
  icon: "⚙️",
  gradient: ["#9aa0a6", "#5f6368"],
  render() {
    const A = window.Amos;
    const KEY = "amos.settings";
    const store = JSON.parse(A.safeGet(KEY, "{}"));

    const toggle = (key, label, sub) => {
      const box = A.el("div", { class: "card row spread" }, [
        A.el("div", null, [
          A.el("div", null, label),
          sub ? A.el("div", { class: "muted" }, sub) : null,
        ]),
        A.el("label", { class: "switch" }, [
          A.el("input", {
            type: "checkbox",
            checked: !!store[key],
            onchange: (e) => { store[key] = e.target.checked; A.storeWrite(KEY, JSON.stringify(store)); },
          }),
          A.el("span", { class: "track" }),
        ]),
      ]);
      return box;
    };

    const slider = (key, label, min, max) => {
      const val = A.el("span", { class: "muted" }, `${store[key] ?? 70}%`);
      const input = A.el("input", {
        type: "range", min, max, value: store[key] ?? 70,
        style: { flex: "1" },
        oninput: (e) => { store[key] = +e.target.value; val.textContent = `${e.target.value}%`; A.storeWrite(KEY, JSON.stringify(store)); },
      });
      return A.el("div", { class: "card" }, [
        A.el("div", { class: "row spread", style: { marginBottom: "8px" } }, [A.el("span", null, label), val]),
        input,
      ]);
    };

    return A.appShell("设置", A.el("div", null, [
      toggle("wifi", "无线局域网", "已连接 AMOS_5G"),
      toggle("bluetooth", "蓝牙", "已开启"),
      toggle("airplane", "飞行模式"),
      (() => {
        // iOS-style "自动外观": switch deep/light + wallpaper by local time.
        const auto = store.autoappearance === true;
        const setAuto = (on) => {
          store.autoappearance = on;
          A.storeWrite(KEY, JSON.stringify(store));
          A.applyTheme();
        };
        const onchange = (e) => { setAuto(e.target.checked); A.applyTheme(); };
        return A.el("div", { class: "card row spread" }, [
          A.el("div", null, [
            A.el("div", null, "自动外观"),
            A.el("div", { class: "muted" }, "按本地时段在深/浅间切换，壁纸随之自动换"),
          ]),
          A.el("label", { class: "switch" }, [
            A.el("input", { type: "checkbox", checked: auto, onchange }),
            A.el("span", { class: "track" }),
          ]),
        ]);
      })(),
      toggle("darkmode", "深色模式"),
      (() => {
        // Wallpaper picker: built-in presets + optional custom image URL.
        const WP = A.wallpaperPresets || [
          { id: "auto", label: "自动 · 随深浅切换" },
          { id: "dark", label: "极光夜" },
          { id: "light", label: "晴日山丘" },
          { id: "landscape", label: "暮色原野" },
        ];
        const msg = A.el("div", { class: "muted", style: { marginTop: "6px" } }, "");
        const url = A.el("input", {
          class: "field",
          placeholder: "自设图片 URL（http / data:…）",
          style: { marginTop: "8px" },
        });
        const buttons = [];
        const paint = () => {
          const cur = store.wallpaper || "auto";
          buttons.forEach((b) => b.classList && b.classList.toggle("wp-sel", cur === b._id));
          msg.textContent = cur === "auto"
            ? "自动：深色用「极光夜」，浅色用「晴日山丘」"
            : (A.isCustomWallpaper && A.isCustomWallpaper(cur))
              ? "正在使用自定义壁纸"
              : (WP.find((p) => p.id === cur) || { label: cur }).label;
        };
        const setWp = (v) => { store.wallpaper = v; A.storeWrite(KEY, JSON.stringify(store)); A.applyTheme(); paint(); };
        WP.forEach((p) => {
          const b = A.el("button", { class: "btn secondary", onclick: () => setWp(p.id) }, p.label);
          b._id = p.id;
          buttons.push(b);
        });
        const applyUrl = () => {
          const v = url.value.trim();
          if (!v) return;
          setWp(v);
          url.value = "";
        };
        if (A.isCustomWallpaper && A.isCustomWallpaper(store.wallpaper)) url.value = store.wallpaper;
        paint();
        return A.el("div", { class: "card" }, [
          A.el("div", { class: "row spread" }, [A.el("span", null, "壁纸"), A.el("span", { class: "muted" }, "点选即时生效")]),
          A.el("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" } }, buttons),
          url,
          A.el("button", { class: "btn secondary", style: { marginTop: "8px" }, onclick: applyUrl }, "应用自定义壁纸"),
          msg,
        ]);
      })(),
      slider("brightness", "亮度"),
      slider("volume", "音量"),
      (() => {
        const resetMsg = A.el("div", { class: "muted", style: { marginTop: "6px" } }, "恢复应用图标默认排列");
        return A.el("div", { class: "card" }, [
          A.el("div", { class: "row spread" }, [
            A.el("span", null, "主屏布局"),
            A.el("button", {
              class: "btn secondary",
              onclick: () => {
                A.storeWrite("amos.home.layout", "");
                resetMsg.textContent = "已重置，返回主屏生效";
              },
            }, "重置"),
          ]),
          resetMsg,
        ]);
      })(),
      A.el("div", { class: "card" }, [
        A.el("div", { class: "row spread" }, [
          A.el("span", null, "关于本机"),
          A.el("span", { class: "muted" }, "Amos OS 0.1.0"),
        ]),
      ]),
      (() => {
        // 锁屏密码: enable PIN lock + set/change the numeric PIN.
        const lockCfg = (() => { try { return JSON.parse(A.safeGet("amos.lock", "{}") || "{}"); } catch (_) { return {}; } })();
        const msg = A.el("div", { class: "muted", style: { marginTop: "6px" } },
          lockCfg.enabled ? (lockCfg.pin ? `已启用密码（${lockCfg.pin}）` : "已启用，请设置密码") : "未启用");
        const pinInput = A.el("input", {
          class: "field", type: "text", inputmode: "numeric", maxlength: "6",
          placeholder: "4-6 位数字密码",
          style: { marginTop: "8px", display: lockCfg.enabled ? "block" : "none" },
        });
        const apply = () => {
          const lock = (() => { try { return JSON.parse(A.safeGet("amos.lock", "{}") || "{}"); } catch (_) { return {}; } })();
          if (lock.enabled && pinInput.value.trim()) lock.pin = pinInput.value.trim();
          A.storeWrite("amos.lock", JSON.stringify(lock));
          msg.textContent = lock.enabled ? (lock.pin ? `已启用密码（${lock.pin}）` : "已启用，请设置密码") : "未启用";
          pinInput.value = "";
        };
        return A.el("div", { class: "card" }, [
          A.el("div", { class: "row spread" }, [
            A.el("span", null, "锁屏密码"),
            A.el("label", { class: "switch" }, [
              A.el("input", {
                type: "checkbox",
                checked: !!lockCfg.enabled,
                onchange: (e) => {
                  const lock = (() => { try { return JSON.parse(A.safeGet("amos.lock", "{}") || "{}"); } catch (_) { return {}; } })();
                  lock.enabled = e.target.checked;
                  A.storeWrite("amos.lock", JSON.stringify(lock));
                  pinInput.style.display = e.target.checked ? "block" : "none";
                  msg.textContent = e.target.checked ? "已启用，请设置密码" : "未启用";
                },
              }),
              A.el("span", { class: "track" }),
            ]),
          ]),
          msg,
          pinInput,
          A.el("button", { class: "btn secondary", style: { marginTop: "8px" }, onclick: apply }, "保存密码"),
        ]);
      })(),
      (() => {
        // Debug card: live snapshot of the Rust window manager (`wm_windows`).
        const list = A.el("div", {
          id: "wm-list", class: "muted",
          style: { marginTop: "6px", fontSize: "11px", whiteSpace: "pre-line" },
        }, "加载中…");
        const refresh = () => {
          const I = window.__TAURI_INTERNALS__;
          if (!I) { list.textContent = "非 Tauri 环境 · 无窗口管理器"; return; }
          I.invoke("wm_windows").then((snap) => {
            if (!snap || !snap.windows) { list.textContent = "窗口管理器不可用"; return; }
            list.textContent = snap.windows
              .map((w) => `${w.label} [${w.kind}]${w.external ? " 外部表面" : ""} ${w.state}${w.focused ? " ←聚焦" : ""}`)
              .join("\n") || "(无窗口)";
          }).catch((e) => { list.textContent = `错误：${e}`; });
        };
        refresh(); // auto-populate on open
        return A.el("div", { class: "card" }, [
          A.el("div", { class: "row spread" }, [
            A.el("span", null, "窗口管理器 (调试)"),
            A.el("button", { class: "btn secondary", onclick: refresh }, "刷新"),
          ]),
          list,
        ]);
      })(),
    ]));
  },
});
