// Amos app: 信息 (simple conversation)
window.Amos.register({
  id: "messages",
  name: "信息",
  icon: "💬",
  gradient: ["#40c057", "#2ba84a"],
  render() {
    const A = window.Amos;
    const contact = "小安";
    const threads = [
      { from: "them", text: "你好！Amos 系统感觉怎么样？" },
      { from: "me", text: "很棒，图标像 iOS 一样顺滑。" },
      { from: "them", text: "要不要试试 AI 应用？长按电源键也可以唤醒。" },
    ];
    const body = A.el("div", {
      style: { display: "flex", flexDirection: "column", gap: "8px", paddingBottom: "12px" },
    });
    const draw = () => {
      body.innerHTML = "";
      threads.forEach((m) =>
        body.appendChild(
          A.el("div", {
            class: m.from === "me" ? "bubble me" : "bubble them",
            style: {
              alignSelf: m.from === "me" ? "flex-end" : "flex-start",
              maxWidth: "78%", padding: "8px 12px", borderRadius: "16px",
              background: m.from === "me" ? "#0a84ff" : "rgba(255,255,255,0.1)",
            },
          }, m.text)
        )
      );
    };

    const input = A.el("input", { class: "field", placeholder: `发给 ${contact}…` });
    const sendBtn = A.el("button", {
      class: "btn",
      onclick: () => {
        const t = input.value.trim();
        if (!t) return;
        threads.push({ from: "me", text: t });
        input.value = "";
        draw();
      },
    }, "发送");

    draw();
    return A.appShell(`信息 · ${contact}`, A.el("div", null, [body, A.el("div", { class: "row" }, [input, sendBtn])]));
  },
});
