// Amos app: 计算器 (working calculator)
window.Amos.register({
  id: "calculator",
  name: "计算器",
  icon: "🧮",
  gradient: ["#f5b301", "#d98a00"],
  render() {
    const A = window.Amos;
    const display = A.el("div", {
      style: {
        textAlign: "right", fontSize: "40px", padding: "20px 14px",
        overflow: "hidden", whiteSpace: "nowrap", minHeight: "58px",
      },
    }, "0");

    let acc = "";      // accumulated left operand + operator
    let cur = "0";     // current operand

    const set = (t) => { display.textContent = t; };
    const refresh = () => {
      set(cur);
      try {
        // Live preview when acc is a complete expression.
        if (acc) set(acc + (cur === "0" ? "" : cur));
      } catch (_) { /* ignore */ }
    };

    const press = (label) => {
      if (/[0-9]/.test(label)) {
        cur = cur === "0" ? label : cur + label;
      } else if (label === ".") {
        if (!cur.includes(".")) cur += ".";
      } else if (label === "C") {
        acc = ""; cur = "0";
      } else if (label === "⌫") {
        cur = cur.length > 1 ? cur.slice(0, -1) : "0";
      } else if (label === "=") {
        const expr = (acc + cur).replace(/×/g, "*").replace(/÷/g, "/");
        try { cur = String(parseFloat(Function(`return ${expr}`)())); }
        catch (_) { cur = "错误"; }
        acc = "";
      } else {
        // operator
        try {
          const expr = (acc + cur).replace(/×/g, "*").replace(/÷/g, "/");
          if (acc) cur = String(parseFloat(Function(`return ${expr}`)()));
        } catch (_) { cur = "错误"; }
        acc = cur + " " + label + " ";
        cur = "0";
      }
      refresh();
    };

    const rows = [
      ["C", "⌫", "%", "÷"],
      ["7", "8", "9", "×"],
      ["4", "5", "6", "−"],
      ["1", "2", "3", "+"],
      ["0", ".", "=", ""],
    ];
    const grid = A.el("div", {
      style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "10px", padding: "6px" },
    });
    rows.forEach((row) =>
      row.forEach((k) => {
        if (k === "") return;
        const op = /[÷×−+%]/.test(k) || k === "=";
        const isZero = k === "0";
        grid.appendChild(
          A.el("button", {
            class: isZero ? "key zero" : "key",
            style: {
              height: isZero ? "58px" : "58px",
              gridColumn: isZero ? "span 2" : "auto",
              borderRadius: "29px", fontSize: "24px", border: "0", cursor: "pointer",
              background: op ? "#ff9f0a" : k === "C" || k === "⌫" ? "#a5a5a5" : "#333",
              color: op ? "#fff" : k === "C" || k === "⌫" ? "#000" : "#fff",
            },
            onclick: () => press(k),
          }, k)
        );
      })
    );

    return A.appShell("计算器", A.el("div", null, [display, grid]));
  },
});
