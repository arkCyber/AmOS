// Amos UI — dynamic card renderer ("语义中枢 → 像素表面").
// The AI daemon returns structured `UiCard` descriptors; this module turns them
// into interactive DOM cards. New card kinds only need a renderer here.
window.AmosCards = (() => {
  const A = window.Amos;

  // Map a quick-action label to an app to open (best-effort).
  function runAction(label) {
    const l = label || "";
    if (l.indexOf("音乐") >= 0) return A.openApp("music");
    if (l.indexOf("地图") >= 0) return A.openApp("maps");
    if (l.indexOf("相机") >= 0 || l.indexOf("拍照") >= 0) return A.openApp("camera");
    if (l.indexOf("笔记") >= 0) return A.openApp("notes");
    if (l.indexOf("相册") >= 0 || l.indexOf("照片") >= 0) return A.openApp("photos");
    if (l.indexOf("文件") >= 0) return A.openApp("files");
    if (l.indexOf("天气") >= 0) return A.openApp("weather");
    if (l.indexOf("时钟") >= 0) return A.openApp("clock");
    if (l.indexOf("设置") >= 0) return A.openApp("settings");
    if (l.indexOf("应用") >= 0) return A.openApp("ai");
  }

  function fieldRows(card) {
    const rows = A.el("div", { style: { marginTop: "6px" } });
    (card.fields || []).forEach((f) => {
      rows.appendChild(A.el("div", { class: "row spread", style: { padding: "3px 0" } }, [
        A.el("span", { class: "muted" }, f.key),
        A.el("span", { style: { fontWeight: "600" } }, f.value),
      ]));
    });
    return rows;
  }

  function actionRow(card) {
    const row = A.el("div", { class: "row", style: { marginTop: "10px", flexWrap: "wrap", gap: "6px" } });
    (card.actions || []).forEach((a) =>
      row.appendChild(A.el("button", { class: "btn secondary", style: { flex: "1", minWidth: "88px" }, onclick: () => runAction(a) }, a))
    );
    return row;
  }

  // Per-kind accent gradient for the card header.
  function headerColor(kind) {
    const m = {
      weather: ["#4facfe", "#00f2fe"],
      media: ["#ff5e62", "#ff9966"],
      note: ["#f6d365", "#fda085"],
      wallet: ["#a8e063", "#56ab2f"],
      action: ["#8e2de2", "#4a00e0"],
    }[kind] || ["#5b7cfa", "#3a4f9c"];
    return `linear-gradient(135deg, ${m[0]}, ${m[1]})`;
  }

  function render(card) {
    if (!card || !card.kind) return null;
    const wrap = A.el("div", { class: "card ai-card", style: { alignSelf: "flex-start", maxWidth: "88%" } });
    wrap.appendChild(A.el("div", { class: "ai-card-head", style: { background: headerColor(card.kind) } }, card.title || card.kind));
    if (card.subtitle) wrap.appendChild(A.el("div", { class: "muted", style: { marginTop: "6px" } }, card.subtitle));
    wrap.appendChild(fieldRows(card));
    if (card.actions && card.actions.length) wrap.appendChild(actionRow(card));
    return wrap;
  }

  return { render };
})();
