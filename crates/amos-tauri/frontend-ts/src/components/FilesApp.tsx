import { Fragment, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import {
  FILES_KEY,
  addEntry,
  childrenOf,
  deleteEntry,
  hasName,
  makeEntry,
  moveEntry,
  pathOf,
  renameEntry,
  type FEntry,
} from "../lib/files";
import { fmtTime } from "../lib/notes";

const FOLDER = "📁";
const FILE = "📄";

export default function FilesApp() {
  const { t } = useI18n();
  const [list, setList] = useState<FEntry[]>(() => {
    const l = readStoreValue<FEntry[]>(FILES_KEY, []);
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

  const kids = childrenOf(list, cwd);
  const path = pathOf(list, cwd);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const beginCreate = (kind: "folder" | "file") => {
    setCreating(kind);
    setName("");
    setContent("");
    setErr("");
  };
  const submitCreate = () => {
    const v = name.trim();
    if (!v) return;
    if (hasName(kids, v)) {
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
        <button onClick={() => beginCreate("folder")} className="rounded-full bg-accent px-3 py-1 text-sm text-white">
          {t("files.addFolder")}
        </button>
        <button onClick={() => beginCreate("file")} className="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700">
          {t("files.addFile")}
        </button>
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
            <button onClick={submitRename} className="rounded-full bg-accent px-3 py-1 text-sm text-white">
              {t("files.create")}
            </button>
            <button onClick={() => setRenameId(null)} className="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700">
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
          <button onClick={moveHere} className="rounded-full bg-accent px-3 py-1 text-xs text-white">
            {t("files.moveHere")}
          </button>
          <button onClick={() => setCutId(null)} className="rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700">
            {t("files.cancelMove")}
          </button>
        </div>
      )}
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}

      {/* list */}
      {kids.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">{t("files.empty")}</p>
      ) : (
        <div className="mt-2 space-y-1">
          {kids.map((e) => {
            const isFolder = e.type === "folder";
            return (
              <div
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={isFolder ? () => setCwd(e.id) : undefined}
                onKeyDown={isFolder ? (ev) => ev.key === "Enter" && setCwd(e.id) : undefined}
                className={
                  "flex items-center gap-2 rounded-xl bg-neutral-200/50 p-2 dark:bg-neutral-800/50 " +
                  (isFolder ? "cursor-pointer" : "")
                }
              >
                <span className="text-xl">{isFolder ? FOLDER : FILE}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{e.name}</div>
                  <div className="text-[10px] opacity-50">{fmtTime(e.ts)}</div>
                </div>
                <div className="flex gap-1">
                  {act(t("files.rename"), () => beginRename(e.id, e.name))}
                  {act(t("files.move"), () => doCut(e.id))}
                  {act(t("files.delete"), () => persist(deleteEntry(list, e.id)))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

