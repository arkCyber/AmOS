// Amos app: 电话 (Phone dialer)
window.Amos.register({
  id: "phone",
  name: "电话",
  icon: "📞",
  gradient: ["#2fc64e", "#17a53c"],
  render() {
    const A = window.Amos;
    const num = A.el("div", { class: "display", style: { textAlign: "center", fontSize: "34px", padding: "18px 0", letterSpacing: "3px" } }, "号码");

    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
    const grid = A.el("div", {
      class: "keypad",
      style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "14px", padding: "6px 10px 20px" },
    });

    const keyBtn = (k) =>
      A.el("button", {
        class: "key",
        style: {
          height: "58px", borderRadius: "29px", fontSize: "24px",
          background: "rgba(255,255,255,0.1)", border: "0", color: "#fff", cursor: "pointer",
        },
        onclick: () => { num.textContent += k; },
      }, k);
    keys.forEach((k) => grid.appendChild(keyBtn(k)));

    const callBtn = A.el("button", {
      class: "call",
      style: {
        display: "block", margin: "0 auto", width: "66px", height: "66px", borderRadius: "50%",
        background: "#34c759", border: "0", color: "#fff", fontSize: "24px", cursor: "pointer",
      },
      onclick: () => {
        if (num.textContent.trim()) {
          num.textContent = `正在呼叫 ${num.textContent.trim()}…`;
          setTimeout(() => { num.textContent = ""; }, 1600);
        }
      },
    }, "📞");

    const del = A.el("button", {
      class: "btn secondary",
      style: { marginTop: "10px", display: "block", marginLeft: "auto", marginRight: "auto" },
      onclick: () => { num.textContent = num.textContent.slice(0, -1); },
    }, "删除");

    return A.appShell("电话", A.el("div", null, [num, grid, callBtn, del]));
  },
});
