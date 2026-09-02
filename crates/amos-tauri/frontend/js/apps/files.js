// Amos app: 文件 (store-backed file manager: create folders/text files, view, delete)
window.Amos.register({
  id: "files",
  name: "文件",
  icon: "📁",
  gradient: ["#4f8ff7", "#2f5ec0"],
  render() {
    const A = window.Amos;
    const KEY = "amos.files";
    const read = () => {
      try { const f = JSON.parse(A.safeGet(KEY, "[]")); return Array.isArray(f) ? f : []; } catch (_) { return []; }
    };
    const write = (list) => A.storeWrite(KEY, JSON.stringify(list));
    const fmt = (ts) => new Date(ts).toLocaleString();

    // Seed a couple of demo entries so the manager isn't empty on first open.
    if (!read().length) {
      write([
        { type: "folder", name: "文档", ts: Date.now() },
        { type: "file", name: "说明.txt", content: "欢迎使用 Amos 文件管理器。\n长按可删除文件，点击文件查看内容。", ts: Date.now() - 3600e3 },
      ]);
    }

    const root = A.el("div", { style: { display: "flex", flexDirection: "column", minHeight: "0", flex: "1" } });
    const list = A.el("div", null);
    const status = A.el("div", { class: "muted", style: { textAlign: "center", padding: "20px 0", display: "none" } }, "空文件夹");

    // Create form (folder: name only; file: name + content).
    const nameInput = A.el("input", { class: "field", placeholder: "名称", style: { marginBottom: "6px" } });
    const contentArea = A.el("textarea", { class: "field", rows: "4", placeholder: "内容", style: { marginBottom: "6px", resize: "vertical" } });
    const formMsg = A.el("div", { class: "muted", style: { margin: "4px 0" } }, "");
    const form = A.el("div", { class: "card", style: { display: "none" } }, [
      nameInput, contentArea,
      A.el("div", { class: "row" }, [
        A.el("button", { class: "btn", onclick: save }, "保存"),
        A.el("button", { class: "btn secondary", onclick: () => { form.style.display = "none"; } }, "取消"),
      ]),
      formMsg,
    ]);

    let mode = "folder"; // what create-form is adding
    function openForm(m) {
      mode = m;
      nameInput.value = "";
      contentArea.value = "";
      contentArea.style.display = m === "file" ? "block" : "none";
      form.style.display = "block";
      formMsg.textContent = m === "file" ? "新建文本文件" : "新建文件夹";
    }
    function save() {
      const name = nameInput.value.trim();
      if (!name) { formMsg.textContent = "请输入名称"; return; }
      if (read().some((e) => e.name === name)) { formMsg.textContent = "已存在同名条目"; return; }
      const entry = mode === "file"
        ? { type: "file", name, content: contentArea.value, ts: Date.now() }
        : { type: "folder", name, ts: Date.now() };
      write([...read(), entry]);
      form.style.display = "none";
      renderList();
    }

    function openFile(entry) {
      const view = A.el("div", {
        style: { position: "absolute", inset: "0", zIndex: "10", background: "rgba(10,12,20,0.96)", padding: "18px", display: "flex", flexDirection: "column", gap: "10px" },
      }, [
        A.el("div", { class: "row spread" }, [
          A.el("span", { style: { fontWeight: "600", fontSize: "16px" } }, entry.name),
          A.el("button", { class: "btn secondary", onclick: () => { view.remove && view.remove(); } }, "关闭"),
        ]),
        A.el("div", { class: "muted" }, fmt(entry.ts)),
        A.el("pre", { style: { flex: "1", overflow: "auto", whiteSpace: "pre-wrap", background: "rgba(255,255,255,0.05)", borderRadius: "10px", padding: "12px", margin: "0" } }, entry.content || "(空文件)"),
        A.el("button", { class: "btn", style: { background: "#ff453a" }, onclick: () => {
          write(read().filter((x) => x.name !== entry.name));
          view.remove && view.remove();
          renderList();
        } }, "删除文件"),
      ]);
      root.appendChild(view);
    }

    function renderList() {
      list.innerHTML = "";
      const entries = read();
      status.style.display = entries.length ? "none" : "block";
      entries.forEach((e) => list.appendChild(A.el("div", { class: "card row" }, [
        A.el("span", { style: { fontSize: "26px" } }, e.type === "folder" ? "📁" : "📄"),
        A.el("div", { style: { flex: "1", minWidth: "0" } }, [
          A.el("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, e.name),
          A.el("div", { class: "muted" }, fmt(e.ts)),
        ]),
        e.type === "file" ? A.el("button", { class: "btn secondary", onclick: () => openFile(e) }, "查看") : null,
        A.el("button", { class: "btn secondary", style: { color: "#ff6b6b" }, onclick: () => {
          write(read().filter((x) => x.name !== e.name));
          renderList();
        } }, "删除"),
      ])));
    }

    const toolbar = A.el("div", { class: "row", style: { margin: "8px 0" } }, [
      A.el("button", { class: "btn", onclick: () => openForm("folder") }, "＋ 文件夹"),
      A.el("button", { class: "btn secondary", onclick: () => openForm("file") }, "＋ 文本"),
    ]);

    renderList();
    root.appendChild(toolbar);
    root.appendChild(form);
    root.appendChild(status);
    root.appendChild(list);
    return A.appShell("文件", A.el("div", { style: { position: "relative", flex: "1", display: "flex", flexDirection: "column", minHeight: "0" } }, [root]));
  },
});

