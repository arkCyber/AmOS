import { Fragment, useState } from "react";
import { useI18n } from "../i18n";
import { chip, btn, GROUP } from "./ui";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import {
  FILES_KEY,
  addEntry,
  childrenOf,
  deleteEntry,
  deleteEntries,
  filterByName,
  folderPath,
  hasName,
  makeEntry,
  moveEntry,
  moveEntries,
  normalizeFiles,
  folderTree,
  pathOf,
  renameEntry,
  searchFiles,
  sortChildren,
  toggleFav,
  recentFiles,
  FILES_FAV_KEY,
  type FEntry,
  type SortKey,
} from "../lib/files";
import { fmtTime } from "../lib/notes";

const FOLDER = "📁";
const FILE = "📄";

export default function FilesApp() {
  const { t } = useI18n();
  const [list, setList] = useState<FEntry[]>(() => {
    const l = normalizeFiles(readStoreValue<unknown>(FILES_KEY, []));
    if (l.length) return l;
    const now = Date.now();
    const seed: FEntry[] = [
      { id: "doc", type: "folder", name: "文档", ts: now },
      { id: "note", type: "file", name: "说明.txt", content: "欢迎使用 Amos 文件管理器", ts: now - 1000 },
    ];
    writeStoreValue(FILES_KEY, seed);
    return seed;
  });
  const persist = (l: FEntry[]) => {
    writeStoreValue(FILES_KEY, l);
    setList(l);
  };

  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState<null | "folder" | "file">(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [err, setErr] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [cutId, setCutId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [query, setQuery] = useState("");
  const [globalSearch, setGlobalSearch] = useState(false);
  const [mode, setMode] = useState<"all" | "fav" | "recent">("all");
  const [favs, setFavs] = useState<string[]>(() => readStoreValue<string[]>(FILES_FAV_KEY, []));
  const fav = (id: string) => {
    const next = toggleFav(favs, id);
    setFavs(next);
    writeStoreValue(FILES_FAV_KEY, next);
  };
  // Multi-select (batch delete) over the currently displayed rows.
  const [selecting, setSelecting] = useState(false);
  const [selIds, setSelIds] = useState<ReadonlySet<string>>(new Set());
  const toggleSel = (id: string) =>
    setSelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const exitSelect = () => {
    setSelecting(false);
    setSelIds(new Set());
  };
  const deleteSelected = () => {
    if (selIds.size === 0) return;
    persist(deleteEntries(list, selIds));
    exitSelect();
  };
  // Select-all/none scoped to the currently visible (filtered) rows.
  const toggleSelectAll = () =>
    setSelIds((prev) => {
      const visible = display.map((e) => e.id);
      if (visible.length === 0) return prev;
      const hasAll = visible.every((id) => prev.has(id));
      return hasAll ? new Set() : new Set(visible);
    });
  // Candidate destinations: every folder (as a nesting-aware tree) that isn't
  // itself selected.
  const moveTargets = folderTree(list).filter((n) => !selIds.has(n.id));
  const moveSelectedTo = (destId: string) => {
    if (selIds.size === 0) return;
    persist(moveEntries(list, selIds, destId === "__root" ? undefined : destId));
    exitSelect();
  };

  let display: FEntry[];
  if (mode === "fav") {
    display = filterByName(list.filter((e) => favs.includes(e.id)), query);
  } else if (mode === "recent") {
    display = filterByName(recentFiles(list, 40), query);
  } else if (globalSearch) {
    display = query.trim() ? searchFiles(list, query, true) : [];
  } else {
    display = filterByName(sortChildren(list, cwd, sortKey), query);
  }
  const path = pathOf(list, cwd);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const cycleSort = () =>
    setSortKey((k) => (k === "default" ? "name" : k === "name" ? "time" : "default"));
  // Opening a folder found via global search should leave search mode and land
  // in that folder (otherwise the results list just re-filters and looks stuck).
  const openFolder = (id: string) => {
    if (globalSearch) {
      setGlobalSearch(false);
      setQuery("");
    }
    setCwd(id);
  };

  const beginCreate = (kind: "folder" | "file") => {
    setCreating(kind);
    setName("");
    setContent("");
    setErr("");
  };
  const submitCreate = () => {
    const v = name.trim();
    if (!v) return;
    if (hasName(childrenOf(list, cwd), v)) {
      setErr(t("files.conflict"));
      return;
    }
    const entry = makeEntry(creating ?? "folder", v, cwd, Date.now());
    if (creating === "file") entry.content = content;
    persist(addEntry(list, entry));
    setCreating(null);
  };

  const beginRename = (id: string, oldName: string) => {
    setRenameId(id);
    setRenameVal(oldName);
  };
  const submitRename = () => {
    const v = renameVal.trim();
    if (!v || !renameId) return;
    const target = list.find((e) => e.id === renameId);
    if (target && v !== target.name && hasName(childrenOf(list, target.parent), v)) {
      setErr(t("files.conflict"));
      return;
    }
    persist(renameEntry(list, renameId, v));
    setRenameId(null);
  };

  const doCut = (id: string) => setCutId(id);
  const moveHere = () => {
    if (!cutId) return;
    persist(moveEntry(list, cutId, cwd));
    setCutId(null);
  };

  const act = (label: string, onClick: () => void) => (
    <button
      key={label}
      onClick={(e) => {
        stop(e);
        onClick();
      }}
      className="rounded-full bg-neutral-300/70 px-2 py-0.5 text-[11px] dark:bg-neutral-700/70"
    >
      {label}
    </button>
  );

  const seg = (label: string, id: string | undefined, bold: boolean) => (
    <button
      key={label + (id ?? "root")}
      onClick={() => setCwd(id)}
      className={"px-2 py-0.5 text-xs " + (bold ? "font-semibold" : "text-accent")}
    >
      {label}
    </button>
  );

  return (
    <div className="p-3">
      {/* toolbar */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => beginCreate("folder")} className={btn("accent")}>
          {t("files.addFolder")}
        </button>
        <button onClick={() => beginCreate("file")} className={btn()}>
          {t("files.addFile")}
        </button>
        {display.length > 0 && (
          <>
            <button
              onClick={() => (selecting ? exitSelect() : setSelecting(true))}
              className={chip(selecting, "sm")}
            >
              {selecting ? t("files.cancel") : t("files.select")}
            </button>
            {selecting && selIds.size > 0 && (
              <button
                onClick={deleteSelected}
                className={btn("danger")}
              >
                {t("files.deleteSelected", { n: selIds.size })}
              </button>
            )}
            {selecting && selIds.size > 0 && (
              <select
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) moveSelectedTo(v);
                }}
                aria-label={t("files.moveSel")}
                className="rounded-full bg-neutral-300 px-2 py-1 text-xs dark:bg-neutral-700"
              >
                <option value="" disabled>
                  {t("files.moveSel")}
                </option>
                <option value="__root">{t("files.root")}</option>
                {moveTargets.map((n) => (
                  <option key={n.id} value={n.id}>
                    {"　".repeat(n.depth)}
                    {n.name}
                  </option>
                ))}
              </select>
            )}
            {selecting && display.length > 0 && (
              <button
                onClick={toggleSelectAll}
                className={btn()}
              >
                {selIds.size === display.length
                  ? t("files.selectNone")
                  : t("files.selectAll", { n: display.length })}
              </button>
            )}
          </>
        )}
      </div>

      {/* view: all / favorites / recent */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(
          [
            ["all", "files.all"],
            ["fav", "files.fav"],
            ["recent", "files.recent"],
          ] as const
        ).map(([m, key]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={chip(mode === m)}
          >
            {t(key)}
          </button>
        ))}
      </div>
      {/* search + sort within the current folder */}
      <div className="mt-2 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("files.search")}
          className="min-w-0 flex-1 rounded-full bg-neutral-200 px-3 py-1 text-sm outline-none dark:bg-neutral-800"
        />
        <button
          onClick={() => setGlobalSearch((g) => !g)}
          title={t(globalSearch ? "files.currentFolder" : "files.global")}
          className="shrink-0 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700"
        >
          {t(globalSearch ? "files.currentFolder" : "files.global")}
        </button>
        {!globalSearch && (
          <button
            onClick={cycleSort}
            title={t("files.sort")}
            className="shrink-0 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700"
          >
            {sortKey === "default"
              ? t("files.sort")
              : sortKey === "name"
                ? `↑ ${t("files.sortName")}`
                : `↓ ${t("files.sortTime")}`}
          </button>
        )}
      </div>

      {/* deep-link breadcrumb */}
      <div className="mt-2 flex flex-wrap items-center gap-0.5 rounded-xl bg-neutral-200/50 p-1 dark:bg-neutral-800/50">
        {seg(cwd ? `‹ ${t("files.root")}` : t("files.root"), undefined, !cwd)}
        {path.map((p) => (
          <Fragment key={p.id}>
            <span className="text-xs opacity-40">/</span>
            {seg(p.name, p.id, p.id === cwd)}
          </Fragment>
        ))}
      </div>

      {/* create form */}
      {creating && (
        <div className="mt-2 space-y-2 rounded-xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
          <label className="block text-xs opacity-60">{t("files.name")}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="w-full rounded-lg bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900"
          />
          {creating === "file" && (
            <>
              <label className="block text-xs opacity-60">{t("files.content")}</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={2}
                className="w-full rounded-lg bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900"
              />
            </>
          )}
          <div className="flex gap-2">
            <button onClick={submitCreate} className="rounded-full bg-accent px-3 py-1 text-sm text-white">
              {t("files.create")}
            </button>
            <button onClick={() => setCreating(null)} className="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700">
              {t("files.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* rename form */}
      {renameId && (
        <div className="mt-2 space-y-2 rounded-xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
          <label className="block text-xs opacity-60">{t("files.rename")}</label>
          <input
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            autoFocus
            className="w-full rounded-lg bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900"
          />
          <div className="flex gap-2">
            <button onClick={submitRename} className={btn("accent")}>
              {t("files.create")}
            </button>
            <button onClick={() => setRenameId(null)} className={btn()}>
              {t("files.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* move banner */}
      {cutId && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-neutral-200/60 p-2 dark:bg-neutral-800/60">
          <span className="flex-1 text-xs opacity-70">
            {t("files.cut", { name: list.find((e) => e.id === cutId)?.name ?? "" })}
          </span>
          <button onClick={moveHere} className={btn("accent", "sm")}>
            {t("files.moveHere")}
          </button>
          <button onClick={() => setCutId(null)} className={btn("neutral", "sm")}>
            {t("files.cancelMove")}
          </button>
        </div>
      )}
      {err && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {err}
        </p>
      )}

      {/* list */}
      {display.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          {mode === "fav" && favs.length === 0
            ? t("files.favEmpty")
            : globalSearch && !query.trim()
              ? t("files.searchHint")
              : query.trim()
                ? t("files.noMatch")
                : t("files.empty")}
        </p>
      ) : (
        <div className={"divide-y divide-black/5 dark:divide-white/10 " + GROUP}>
          {display.map((e) => {
            const isFolder = e.type === "folder";
            const isSel = selecting && selIds.has(e.id);
            return (
              <div
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={
                  selecting
                    ? () => toggleSel(e.id)
                    : isFolder
                      ? () => openFolder(e.id)
                      : undefined
                }
                onKeyDown={
                  selecting
                    ? (ev) => ev.key === "Enter" && toggleSel(e.id)
                    : isFolder
                      ? (ev) => ev.key === "Enter" && openFolder(e.id)
                      : undefined
                }
                className={
                  "flex items-center gap-2 px-3.5 py-2.5 " +
                  (isSel ? "bg-accent/15" : "") +
                  (isFolder && !selecting ? " cursor-pointer" : "")
                }
              >
                {selecting && (
                  <span
                    className={
                      "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold " +
                      (isSel ? "bg-accent text-white" : "bg-black/15 dark:bg-white/15")
                    }
                  >
                    {isSel ? "✓" : ""}
                  </span>
                )}
                <span className="text-xl">{isFolder ? FOLDER : FILE}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{e.name}</div>
                  <div className="text-[10px] opacity-50">
                    {globalSearch
                      ? folderPath(list, e.id) || t("files.root")
                      : fmtTime(e.ts)}
                  </div>
                </div>
                {!selecting && (
                  <div className="flex gap-1">
                    <button
                      onClick={(ev) => {
                        stop(ev);
                        fav(e.id);
                      }}
                      aria-label="favorite"
                      className={
                        "rounded-full px-2 py-0.5 text-[11px] " +
                        (favs.includes(e.id) ? "text-amber-500" : "text-neutral-400")
                      }
                    >
                      {favs.includes(e.id) ? "★" : "☆"}
                    </button>
                    {act(t("files.rename"), () => beginRename(e.id, e.name))}
                    {act(t("files.move"), () => doCut(e.id))}
                    {act(t("files.delete"), () => persist(deleteEntry(list, e.id)))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

