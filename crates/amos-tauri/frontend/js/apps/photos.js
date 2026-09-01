// Amos app: 相册 (placeholder photo grid)
window.Amos.register({
  id: "photos",
  name: "相册",
  icon: "🖼️",
  gradient: ["#ff2d55", "#c81e45"],
  render() {
    const A = window.Amos;
    const palette = [
      ["#f94144", "#f3722c"], ["#f8961e", "#f9c74f"], ["#90be6d", "#43aa8b"],
      ["#4d908e", "#577590"], ["#577590", "#277da1"], ["#9b5de5", "#f15bb5"],
      ["#00bbf9", "#00f5d4"], ["#f15bb5", "#fee440"], ["#277da1", "#43aa8b"],
    ];
    const grid = A.el("div", {
      style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "3px" },
    });
    for (let i = 0; i < 12; i++) {
      const [a, b] = palette[i % palette.length];
      grid.appendChild(A.el("div", {
        style: {
          aspectRatio: "1", borderRadius: "2px",
          background: `linear-gradient(135deg, ${a}, ${b})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "26px",
        },
      }, i % 3 === 0 ? "🌅" : i % 3 === 1 ? "🏔️" : "🌌"));
    }
    return A.appShell("相册", A.el("div", { style: { padding: 0 } }, [grid]));
  },
});
