// Amos app: 文件 (mock file manager)
window.Amos.register({
  id: "files",
  name: "文件",
  icon: "📁",
  gradient: ["#4f8ff7", "#2f5ec0"],
  render() {
    const A = window.Amos;
    const files = [
      { icon: "📄", name: "架构设计.md", size: "12 KB" },
      { icon: "📊", name: "月度报告.xlsx", size: "48 KB" },
      { icon: "🖼️", name: "壁纸.png", size: "1.2 MB" },
      { icon: "📦", name: "amos-0.1.0.tar.gz", size: "8.4 MB" },
      { icon: "🎵", name: "demo.mp3", size: "3.1 MB" },
      { icon: "📄", name: "安装说明.txt", size: "2 KB" },
    ];
    const list = A.el("div", null);
    files.forEach((f) =>
      list.appendChild(
        A.el("div", { class: "card row" }, [
          A.el("span", { style: { fontSize: "26px" } }, f.icon),
          A.el("div", { style: { flex: "1" } }, [
            A.el("div", null, f.name),
            A.el("div", { class: "muted" }, f.size),
          ]),
        ])
      )
    );
    return A.appShell("文件", A.el("div", null, [list]));
  },
});
