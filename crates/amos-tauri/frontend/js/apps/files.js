// Amos app: 文件 (store-backed file manager)
// Flat store of entries { type, name, parent?, content?, ts }. Entries reference
// their containing folder by `parent` name; names are kept globally unique so a
// path is unambiguous. Supports arbitrary-depth navigation with a deep-link
// breadcrumb, rename (keeps children attached), cut/move, and cascade delete.
window.Amos.register({
  id: "files",
  name: "文件",
  icon: "📁",
  gradient: ["#4f8ff7", "#2f5ec0"],
  render() {
    const A = window.Amos;
    const KEY = "amos.files";
    const read = () => { try { const f = JSON.parse(A.safeGet(KEY, "[]")); return Array.isArray(f) ? f : []; } catch (_) { return []; } };
    const write = (list) => A.storeWrite(KEY, JSON.stringify(list));
    const fmt = (ts) => new Date(ts).toLocaleString();

    // Seed demo content on first open.
    if (!read().length) {
      write([
        { type: "folder", name: "文档", ts: Date.now() },
        { type: "file", name: "说明.txt", content: "欢迎使用 Amos 文件管理器。\n点文件夹进入，可重命名 / 移动 / 删除。", ts: Date.now() - 3600e3 },
      ]);
    }

    // ---- Navigation model (任意层级 / 深链) ----
    let cwd = null;        // current folder name; null = root
    let moving = null;     // entry name being cut/moved; null = idle
    let renaming = null;   // entry name being renamed through the shared form

    const byName = (n) => read().find((e) => e.name === n) || null;
    const childrenOf = (name) => read().filter((e) => (e.parent || null) === (name || null));
    const pathOf = (name) => { // ancestors from root -> current (deep-link segments)
      const segs = []; let cur = name;
      while (cur) { const f = byName(cur); if (!f) break; segs.unshift(f); cur = f.parent || null; }
      return segs;
    };
    const isInside = (name, outer) => { // is `name` equal to / inside the `outer` subtree?
      let cur = name;
      while (cur) { if (cur === outer) return true; const f = byName(cur); cur = f ? f.parent || null : null; }
      return false;
    };

    // ---- DOM skeleton ----
    const root = A.el("div", { style: { display: "flex", flexDirection: "column", minHeight: "0", flex: "1" } });
    const list = A.el("div", null);
    const status = A.el("div", { class: "muted", style: { textAlign: "center", padding: "20px 0", display: "none" } }, "空文件夹");
    const nav = A.el("div", { style: { display: "flex", flexDirection: "column", gap: "4px", margin: "6px 0 2px", minHeight: "30px" } });

    // ---- Shared create/rename form ----
    const nameInput = A.el("input", { class: "field", placeholder: "名称", style: { marginBottom: "6px" } });
    const contentArea = A.el("textarea", { class: "field", rows: "4", placeholder: "内容", style: { marginBottom: "6px", resize: "vertical" } });
    const formMsg = A.el("div", { class: "muted", style: { margin: "4px 0" } }, "");
    const form = A.el("div", { class: "card", style: { display: "none" } }, [
      nameInput, contentArea,
      A.el("div", { class: "row" }, [
        A.el("button", { class: "btn", onclick: () => save() }, "保存"),
        A.el("button", { class: "btn secondary", onclick: () => { form.style.display = "none"; renaming = null; } }, "取消"),
      ]),
      formMsg,
    ]);

    let createType = "folder";
    function showCreate(t) {
      renaming = null; createType = t;
      nameInput.value = ""; contentArea.value = "";
      contentArea.style.display = t === "file" ? "block" : "none";
      formMsg.textContent = t === "file" ? "新建文本文件" : "新建文件夹";
      form.style.display = "block";
    }
    function beginRename(entry) {
      renaming = entry.name; createType = "folder";
      nameInput.value = entry.name; contentArea.value = ""; contentArea.style.display = "none";
      formMsg.textContent = `重命名「${entry.name}」`;
      form.style.display = "block";
    }
    function save() {
      const name = nameInput.value.trim();
      if (!name) { formMsg.textContent = "请输入名称"; return; }
      if (renaming) {
        const all = read(); const target = all.find((e) => e.name === renaming);
        if (!target) { renaming = null; form.style.display = "none"; renderList(); return; }
        if (name !== renaming && all.some((e) => e.name === name)) { formMsg.textContent = "已存在同名条目"; return; }
        target.name = name;
        all.forEach((e) => { if ((e.parent || null) === renaming) e.parent = name; }); // keep children attached
        write(all); renaming = null; form.style.display = "none"; renderList(); return;
      }
      const here = cwd || null;
      if (read().some((e) => e.name === name)) { formMsg.textContent = "已存在同名条目"; return; }
      const entry = createType === "file"
        ? { type: "file", name, content: contentArea.value, ts: Date.now() }
        : { type: "folder", name, ts: Date.now() };
      if (here) entry.parent = here;
      write([...read(), entry]);
      form.style.display = "none";
      renderList();
    }
    // ---- Move (剪切/移动) ----
    function beginMove(entry) { moving = entry.name; renderList(); }
    function moveHere() {
      if (!moving) return;
      const all = read(); const item = all.find((e) => e.name === moving);
      if (!item) { moving = null; renderList(); return; }
      const dest = cwd || null;
      // a folder can never move into itself or one of its own descendants
      if (item.type === "folder" && dest && isInside(dest, item.name)) { moving = null; renderList(); return; }
      if ((item.parent || null) !== dest) { item.parent = dest; write(all); }
      moving = null; renderList();
    }

    // ---- Delete: folders cascade to everything beneath them ----
    function deleteEntry(entry) {
      const all = read();
      if (entry.type === "folder") {
        const doomed = new Set([entry.name]); let changed = true;
        while (changed) {
          changed = false;
          for (const en of all) if (en.type === "folder" && doomed.has(en.parent) && !doomed.has(en.name)) { doomed.add(en.name); changed = true; }
        }
        write(all.filter((en) => !(doomed.has(en.name) || doomed.has(en.parent))));
      } else {
        write(all.filter((en) => !(en.name === entry.name && (en.parent || null) === (entry.parent || null))));
      }
      renderList();
    }

    // ---- Navigation bar: deep-link breadcrumb (+ move actions when active) ----
    const stop = (ev) => { if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation(); };
    const segBtn = (label, target) => A.el("button", {
      class: "btn secondary",
      style: { padding: "3px 10px", fontSize: "12px", fontWeight: cwd === target ? "700" : undefined },
      onclick: () => { cwd = target; renderList(); },
    }, label);
    const renderNav = () => {
      nav.innerHTML = "";
      const bar = A.el("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" } });
      bar.appendChild(segBtn(cwd ? "‹ 根目录" : "根目录", null));
      pathOf(cwd).forEach((f) => { bar.appendChild(A.el("span", { class: "muted" }, "/")); bar.appendChild(segBtn(f.name, f.name)); });
      nav.appendChild(bar);
      if (moving) {
        const m = byName(moving);
        nav.appendChild(A.el("div", { class: "row", style: { gap: "8px", marginTop: "2px" } }, [
          A.el("span", { class: "muted" }, `剪切「${m ? m.name : ""}」→ 粘贴到当前目录`),
          A.el("button", { class: "btn", onclick: () => moveHere() }, "移动到这里"),
          A.el("button", { class: "btn secondary", onclick: () => { moving = null; renderList(); } }, "取消"),
        ]));
      }
    };

    // ---- File viewer ----
    function openFile(entry) {
      const view = A.el("div", { style: { position: "absolute", inset: "0", zIndex: "10", background: "rgba(10,12,20,0.96)", padding: "18px", display: "flex", flexDirection: "column", gap: "10px" } }, [
        A.el("div", { class: "row spread" }, [
          A.el("span", { style: { fontWeight: "600", fontSize: "16px" } }, entry.name),
          A.el("button", { class: "btn secondary", onclick: () => { view.remove && view.remove(); } }, "关闭"),
        ]),
        A.el("div", { class: "muted" }, fmt(entry.ts)),
        A.el("pre", { style: { flex: "1", overflow: "auto", whiteSpace: "pre-wrap", background: "rgba(255,255,255,0.05)", borderRadius: "10px", padding: "12px", margin: "0" } }, entry.content || "(空文件)"),
        A.el("button", { class: "btn", style: { background: "#ff453a" }, onclick: () => {
          write(read().filter((x) => !(x.name === entry.name && (x.parent || null) === (entry.parent || null))));
          view.remove && view.remove(); renderList();
        } }, "删除文件"),
      ]);
      root.appendChild(view);
    }

    // ---- List rows ----
    const rowFor = (e) => {
      const row = A.el("div", { class: "card row", style: moving === e.name ? { opacity: "0.45" } : undefined }, [
        A.el("span", { style: { fontSize: "26px" } }, e.type === "folder" ? "📁" : "📄"),
        A.el("div", { style: { flex: "1", minWidth: "0" } }, [
          A.el("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, e.name),
          A.el("div", { class: "muted" }, fmt(e.ts)),
        ]),
      ]);
      if (e.type === "folder") { row.style.cursor = "pointer"; row.addEventListener("click", () => openFolder(e)); }
      else row.appendChild(A.el("button", { class: "btn secondary", onclick: (ev) => { stop(ev); openFile(e); } }, "查看"));
      row.appendChild(A.el("button", { class: "btn secondary", onclick: (ev) => { stop(ev); beginRename(e); } }, "重命名"));
      row.appendChild(A.el("button", { class: "btn secondary", onclick: (ev) => { stop(ev); beginMove(e); } }, "移动"));
      const del = A.el("button", { class: "btn secondary", style: { color: "#ff6b6b" }, onclick: (ev) => { stop(ev); deleteEntry(e); } }, "删除");
      row.appendChild(del);
      return row;
    };
    const renderList = () => {
      renderNav();
      list.innerHTML = "";
      const entries = childrenOf(cwd);
      status.style.display = entries.length ? "none" : "block";
      entries.forEach((e) => list.appendChild(rowFor(e)));
    };
    function openFolder(entry) { if (entry.type === "folder") { cwd = entry.name; renderList(); } }

    const toolbar = A.el("div", { class: "row", style: { margin: "8px 0" } }, [
      A.el("button", { class: "btn", onclick: () => showCreate("folder") }, "＋ 文件夹"),
      A.el("button", { class: "btn secondary", onclick: () => showCreate("file") }, "＋ 文本"),
    ]);

    renderList();
    root.appendChild(toolbar);
    root.appendChild(nav);
    root.appendChild(form);
    root.appendChild(status);
    root.appendChild(list);
    return A.appShell("文件", A.el("div", { style: { position: "relative", flex: "1", display: "flex", flexDirection: "column", minHeight: "0" } }, [root]));
  },
});

