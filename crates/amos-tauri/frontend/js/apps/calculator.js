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

    let acc = "";        // accumulated left operand + operator, e.g. "9 − "
    let cur = "0";       // current operand being typed
    let justEq = false;  // last press was "=" → iOS starts a fresh number next

    // iOS Calculator semantics helpers.
    const toJs = (s) => s.replace(/−/g, "-").replace(/×/g, "*").replace(/÷/g, "/");
    const evalNum = (s) => {
      const v = Function(`"use strict"; return (${toJs(s)});`)();
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("calc");
      return v;
    };
    const fmt = (v) => String(Number(Number(v).toPrecision(12))); // tame 0.1+0.2 noise

    const set = (t) => { display.textContent = t; };
    const refresh = () => {
      if (justEq) { set(cur); return; }
      set(acc ? acc + (cur === "0" ? "" : cur) : cur);
    };

    const press = (label) => {
      if (/[0-9]/.test(label)) {
        if (justEq) { acc = ""; cur = label; justEq = false; }   // fresh number after =
        else cur = cur === "0" ? label : cur + label;
      } else if (label === ".") {
        if (justEq) { acc = ""; cur = "0."; justEq = false; }
        else if (!cur.includes(".")) cur += ".";
      } else if (label === "C") {
        acc = ""; cur = "0"; justEq = false;
      } else if (label === "⌫") {
        cur = cur.length > 1 ? cur.slice(0, -1) : "0";
      } else if (label === "%") {
        // Standard/iOS basic-calculator: percent divides the current entry by 100.
        try { cur = fmt(evalNum(cur) / 100); } catch (_) { cur = "错误"; }
      } else if (label === "=") {
        try { cur = fmt(evalNum(acc + cur)); } catch (_) { cur = "错误"; }
        acc = "";
        justEq = true;
      } else {
        // operator (＋ − × ÷); keep the current entry as the left operand
        justEq = false;
        try { if (acc) cur = fmt(evalNum(acc + cur)); } catch (_) { cur = "错误"; }
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
