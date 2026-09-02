// Amos app: 相册 (store-backed photo gallery)
window.Amos.register({
  id: "photos",
  name: "相册",
  icon: "🖼️",
  gradient: ["#ff2d55", "#c81e45"],
  render() {
    const A = window.Amos;
    const KEY = "amos.photos";
    const palette = [
      ["#f94144", "#f3722c"], ["#f8961e", "#f9c74f"], ["#90be6d", "#43aa8b"],
      ["#4d908e", "#577590"], ["#9b5de5", "#f15bb5"], ["#00bbf9", "#00f5d4"],
      ["#277da1", "#43aa8b"], ["#f15bb5", "#fee440"],
    ];
    const EMOJI = ["🌅", "🏔️", "🌌", "🌸", "🏙️", "🌊", "🌵", "🎈"];

    const read = () => {
      try { const p = JSON.parse(A.safeGet(KEY, "[]")); return Array.isArray(p) ? p : []; } catch (_) { return []; }
    };
    const write = (list) => A.storeWrite(KEY, JSON.stringify(list));

    // Seed a few photos on first open so the album isn't empty.
    if (!read().length) {
      write(palette.map((p, i) => ({
        id: "seed-" + i, a: p[0], b: p[1], emoji: EMOJI[i % EMOJI.length], ts: Date.now() - i * 86400000,
      })));
    }

    const root = A.el("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0" } });

    const addBtn = A.el("button", { class: "btn", onclick: () => {
      const p = palette[Math.floor(Math.random() * palette.length)];
      const list = read();
      list.unshift({ id: "p" + Date.now() + Math.random().toString(16).slice(2, 6), a: p[0], b: p[1], emoji: EMOJI[Math.floor(Math.random() * EMOJI.length)], ts: Date.now() });
      write(list);
      renderGrid();
    } }, "＋ 拍照");

    const msg = A.el("div", { class: "muted", style: { textAlign: "center", padding: "24px 0", display: "none" } }, "暂无照片");
    const grid = A.el("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "3px" } });

    const fmt = (ts) => {
      const d = new Date(ts);
      return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    function renderGrid() {
      grid.innerHTML = "";
      const list = read();
      msg.style.display = list.length ? "none" : "block";
      list.forEach((ph) => grid.appendChild(A.el("button", {
        style: {
          aspectRatio: "1", borderRadius: "2px", border: "0", padding: "0", cursor: "pointer",
          background: ph.data ? `url(${ph.data}) center/cover` : `linear-gradient(135deg, ${ph.a}, ${ph.b})`,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: "30px",
        },
        onclick: () => openViewer(ph),
      }, ph.data ? "" : ph.emoji)));
    }

    function openViewer(ph) {
      const view = A.el("div", {
        style: {
          position: "absolute", inset: "0", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: "14px",
          background: ph.a ? `linear-gradient(135deg, ${ph.a}, ${ph.b})` : "#14161d", zIndex: "10",
        },
      }, [
        ph.data
          ? A.el("img", { src: ph.data, style: { maxWidth: "90%", maxHeight: "55%", borderRadius: "12px", objectFit: "contain" } })
          : A.el("div", { style: { fontSize: "120px" } }, ph.emoji),
        A.el("div", { style: { fontSize: "14px", color: "#fff", opacity: "0.85" } }, fmt(ph.ts)),
        A.el("div", { class: "row", style: { gap: "12px" } }, [
          A.el("button", { class: "btn secondary", onclick: () => { view.remove && view.remove(); renderGrid(); } }, "返回"),
          A.el("button", { class: "btn", style: { background: "#ff453a" }, onclick: () => {
            write(read().filter((x) => x.id !== ph.id));
            view.remove && view.remove();
            renderGrid();
          } }, "删除"),
        ]),
      ]);
      root.appendChild(view);
    }

    renderGrid();
    root.appendChild(A.el("div", { class: "row", style: { margin: "8px 12px" } }, [addBtn, msg]));
    root.appendChild(grid);
    return A.appShell("相册", A.el("div", { style: { padding: 0, position: "relative", flex: "1", display: "flex", flexDirection: "column", minHeight: "0" } }, [root]));
  },
});

