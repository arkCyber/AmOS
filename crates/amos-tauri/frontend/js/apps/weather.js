// Amos app: 天气 (mock forecast)
window.Amos.register({
  id: "weather",
  name: "天气",
  icon: "🌤️",
  gradient: ["#4facfe", "#00f2fe"],
  render() {
    const A = window.Amos;
    const forecast = [
      { d: "今天", t: "26°", icon: "☀️" },
      { d: "周三", t: "24°", icon: "⛅" },
      { d: "周四", t: "21°", icon: "🌧️" },
      { d: "周五", t: "23°", icon: "☁️" },
      { d: "周六", t: "27°", icon: "☀️" },
    ];
    const head = A.el("div", { style: { textAlign: "center", padding: "16px 0" } }, [
      A.el("div", { style: { fontSize: "70px" } }, "⛅"),
      A.el("div", { style: { fontSize: "42px", fontWeight: "200" } }, "26°"),
      A.el("div", { class: "muted" }, "北京 · 多云 · 湿度 58%"),
    ]);
    const list = A.el("div", null);
    forecast.forEach((f) =>
      list.appendChild(
        A.el("div", { class: "card row spread" }, [
          A.el("span", null, f.d),
          A.el("span", { style: { fontSize: "26px" } }, f.icon),
          A.el("span", { style: { fontWeight: "600" } }, f.t),
        ])
      )
    );
    return A.appShell("天气", A.el("div", null, [head, list]));
  },
});
