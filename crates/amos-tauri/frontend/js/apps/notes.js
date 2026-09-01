// Amos app: 备忘录 (working local notes)
window.Amos.register({
  id: "notes",
  name: "备忘录",
  icon: "📝",
  gradient: ["#ffd60a", "#ff9f0a"],
  render() {
    const A = window.Amos;
    const KEY = "amos.notes";
    const notes = JSON.parse(A.safeGet(KEY, "[]"));
    const list = A.el("div", null);

    const persist = () => A.storeWrite(KEY, JSON.stringify(notes));

    // Cross-app context injection demo (docs/gui-verify.md scenario D): push the
    // note text as system context for the AI window, then focus it.
    const sendToAI = (text) => {
      const I = window.__TAURI_INTERNALS__;
      if (!I) return;
      I.invoke("system_set_context", { targetWindow: "ai", sourceWindow: "notes", text })
        .then(() => I.invoke("wm_open", { label: "ai" }))
        .catch(() => {});
    };
    const draw = () => {
      list.innerHTML = "";
      if (!notes.length) {
        list.appendChild(A.el("div", { class: "muted", style: { textAlign: "center", padding: "30px 0" } }, "暂无备忘录"));
      }
      notes.forEach((n, i) => {
        list.appendChild(
          A.el("div", { class: "card" }, [
            A.el("p", { style: { margin: "0 0 6px", whiteSpace: "pre-wrap" } }, n.text),
            A.el("div", { class: "row spread" }, [
              A.el("span", { class: "muted" }, n.time),
              A.el("button", { class: "btn secondary", onclick: () => { notes.splice(i, 1); persist(); draw(); } }, "删除"),
              A.el("button", { class: "btn", onclick: () => sendToAI(n.text) }, "发送到 AI"),
            ]),
          ])
        );
      });
    };

    const input = A.el("textarea", {
      class: "field", rows: 3, placeholder: "写点什么…",
      style: { resize: "none", marginBottom: "10px" },
    });
    const addBtn = A.el("button", {
      class: "btn",
      onclick: () => {
        const text = input.value.trim();
        if (!text) return;
        notes.unshift({ text, time: new Date().toLocaleString() });
        persist();
        input.value = "";
        draw();
      },
    }, "保存");

    draw();
    return A.appShell("备忘录", A.el("div", null, [input, addBtn, list]));
  },
});
