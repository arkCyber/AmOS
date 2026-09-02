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
      toggle("darkmode", "深色模式"),
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
