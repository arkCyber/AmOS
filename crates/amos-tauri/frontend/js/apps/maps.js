// Amos app: 地图 (stylized mock map)
window.Amos.register({
  id: "maps",
  name: "地图",
  icon: "🗺️",
  gradient: ["#34c759", "#1f9d4a"],
  render() {
    const A = window.Amos;
    const canvas = A.el("div", {
      style: {
        height: "220px", borderRadius: "14px",
        background:
          "linear-gradient(180deg,#a8e063,#56ab2f), repeating-linear-gradient(0deg,rgba(255,255,255,0.06) 0 40px,transparent 40px 80px), repeating-linear-gradient(90deg,rgba(255,255,255,0.06) 0 40px,transparent 40px 80px)",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: "40px",
      },
    }, "📍 当前位置");

    const search = A.el("input", { class: "field", placeholder: "搜索地点…", style: { margin: "12px 0" } });
    const places = ["天安门广场", "三里屯太古里", "奥林匹克森林公园"].map((p) =>
      A.el("div", { class: "card row spread" }, [
        A.el("span", null, "📍 " + p),
        A.el("button", { class: "btn secondary", onclick: () => (canvas.textContent = "📍 " + p) }, "导航"),
      ])
    );

    return A.appShell("地图", A.el("div", null, [canvas, search, ...places]));
  },
});
