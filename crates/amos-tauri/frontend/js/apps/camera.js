// Amos app: 相机 (mock viewfinder)
window.Amos.register({
  id: "camera",
  name: "相机",
  icon: "📷",
  gradient: ["#333", "#111"],
  render() {
    const A = window.Amos;
    const hint = A.el("div", { class: "muted", style: { textAlign: "center", padding: "16px 0" } }, "取景器（演示）");

    const view = A.el("div", {
      style: {
        flex: "1", margin: "0 -14px",
        background:
          "linear-gradient(160deg,#0f2027,#203a43 40%,#2c5364), radial-gradient(80% 60% at 70% 20%, rgba(255,255,255,0.18), transparent)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "60px",
      },
    }, "🏔️");

    const flash = A.el("div", {
      style: {
        position: "absolute", inset: 0, background: "#fff", opacity: "0",
        transition: "opacity 0.3s", pointerEvents: "none",
      },
    });

    const shutter = A.el("button", {
      style: {
        display: "block", margin: "16px auto", width: "66px", height: "66px",
        borderRadius: "50%", border: "4px solid #fff", background: "rgba(255,255,255,0.15)",
        cursor: "pointer",
      },
      onclick: () => {
        flash.style.opacity = "1";
        setTimeout(() => (flash.style.opacity = "0"), 120);
        hint.textContent = "已拍照 📸";
        setTimeout(() => (hint.textContent = "取景器（演示）"), 1200);
      },
    });

    return A.appShell("相机", A.el("div", { style: { position: "relative", display: "flex", flexDirection: "column", height: "100%", padding: 0 } }, [view, hint, shutter, flash]));
  },
});
