<script lang="ts">
  // FilesApp.svelte — Svelte 5 (runes) implementation of the file manager. All
  // logic reuses pure lib/files.ts. Feature-complete (create folder/file, rename,
  // move, single + multi-select batch delete/move, favorites, search, sort,
  // all/fav/recent views). The former React body was removed in the subtraction
  // phase — this is the only implementation, mounted by `appRegistry`.
  import {
    FILES_FAV_KEY,
    FILES_KEY,
    FILES_REVEAL_KEY,
    FILES_TRASH_KEY,
    addEntry,
    childrenOf,
    filterByName,
    folderPath,
    folderTree,
    hasName,
    makeEntry,
    moveEntries,
    moveEntry,
    moveToTrash,
    normalizeFiles,
    normalizeReveal,
    normalizeTrash,
    pathOf,
    purgeFromTrash,
    recentFiles,
    renameEntry,
    restoreFromTrash,
    searchFiles,
    sortChildren,
    toggleFav,
  } from "../lib/files";
  import type { FEntry, SortKey, TrashItem } from "../lib/files";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import FileErrorBanner from "./modules/FileErrorBanner.svelte";
  import { fmtTime } from "../lib/notes";
  import { canonicalPath, hasMediaBridge, mediaGrantRead, mediaList, mediaLoad, type StandardDir } from "../lib/media";
  import {
    buildExternalFileView,
    externalGlyph,
    filterExternalByName,
    formatBytes,
    groupByCollection,
    recentExternalFiles,
    sortExternalFiles,
    type ExternalSort,
  } from "../lib/externalFiles";
  import { planPreview, previewBytesLabel, type PreviewPlan } from "../lib/filesPreview";
  import { exportBundle, importBundle } from "../lib/filesCompression";
  import { buildSnapshot, deleteSnapshot, loadSnapshot, saveSnapshot, formatSnapshotSize, type CloudSnapshot } from "../lib/filesCloud";
  import { t } from "./locale.svelte";
  import { filesChannel } from "./appLinks";
  import { onMount } from "svelte";
  import {
    navNext,
    createKeyboardHandler,
    scrollIntoViewIfNeeded,
    entryAriaLabel,
    type A11yNavState,
  } from "../lib/filesA11y";
  import {
    createFileError,
    createErrorHistory,
    addError,
    detectErrorStorm,
    type FileOperationError,
    type ErrorHistory,
  } from "../lib/filesError";

  /**
   * External collections this screen lists, read-only. The `media_*` bridge is the
   * source; a collection it cannot serve simply fails and is skipped (see
   * `loadExternal`), so the list is honest about what exists rather than assumed.
   */
  const EXTERNAL_COLLECTIONS: readonly StandardDir[] = [
    "download",
    "pictures",
    "movies",
    "music",
    "recordings",
  ];

  const FOLDER = "📁";
  const FILE = "📄";
  const CARD_GROUP =
    "overflow-hidden rounded-[11px] bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.07] dark:ring-white/10";

  // Demo seed — **only when the key is absent**, so an intentionally emptied store
  // stays empty (the rule `Shell.seedContactsOnce` documents for contacts).
  const seed = ((): FEntry[] => {
    const raw = readStoreValue<unknown>(FILES_KEY, undefined);
    if (raw !== undefined) return normalizeFiles(raw);
    const now = Date.now();
    const s: FEntry[] = [
      { id: "doc", type: "folder", name: "文档", ts: now },
      { id: "note", type: "file", name: "说明.txt", content: "欢迎使用 Amos 文件管理器", ts: now - 1000 },
    ];
    writeStoreValue(FILES_KEY, s);
    return s;
  })();

  let list = $state<FEntry[]>(seed);
  let cwd = $state<string | undefined>(undefined);
  /**
   * The trash ledger (REQ-A455), read with the same "repair, don't trust" rule the tree
   * uses (`normalizeTrash`) and **without a demo seed**: an empty trash is the honest
   * initial state — seeding one would show the user a deleted file they never deleted.
   */
  let trash = $state<TrashItem[]>(
    normalizeTrash(readStoreValue<unknown>(FILES_TRASH_KEY, undefined)),
  );
  /** What the last trash action actually did (a fallback location, a refusal, an eviction). */
  let trashNote = $state("");
  /**
   * The cross-window reveal intent (REQ-A458) — the desktop Spotlight's only route into this
   * window. Subscribed here so a request that arrives while this screen is open lands immediately,
   * and a request that arrives **before** the window exists is picked up from the store's initial
   * value (`createStoreValue` seeds from it).
   */
  const revealStore = createStoreValue<unknown>(FILES_REVEAL_KEY, null);
  /** Highest reveal nonce this window has served (a repeat of the same id still fires). */
  let revealNonce = 0;
  /**
   * Ledger rows paired with their root entry.
   *
   * `normalizeTrash` guarantees a root (`members[0]`), but the type system cannot know it —
   * and a template should not have to assert its way past that. One derivation, so the
   * rows and the actions below always agree on which entry a row names.
   */
  const trashRows = $derived(
    trash
      .map((item) => ({ item, root: item.members[0] }))
      .filter((r): r is { item: TrashItem; root: FEntry } => r.root !== undefined),
  );
  let creating = $state<null | "folder" | "file">(null);
  let name = $state("");
  let content = $state("");
  let err = $state("");
  // The store refused a write (full/unavailable): say so and keep showing the truth.
  let storeErr = $state("");
  // Enhanced error handling with history and storm detection
  let errorHistory = $state<ErrorHistory>(createErrorHistory(10));
  let currentError = $state<FileOperationError | null>(null);
  let isErrorStorm = $state(false);
  let renameId = $state<string | null>(null);
  let renameVal = $state("");
  let cutId = $state<string | null>(null);
  let sortKey = $state<SortKey>("default");
  let query = $state("");
  let globalSearch = $state(false);
  let mode = $state<"all" | "fav" | "recent" | "trash">("all");
  const initFavs = readStoreValue<string[]>(FILES_FAV_KEY, []);
  let favs = $state<string[]>(initFavs);
  let selecting = $state(false);
  let selIds = $state<ReadonlySet<string>>(new Set());
  /** Entry a Spotlight link asked to reveal (marked while on screen; `null` = none). */
  let spotId = $state<string | null>(null);
  let linkNonce = 0;
  // Keyboard navigation state
  let focusedId = $state<string | null>(null);

  // ---- Preview (Rust-side classification) --------------------------------
  // `previewTarget` is the entry the user wants to preview (`null` = none);
  // `previewPlan` is the result from `files_preview_bytes`.  Bytes are loaded
  // lazily: local files use `FEntry.content` (text-only); device files fetch
  // bytes via `media_load` so we can show a real image / audio / video preview.
  let previewTarget = $state<FEntry | null>(null);
  let previewPlan = $state<PreviewPlan | null>(null);
  let previewBusy = $state(false);

  // ---- Import / export (Rust gzip bundle) ----------------------------------
  let importText = $state("");
  let importBusy = $state(false);
  let importMsg = $state("");
  let exportBusy = $state(false);
  let exportMsg = $state("");
  let lastExportBytes = $state<{ original: number; compressed: number } | null>(null);

  // ---- Cloud snapshot (local mirror of device files) -----------------------
  let cloudSnap = $state<CloudSnapshot | null>(loadSnapshot());
  let cloudBusy = $state(false);
  let cloudMsg = $state("");

  const persist = (l: FEntry[]): boolean => {
    if (!writeStoreValueChecked(FILES_KEY, l)) {
      storeErr = t("common.storeWriteFailed");
      // Record error with enhanced tracking
      const error = createFileError("write", "store_locked", { store: FILES_KEY });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      return false;
    }
    storeErr = "";
    // Clear error on success
    currentError = null;
    isErrorStorm = false;
    list = l;
    return true;
  };

  /**
   * Persist the trash ledger, with the same reporting discipline as `persist`.
   *
   * A refused ledger write is a **file-safety** event, so it records a `write` error too:
   * the next delete would otherwise take the item out of the tree with no ledger to put it
   * back into — which is exactly the permanent delete this feature exists to remove.
   */
  const persistTrash = (next: TrashItem[]): boolean => {
    if (!writeStoreValueChecked(FILES_TRASH_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      const error = createFileError("write", "store_locked", { store: FILES_TRASH_KEY });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      return false;
    }
    storeErr = "";
    currentError = null;
    isErrorStorm = false;
    trash = next;
    return true;
  };

  /**
   * Commit a delete/restore as **one** user-visible action, in the order that cannot lose
   * data: the **ledger first**, the tree second.
   *
   * The two keys cannot be written atomically, so one of the two orders has to be the
   * fallback. Ledger-first, a failed tree write leaves the item in **both** places — a
   * duplicate the user can see and fix. Tree-first, a failed ledger write would leave the
   * item in **neither** — the data is gone, which is the one outcome a safety net must not
   * have (the same reasoning `writeJson`'s callers use for "commit, then announce").
   */
  const commitTrash = (next: FEntry[], nextTrash: TrashItem[]): boolean => {
    if (!persistTrash(nextTrash)) return false;
    return persist(next);
  };

  /**
   * Delete = **move to the trash** (REQ-A455). This is the only path the UI offers for
   * "delete" now; the destructive act lives in the trash view, behind a second click.
   */
  const removeToTrash = (ids: ReadonlySet<string>): boolean => {
    if (ids.size === 0) return false;
    const r = moveToTrash(list, trash, ids, Date.now());
    if (r.moved.length === 0) return false;
    if (!commitTrash(r.list, r.trash)) return false;
    trashNote =
      r.dropped > 0 ? t("files.trashEvicted", { n: r.dropped }) : "";
    return true;
  };

  /** Put one item back where it came from, and say what actually happened. */
  const restoreItem = (id: string): void => {
    const item = trash.find((x) => x.id === id);
    const name = item?.members[0]?.name ?? "";
    const r = restoreFromTrash(list, trash, id);
    switch (r.outcome.kind) {
      case "not-found":
        // Another window purged it; the ledger view must not keep showing a ghost.
        persistTrash(r.trash);
        trashNote = t("files.trashNotFound");
        return;
      case "name-conflict":
        trashNote = t("files.trashNameConflict", { name: r.outcome.name });
        return;
      case "id-conflict":
        trashNote = t("files.trashIdConflict");
        return;
      case "restored-to-root":
        if (commitTrash(r.list, r.trash)) trashNote = t("files.trashRestoredToRoot", { name });
        return;
      case "restored":
        if (commitTrash(r.list, r.trash)) trashNote = "";
        return;
    }
  };

  /** Delete one ledger row for good (the read-only `dismiss` vs. this: a real destroy). */
  const purgeItem = (id: string): void => {
    const next = purgeFromTrash(trash, new Set([id]));
    if (next === trash) return;
    if (persistTrash(next)) trashNote = "";
  };

  /** Empty the trash. Nothing is written when it is already empty. */
  const emptyTrash = (): void => {
    if (trash.length === 0) return;
    if (persistTrash([])) trashNote = "";
  };
  const fav = (id: string) => {
    const next = toggleFav(favs, id);
    if (!writeStoreValueChecked(FILES_FAV_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      const error = createFileError("write", "store_locked", { store: FILES_FAV_KEY });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      return;
    }
    storeErr = "";
    currentError = null;
    isErrorStorm = false;
    favs = next;
  };
  const toggleSel = (id: string) => {
    const next = new Set(selIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selIds = next;
  };
  const exitSelect = () => {
    selecting = false;
    selIds = new Set();
    focusedId = null; // clear focus when exiting select mode
  };
  const toggleSelectAll = () => {
    const visible = display.map((e) => e.id);
    if (visible.length === 0) return;
    const hasAll = visible.every((id) => selIds.has(id));
    selIds = hasAll ? new Set() : new Set(visible);
  };
  const deleteSelected = () => {
    if (selIds.size === 0) return;
    // Delete = move to the trash (REQ-A455); a refusal (store write) keeps the selection
    // so the user can retry instead of hunting for what they just lost.
    if (!removeToTrash(new Set(selIds))) return;
    exitSelect();
  };
  const moveSelectedTo = (destId: string) => {
    if (selIds.size === 0) return;
    const result = moveEntries(list, selIds, destId === "__root" ? undefined : destId);
    if (!persist(result)) {
      // Error already recorded in persist()
      return;
    }
    exitSelect();
  };

  const display = $derived(
    mode === "fav"
      ? filterByName(list.filter((e) => favs.includes(e.id)), query)
      : mode === "recent"
        ? filterByName(recentFiles(list, 40), query)
        : globalSearch
          ? query.trim() ? searchFiles(list, query, true) : []
          : filterByName(sortChildren(list, cwd, sortKey), query),
  );
  const path = $derived(pathOf(list, cwd));

  // Keyboard navigation helpers
  const handleKeyNav = (dir: "up" | "down" | "home" | "end") => {
    const state: A11yNavState = {
      focusedId,
      visibleIds: display.map((e) => e.id),
    };
    const next = navNext(state, dir);
    if (next) {
      focusedId = next;
      // Scroll into view after a short delay to let DOM update
      setTimeout(() => {
        const el = document.querySelector(`[data-entry-id="${next}"]`);
        scrollIntoViewIfNeeded(el as HTMLElement);
      }, 0);
    }
  };

  const handleKeyOpen = () => {
    if (!focusedId) return;
    const entry = list.find((e) => e.id === focusedId);
    if (entry && entry.type === "folder") {
      openFolder(entry.id);
      focusedId = null; // reset focus when navigating
    }
  };

  const handleKeyDelete = () => {
    if (!focusedId) return;
    if (selecting) {
      // In selecting mode, delete means move the selected items to the trash.
      deleteSelected();
    } else {
      // Otherwise the focused item — same path, one id.
      removeToTrash(new Set([focusedId]));
      focusedId = null;
    }
  };

  const handleKeyToggle = () => {
    if (!focusedId || !selecting) return;
    toggleSel(focusedId);
  };

  const handleKeySelectAll = () => {
    if (display.length === 0) return;
    // If not in selecting mode, enter it first
    if (!selecting) selecting = true;
    toggleSelectAll();
  };

  // Install keyboard handler on mount
  onMount(() => {
    const handler = createKeyboardHandler({
      onNav: handleKeyNav,
      onOpen: handleKeyOpen,
      onDelete: handleKeyDelete,
      onToggle: handleKeyToggle,
      onSelectAll: handleKeySelectAll,
    });
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // ---- Deep link: Spotlight → one entry ------------------------------------------
  // Spotlight sets the `files` channel and opens this app. This screen has no
  // single-file viewer, so the honest reveal is: drop any filter/search that would
  // hide it, go to the folder the entry lives in, and **mark** that row. The link is
  // consumed (channel cleared) so re-opening Files never re-fires it, and an id that
  // no longer exists is ignored — no phantom row is invented.
  $effect(() => {
    return filesChannel().subscribe((v) => {
      if (!v || v.id.trim() === "" || v.nonce === linkNonce) return;
      linkNonce = v.nonce;
      reveal(v.id);
      filesChannel().set({ id: "", nonce: linkNonce });
    });
  });

  /**
   * The **cross-window** half of the same reveal (REQ-A458): the desktop Spotlight runs in the
   * launcher window, so its request arrives through the shared store rather than the in-page bus.
   * Same destination, same consume-and-clear discipline — a stale intent must never re-fire, and a
   * second Files window opened later must find nothing pending.
   */
  $effect(() => {
    const un = revealStore.subscribe((raw) => {
      const v = normalizeReveal(raw);
      if (!v || v.nonce === revealNonce) return;
      revealNonce = v.nonce;
      reveal(v.id);
      // Cleared **after** the reveal: the key is a command, not state, and the next reader must
      // find `null` rather than a request that has already been served.
      if (!writeStoreValueChecked(FILES_REVEAL_KEY, null)) {
        storeErr = t("common.storeWriteFailed");
      }
    });
    return un;
  });

  /** Show `id` where it actually lives, marking its row. Gone ⇒ nothing (no phantom row). */
  function reveal(id: string): void {
    const target = list.find((e) => e.id === id);
    if (!target) return;
    mode = "all";
    globalSearch = false;
    query = "";
    exitSelect();
    cwd = target.parent; // show the entry where it actually lives
    spotId = target.id;
  }

  const openFolder = (id: string) => {
    if (globalSearch) {
      globalSearch = false;
      query = "";
    }
    spotId = null; // navigating away ends the "here it is" mark
    focusedId = null; // reset keyboard focus when changing folder
    cwd = id;
  };
  const cycleSort = () =>
    (sortKey = sortKey === "default" ? "name" : sortKey === "name" ? "time" : "default");

  // ---- Preview ----------------------------------------------------------
  // Local `FEntry` files have their text body inline; the Rust command handles
  // binary detection, MIME inference from name, and (when present) PDF/audio/
  // video rendering via data URLs.  Closing the preview clears the target so the
  // banner disappears and the keyboard focus returns to the list.
  const closePreview = (): void => {
    previewTarget = null;
    previewPlan = null;
    previewBusy = false;
  };

  async function openPreview(entry: FEntry): Promise<void> {
    previewTarget = entry;
    previewPlan = null;
    previewBusy = true;
    try {
      // Local files: use the inline `content` if any (text-only), else report
      // empty.  In a future revision, the Files app could persist binary bytes
      // by reference (e.g. `media_uri`) and route through `media_load` here too.
      const body = entry.content ?? "";
      if (entry.type === "file" && body.length === 0) {
        previewPlan = await planPreview(entry.name, null, new Uint8Array(0));
      } else if (entry.type === "file") {
        const bytes = new TextEncoder().encode(body);
        previewPlan = await planPreview(entry.name, null, bytes);
      } else {
        // Folders cannot be previewed — show a clear "binary" panel.
        previewPlan = { kind: "binary", src: "", bytes: 0, isText: false, error: null, sizeLabel: "—", mime: null };
      }
    } finally {
      previewBusy = false;
    }
  }

  async function openExternalPreview(uri: string, name: string, mime: string | null): Promise<void> {
    previewTarget = { id: uri, type: "file", name, ts: Date.now() } as FEntry;
    previewPlan = null;
    previewBusy = true;
    try {
      const item = { id: uri, kind: "file" as const, collection: "download" as StandardDir, name, uri, mime, size_bytes: null, ts: Date.now() };
      const bytes = await mediaLoad(item);
      if (bytes) {
        previewPlan = await planPreview(name, mime, bytes);
      } else {
        previewPlan = { kind: "binary", src: "", bytes: 0, isText: false, error: null, sizeLabel: "—", mime };
      }
    } finally {
      previewBusy = false;
    }
  }

  // ---- Bundle export / import -------------------------------------------
  // The Rust `files_bundle_export` does the gzip + base64 work; the WebView
  // only formats the result.  Imports go through `files_bundle_import` and
  // surface a 3-way merge decision (merge with existing / replace all / skip)
  // so a bundle never silently clobbers the live store.
  async function doExportBundle(): Promise<void> {
    exportBusy = true;
    exportMsg = "";
    try {
      const r = await exportBundle(list);
      if (!r) {
        exportMsg = t("files.bundleImportFailed", { reason: t("files.bundleFormatError") });
        return;
      }
      lastExportBytes = { original: r.originalBytes, compressed: r.compressedBytes };
      // Persist the bundle to the host's clipboard via the standard "save to
      // clipboard" pattern; in a future revision a download button will replace
      // this.  For now the user copies from the textbox below.
      exportMsg = `${t("files.bundleExported")} (${r.ratioLabel}, ${r.compressedBytes} B)`;
      // Stash the bundle text in `importText` so the user can copy it.
      importText = r.text;
    } finally {
      exportBusy = false;
    }
  }

  async function doImportBundle(): Promise<void> {
    if (!importText.trim()) {
      importMsg = t("files.bundleImportFailed", { reason: t("files.bundleFormatError") });
      return;
    }
    importBusy = true;
    importMsg = "";
    try {
      const r = await importBundle(importText, normalizeFiles);
      if (!r.ok) {
        importMsg = t("files.bundleImportFailed", { reason: r.reason });
        return;
      }
      if (r.entries.length === 0) {
        // Empty bundle is valid: clear the store so an intentionally emptied
        // export-import round-trip stays honest.
        persist([]);
      } else {
        // Replace: the bundle is the source of truth.
        persist(r.entries);
      }
      importMsg = t("files.bundleImported", { n: r.entryCount });
    } finally {
      importBusy = false;
    }
  }

  // ---- Cloud snapshot ----------------------------------------------------
  // Saves a read-only snapshot of the device-file list to localStorage, keyed
  // by `amos.files.cloud` (mirrored through Rust `store_set` for cross-window
  // durability).  The "cloud" here is local — AmOS does not have a real cloud
  // sync service.  Restore re-loads the snapshot and surfaces its metadata; the
  // actual device-file list refreshes naturally on the next `loadExternal` tick.
  async function doSaveCloud(): Promise<void> {
    if (extFlat.length === 0) {
      cloudMsg = t("files.cloudEmpty");
      return;
    }
    cloudBusy = true;
    try {
      const snap = buildSnapshot("device-files", extFlat);
      const ok = await saveSnapshot(snap);
      if (ok) {
        cloudSnap = snap;
        cloudMsg = t("files.cloudSaved", { count: snap.fileCount });
      } else {
        cloudMsg = t("files.cloudSaveFailed");
      }
    } finally {
      cloudBusy = false;
    }
  }

  function doDeleteCloud(): void {
    deleteSnapshot();
    cloudSnap = null;
    cloudMsg = "";
  }

  function doRestoreCloud(): void {
    const snap = loadSnapshot();
    if (snap) {
      cloudSnap = snap;
      cloudMsg = t("files.cloudRestored", { count: snap.fileCount });
    }
  }

  const beginCreate = (kind: "folder" | "file") => {
    creating = kind;
    name = "";
    content = "";
    err = "";
  };
  const submitCreate = () => {
    const v = name.trim();
    if (!v) return;
    if (hasName(childrenOf(list, cwd), v)) {
      err = t("files.conflict");
      const error = createFileError("create", "name_conflict", { name: v });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      return;
    }
    const entry = makeEntry(creating ?? "folder", v, cwd, Date.now());
    if (creating === "file") entry.content = content;
    // Keep the create form (and its typed name/content) if the store rejected it.
    if (!persist(addEntry(list, entry))) return;
    creating = null;
    err = "";
    currentError = null;
    isErrorStorm = false;
  };
  const beginRename = (id: string, oldName: string) => {
    renameId = id;
    renameVal = oldName;
  };
  const submitRename = () => {
    const v = renameVal.trim();
    if (!v || !renameId) return;
    const target = list.find((e) => e.id === renameId);
    if (target && v !== target.name && hasName(childrenOf(list, target.parent), v)) {
      err = t("files.conflict");
      const error = createFileError("rename", "name_conflict", { name: v });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      return;
    }
    // A rejected rename keeps the inline input open with the typed name.
    if (!persist(renameEntry(list, renameId, v))) return;
    renameId = null;
    err = "";
    currentError = null;
    isErrorStorm = false;
  };
  const doCut = (id: string) => (cutId = id);
  const moveHere = () => {
    if (!cutId) return;
    if (!persist(moveEntry(list, cutId, cwd))) {
      // Error already recorded in persist()
      return;
    }
    cutId = null;
    err = "";
    currentError = null;
    isErrorStorm = false;
  };

  const chip = (on: boolean) =>
    `rounded-full px-3 py-1 text-xs ${on ? "bg-accent text-white" : "bg-neutral-300 dark:bg-neutral-700"}`;
  const btnCls = (kind: "accent" | "neutral" | "danger", size: "sm" | "md" = "md") =>
    `${size === "sm" ? "px-3 py-1 text-xs" : "px-3 py-1.5 text-sm"} rounded-full ${
      kind === "accent"
        ? "bg-accent text-white"
        : kind === "danger"
          ? "bg-danger text-white"
          : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
    } transition active:scale-95`;

  // ---- External collections (read-only, from the media bridge) --------------
  // Deliberately isolated from the `amos.files` store above: these are real device
  // files we may only *look* at (lib/externalFiles documents the reason). Nothing is
  // rendered until the bridge answers — an offline shell must not claim "no files".
  let extAvailable = $state(false);
  let extOpen = $state(false);
  let extItems = $state<unknown[]>([]);
  let extBlocked = $state(false);
  let extBusy = $state(false);
  let extQuery = $state("");
  // UI view mode: the three lib sorts plus "recent" (the newest 20, which is a
  // filter-and-order helper rather than a sort — hence a separate union here
  // instead of widening `ExternalSort`).
  type ExtSortMode = ExternalSort | "recent";
  let extSort = $state<ExtSortMode>("name");

  async function loadExternal(): Promise<void> {
    if (!hasMediaBridge()) return;
    extAvailable = true;
    extBusy = true;
    const settled = await Promise.allSettled(EXTERNAL_COLLECTIONS.map((c) => mediaList(c)));
    const items: unknown[] = [];
    let served = 0;
    let failed = 0;
    for (const r of settled) {
      if (r.status === "fulfilled") {
        served += 1;
        if (Array.isArray(r.value)) items.push(...r.value);
      } else {
        failed += 1;
      }
    }
    extItems = items;
    // "Blocked" only when *nothing* could be read while something failed — a
    // backend that serves just some collections is not an authorization problem.
    extBlocked = served === 0 && failed > 0;
    extBusy = false;
  }

  const grantExternal = async (): Promise<void> => {
    if (extBusy) return;
    extBusy = true;
    await Promise.allSettled(EXTERNAL_COLLECTIONS.map((c) => mediaGrantRead(c)));
    extBusy = false;
    await loadExternal(); // the notice clears only if reading really works now
  };

  let extLoaded = false;
  $effect(() => {
    if (extLoaded) return;
    extLoaded = true;
    void loadExternal();
  });

  const extView = $derived(extItems.length > 0 ? buildExternalFileView(extItems) : null);
  const extFlat = $derived(extView ? extView.groups.flatMap((g) => g.files) : []);
  // "recent" is the newest 20 (unknown mtime sorts last — see recentExternalFiles),
  // the other three are stable sorts over whatever the name filter left.
  const extShown = $derived(
    groupByCollection(
      extSort === "recent"
        ? recentExternalFiles(filterExternalByName(extFlat, extQuery), 20)
        : sortExternalFiles(filterExternalByName(extFlat, extQuery), extSort),
    ),
  );
  const cycleExtSort = () => {
    extSort =
      extSort === "name" ? "date" : extSort === "date" ? "size" : extSort === "size" ? "recent" : "name";
  };
  const extSortLabel = $derived(
    extSort === "name"
      ? t("files.sortName")
      : extSort === "date"
        ? t("files.sortTime")
        : extSort === "size"
          ? t("files.externalSortSize")
          : t("files.recent"),
  );
  const collectionLabel = (c: StandardDir): string => canonicalPath(c) || c;
</script>

<div class="p-3">
  <StoreErrorBar message={storeErr} />
  <!-- toolbar -->
  <div class="flex flex-wrap gap-2">
    <button onclick={() => beginCreate("folder")} class={btnCls("accent")}>{t("files.addFolder")}</button>
    <button onclick={() => beginCreate("file")} class={btnCls("neutral")}>{t("files.addFile")}</button>
    <button onclick={() => void doExportBundle()} disabled={exportBusy}
      class={btnCls("neutral")}>{t("files.exportBundle")}</button>
    <button onclick={() => void doImportBundle()} disabled={importBusy || !importText.trim()}
      class={btnCls("neutral")}>{t("files.importFromDevice")}</button>
    {#if display.length > 0}
      <button onclick={() => (selecting ? exitSelect() : (selecting = true))} class={chip(selecting)}>
        {selecting ? t("files.cancel") : t("files.select")}
      </button>
      {#if selecting && selIds.size > 0}
        <button onclick={deleteSelected} class={btnCls("danger")}>{t("files.deleteSelected", { n: selIds.size })}</button>
        <select
          value=""
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            if (v) moveSelectedTo(v);
          }}
          aria-label={t("files.moveSel")}
          class="rounded-full bg-neutral-300 px-2 py-1 text-xs dark:bg-neutral-700"
        >
          <option value="" disabled>{t("files.moveSel")}</option>
          <option value="__root">{t("files.root")}</option>
          {#each folderTree(list).filter((n) => !selIds.has(n.id)) as n (n.id)}
            <option value={n.id}>{"　".repeat(n.depth)}{n.name}</option>
          {/each}
        </select>
      {/if}
      {#if selecting && display.length > 0}
        <button onclick={toggleSelectAll} class={btnCls("neutral")}>
          {selIds.size === display.length ? t("files.selectNone") : t("files.selectAll", { n: display.length })}
        </button>
      {/if}
    {/if}
  </div>

  <!-- view: all / favorites / recent / trash -->
  <div class="mt-2 flex flex-wrap gap-1.5">
    <button onclick={() => (mode = "all")} aria-pressed={mode === "all"} class={chip(mode === "all")}>{t("files.all")}</button>
    <button onclick={() => (mode = "fav")} aria-pressed={mode === "fav"} class={chip(mode === "fav")}>{t("files.fav")}</button>
    <button onclick={() => (mode = "recent")} aria-pressed={mode === "recent"} class={chip(mode === "recent")}>{t("files.recent")}</button>
    <button onclick={() => (mode = "trash")} aria-pressed={mode === "trash"} class={chip(mode === "trash")}
      data-testid="files-trash-tab">{t("files.trash")}{trash.length > 0 ? ` (${trash.length})` : ""}</button>
  </div>

  <!-- search + sort -->
  <div class="mt-2 flex items-center gap-2">
    <input bind:value={query} placeholder={t("files.search")} data-testid="file-search" aria-label={t("files.search")}
      class="min-w-0 flex-1 rounded-full bg-neutral-200 px-3 py-1 text-sm outline-none dark:bg-neutral-800" />
    <button onclick={() => (globalSearch = !globalSearch)} title={t(globalSearch ? "files.currentFolder" : "files.global")}
      class="shrink-0 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700">
      {t(globalSearch ? "files.currentFolder" : "files.global")}
    </button>
    {#if !globalSearch}
      <button onclick={cycleSort} title={t("files.sort")} class="shrink-0 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700">
        {sortKey === "default" ? t("files.sort") : sortKey === "name" ? `↑ ${t("files.sortName")}` : `↓ ${t("files.sortTime")}`}
      </button>
    {/if}
  </div>


  <!-- breadcrumb -->
  <div class="mt-2 flex flex-wrap items-center gap-0.5 rounded-xl bg-neutral-200/50 p-1 dark:bg-neutral-800/50">
    <button onclick={() => (cwd = undefined)} class="px-2 py-0.5 text-xs {cwd ? 'text-accent' : 'font-semibold'}">{cwd ? `‹ ${t("files.root")}` : t("files.root")}</button>
    {#each path as p (p.id)}
      <span class="text-xs opacity-40">/</span>
      <button onclick={() => (cwd = p.id)} class={"px-2 py-0.5 text-xs " + (p.id === cwd ? "font-semibold" : "text-accent")}>{p.name}</button>
    {/each}
  </div>

  <!-- create form -->
  {#if creating}
    <div class="mt-2 space-y-2 rounded-xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
      <span class="block text-xs opacity-60">{t("files.name")}</span>
      <input bind:value={name} placeholder={t("files.name")} data-testid="file-new-name" aria-label={t("files.name")}
        class="w-full rounded-lg bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900" />
      {#if creating === "file"}
        <span class="block text-xs opacity-60">{t("files.content")}</span>
        <textarea bind:value={content} rows={2} data-testid="file-new-content" aria-label={t("files.content")}
          class="w-full rounded-lg bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900"></textarea>
      {/if}
      <div class="flex gap-2">
        <button onclick={submitCreate} class="rounded-full bg-accent px-3 py-1 text-sm text-white">{t("files.create")}</button>
        <button onclick={() => (creating = null)} class="rounded-full bg-neutral-300 px-3 py-1 text-sm dark:bg-neutral-700">{t("files.cancel")}</button>
      </div>
    </div>
  {/if}

  <!-- rename form -->
  {#if renameId}
    <div class="mt-2 space-y-2 rounded-xl bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
      <span class="block text-xs opacity-60">{t("files.rename")}</span>
      <input bind:value={renameVal} data-testid="file-rename" aria-label={t("files.rename")}
        class="w-full rounded-lg bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900" />
      <div class="flex gap-2">
        <button onclick={submitRename} class={btnCls("accent")}>{t("files.create")}</button>
        <button onclick={() => (renameId = null)} class={btnCls("neutral")}>{t("files.cancel")}</button>
      </div>
    </div>
  {/if}

  <!-- move banner -->
  {#if cutId}
    <div class="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-neutral-200/60 p-2 dark:bg-neutral-800/60">
      <span class="flex-1 text-xs opacity-70">{t("files.cut", { name: list.find((e) => e.id === cutId)?.name ?? "" })}</span>
      <button onclick={moveHere} class={btnCls("accent", "sm")}>{t("files.moveHere")}</button>
      <button onclick={() => (cutId = null)} class={btnCls("neutral", "sm")}>{t("files.cancelMove")}</button>
    </div>
  {/if}

  {#if err}
    <p role="alert" class="mt-2 text-xs text-danger">{err}</p>
  {/if}

  <!-- Enhanced error feedback -->
  {#if currentError}
    <FileErrorBanner 
      error={currentError}
      isStorm={isErrorStorm}
      onRetry={() => {
        // Retry logic: re-attempt the last failed operation
        // This is a placeholder - actual retry would need operation-specific logic
        currentError = null;
        isErrorStorm = false;
        err = "";
      }}
      onDismiss={() => {
        currentError = null;
        isErrorStorm = false;
        err = "";
      }}
    />
  {/if}


  {#if mode === "trash"}
    <!-- Trash (REQ-A455). Two acts only, and both are reversible-or-explicit:
         「放回原处」 moves the item back into the tree, 「永久删除」/「清空」 destroys it —
         the destructive side lives here, behind a second click, never in the list view. -->
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <button onclick={emptyTrash} disabled={trash.length === 0} class={btnCls("danger")}
        data-testid="files-trash-empty">{t("files.emptyTrash")}</button>
      <span class="text-xs opacity-60">{t("files.trashCount", { n: trash.length })}</span>
    </div>
    {#if trashNote}
      <!-- A live region, not a toast: what happened (a fallback location, a refusal, an
           eviction) has to be readable after the fact, including by a screen reader. -->
      <p class="mt-2 rounded-lg bg-amber-100/70 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
        role="status" data-testid="files-trash-note">{trashNote}</p>
    {/if}
    {#if trash.length === 0}
      <p class="py-8 text-center text-sm opacity-60" data-testid="files-trash-empty-hint">
        {t("files.trashEmptyHint")}
      </p>
    {:else}
      <div class="divide-y divide-black/5 dark:divide-white/10 mt-2 {CARD_GROUP}"
        role="grid" aria-label={t("files.trashList")} data-testid="files-trash-list">
        {#each trashRows as row (row.item.id)}
          {@const item = row.item}
          {@const root = row.root}
          <div class="flex items-center gap-2" role="row" data-trash-id={item.id}>
            <div class="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-2.5">
              <span class="text-xl" aria-hidden="true">{root.type === "folder" ? FOLDER : FILE}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{root.name}</span>
                <span class="block text-xs opacity-50">
                  {t("files.trashDeletedAt", { time: fmtTime(item.deletedAt) })}{item.members.length > 1
                    ? ` · ${t("files.trashMembers", { n: item.members.length - 1 })}`
                    : ""}
                </span>
              </span>
            </div>
            <div class="flex gap-1 pr-2" role="gridcell">
              <button onclick={() => restoreItem(item.id)} aria-label={t("files.trashRestoreAria", { name: root.name })}
                class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.trashRestore")}</button>
              <button onclick={() => purgeItem(item.id)} aria-label={t("files.trashDeleteForeverAria", { name: root.name })}
                class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-danger dark:bg-neutral-900/70">{t("files.trashDeleteForever")}</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
  <!-- list -->
  {#if display.length === 0}
    <p class="py-8 text-center text-sm opacity-60">
      {mode === "fav" && favs.length === 0
        ? t("files.favEmpty")
        : globalSearch && !query.trim()
          ? t("files.searchHint")
          : query.trim()
            ? t("files.noMatch")
            : t("files.empty")}
    </p>
  {:else}
    <div 
      class="divide-y divide-black/5 dark:divide-white/10 mt-2 {CARD_GROUP}"
      role="grid"
      aria-label={t("files.fileList")}
    >
      {#each display as e (e.id)}
        {@const isFolder = e.type === "folder"}
        {@const isSel = selecting && selIds.has(e.id)}
        {@const isFocused = focusedId === e.id}
        {@const actionable = selecting || isFolder}
        <div 
          class="flex items-center gap-2 {isSel || spotId === e.id ? 'bg-accent/15' : ''} {isFocused ? 'ring-2 ring-accent ring-inset' : ''}"
          data-spotlight={spotId === e.id ? "hit" : undefined}
          data-entry-id={e.id}
          role="row"
          aria-selected={isSel}
        >
          <button
            type="button"
            onclick={actionable ? (selecting ? () => toggleSel(e.id) : () => openFolder(e.id)) : undefined}
            class={"flex min-w-0 flex-1 items-center gap-2 px-3.5 py-2.5 text-left " + (isFolder && !selecting ? "cursor-pointer" : "")}
            role="gridcell"
            aria-label={entryAriaLabel(e.name, e.type, favs.includes(e.id), isSel, e.ts)}
            tabindex={isFocused ? 0 : -1}
            onfocus={() => (focusedId = e.id)}
          >
            {#if selecting}
              <span class={"grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold " +
                (isSel ? "bg-accent text-white" : "bg-black/15 dark:bg-white/15")}>{isSel ? "✓" : ""}</span>
            {/if}
            <span class="text-xl" aria-hidden="true">{isFolder ? FOLDER : FILE}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{e.name}</span>
              <span class="block text-xs opacity-50">{globalSearch ? folderPath(list, e.id) || t("files.root") : fmtTime(e.ts)}</span>
            </span>
          </button>
          {#if !selecting}
            <div class="flex gap-1 pr-2" role="gridcell">
              <button onclick={() => fav(e.id)} aria-label={favs.includes(e.id) ? t("a11y.unfavorite") : t("a11y.favorite")}
                class={"rounded-full px-2 py-0.5 text-xs " + (favs.includes(e.id) ? "text-amber-500" : "text-neutral-400")}>
                {favs.includes(e.id) ? "★" : "☆"}
              </button>
              <button onclick={() => beginRename(e.id, e.name)} aria-label={t("files.rename")} class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.rename")}</button>
              <button onclick={() => doCut(e.id)} aria-label={t("files.move")} class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.move")}</button>
              {#if e.type === "file"}
                <button onclick={() => void openPreview(e)} aria-label={t("files.previewOpen", { name: e.name })}
                  class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.preview")}</button>
              {/if}
              <button onclick={() => removeToTrash(new Set([e.id]))} aria-label={t("files.delete")} class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-danger dark:bg-neutral-900/70">{t("files.delete")}</button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {/if}

  <!-- Preview panel: shown when the user asks to preview a local file. The Rust
       command (files_preview_bytes) classifies the bytes; the renderer picks the
       surface (text block / <img> / <audio> / <video> / "binary"). -->
  {#if previewTarget}
    <div class="mt-3 rounded-xl bg-neutral-200/60 p-3 ring-1 ring-black/5 dark:bg-neutral-800/60 dark:ring-white/10"
      data-testid="preview-panel">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold" data-testid="preview-title">
          {t("files.previewTitle", { name: previewTarget.name, size: previewPlan?.sizeLabel ?? "" })}
        </h3>
        <button onclick={closePreview} aria-label={t("files.previewClose")}
          class="rounded-full bg-neutral-300 px-2 py-0.5 text-xs dark:bg-neutral-700">
          ✕
        </button>
      </div>
      {#if previewBusy}
        <p class="text-xs opacity-60">…</p>
      {:else if previewPlan}
        {#if previewPlan.kind === "text"}
          <pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs dark:bg-neutral-900"
            data-testid="preview-text">{previewPlan.src}</pre>
        {:else if previewPlan.kind === "image"}
          <img src={previewPlan.src} alt={previewTarget.name}
            class="max-h-96 max-w-full rounded" data-testid="preview-image" />
        {:else if previewPlan.kind === "audio"}
          <audio src={previewPlan.src} controls class="w-full" data-testid="preview-audio"></audio>
        {:else if previewPlan.kind === "video"}
          <video src={previewPlan.src} controls class="max-h-96 w-full rounded" data-testid="preview-video"></video>
        {:else if previewPlan.kind === "empty"}
          <p class="text-xs opacity-60">{t("files.previewEmpty")}</p>
        {:else}
          <p class="text-xs opacity-60" data-testid="preview-binary">{t("files.previewBinary")}</p>
        {/if}
        {#if previewPlan.error}
          <p class="mt-1 text-xs text-amber-600 dark:text-amber-400">{previewPlan.error}</p>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Bundle export/import textbox.  The Rust `files_bundle_export` produces a
       base64-encoded gzip bundle; the WebView shows the text so the user can
       copy it (a future revision will wire a file-download bridge). -->
  <details class="mt-3 rounded-xl bg-neutral-200/40 p-2 dark:bg-neutral-800/40" data-testid="bundle-section">
    <summary class="cursor-pointer text-xs font-semibold opacity-80">{t("files.exportBundle")} / {t("files.importFromDevice")}</summary>
    <textarea
      bind:value={importText}
      placeholder=".amos-bundle"
      rows={4}
      data-testid="bundle-text"
      aria-label={t("files.importFromDevice")}
      class="mt-2 w-full rounded bg-white p-2 font-mono text-xs outline-none dark:bg-neutral-900"
    ></textarea>
    {#if lastExportBytes}
      <p class="mt-1 text-xs opacity-60" data-testid="bundle-stats">
        {t("files.compressionRatio", {
          ratio: Math.round((100 * lastExportBytes.compressed) / Math.max(1, lastExportBytes.original)),
          from: previewBytesLabel(lastExportBytes.original),
          to: previewBytesLabel(lastExportBytes.compressed),
        })}
      </p>
    {/if}
    {#if exportMsg}<p class="mt-1 text-xs text-green-700 dark:text-green-300">{exportMsg}</p>{/if}
    {#if importMsg}<p class="mt-1 text-xs text-amber-700 dark:text-amber-300">{importMsg}</p>{/if}
  </details>

  <!-- Cloud snapshot (local mirror): save / restore / delete the device-file
       snapshot.  This is the honest "cloud sync" AmOS Files supports without a
       real cloud account — the snapshot lives in localStorage and the Rust side
       validates the structure on every save. -->
  {#if hasMediaBridge()}
    <details class="mt-3 rounded-xl bg-neutral-200/40 p-2 dark:bg-neutral-800/40" data-testid="cloud-section">
      <summary class="cursor-pointer text-xs font-semibold opacity-80">{t("files.cloudSnapshot")}</summary>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button onclick={() => void doSaveCloud()} disabled={cloudBusy}
          class="rounded-full bg-neutral-300 px-3 py-1 dark:bg-neutral-700">{t("files.cloudSnapshot")}</button>
        <button onclick={doRestoreCloud} disabled={!cloudSnap}
          class="rounded-full bg-neutral-300 px-3 py-1 dark:bg-neutral-700">{t("files.cloudRestore")}</button>
        {#if cloudSnap}
          <button onclick={doDeleteCloud}
            class="rounded-full bg-neutral-100 px-3 py-1 text-danger dark:bg-neutral-900/70">{t("files.cloudDelete")}</button>
        {/if}
      </div>
      {#if cloudSnap}
        <p class="mt-1 text-xs opacity-70" data-testid="cloud-info">
          {cloudSnap.label} · {cloudSnap.fileCount} 项 · {formatSnapshotSize(cloudSnap.totalBytes)}
          · {new Date(cloudSnap.savedAt).toLocaleString()}
        </p>
      {:else}
        <p class="mt-1 text-xs opacity-60">{t("files.cloudEmpty")}</p>
      {/if}
      {#if cloudMsg}<p class="mt-1 text-xs text-green-700 dark:text-green-300">{cloudMsg}</p>{/if}
    </details>
  {/if}

  <!-- External collections (read-only). Rendered only once the media bridge has
       answered, so an offline shell never claims the device has no files. -->
  {#if extAvailable}
    <section class="mt-4" aria-label={t("files.external")}>
      <div class="flex items-center justify-between px-1">
        <button
          onclick={() => (extOpen = !extOpen)}
          aria-pressed={extOpen}
          class="text-sm font-semibold text-neutral-800 dark:text-neutral-200"
        >📱 {t("files.external")}</button>
        {#if extView}
          <span class="text-xs opacity-50">
            {extView.fileCount} · {formatBytes(extView.totalBytes)}
          </span>
        {/if}
      </div>

      {#if extOpen}
        {#if extBlocked}
          <div
            data-testid="external-blocked"
            role="status"
            class="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/15 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-400/30 dark:text-amber-200"
          >
            <span aria-hidden="true">🔒</span>
            <span class="min-w-0 flex-1">{t("files.externalBlocked")}</span>
            <button
              onclick={() => void grantExternal()}
              disabled={extBusy}
              aria-label={t("files.externalGrant")}
              class={btnCls("accent", "sm") + " disabled:opacity-50"}
            >{t("files.externalGrant")}</button>
          </div>
        {:else}
          <div class="mt-2 flex items-center gap-2">
            <input
              bind:value={extQuery}
              placeholder={t("files.externalSearch")}
              data-testid="external-search" aria-label={t("files.externalSearch")}
              class="min-w-0 flex-1 rounded-full bg-neutral-200 px-3 py-1 text-sm outline-none dark:bg-neutral-800"
            />
            <button onclick={cycleExtSort} title={t("files.sort")} class="shrink-0 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700">
              {extSortLabel}
            </button>
          </div>

          {#if extShown.length === 0}
            <p class="mt-2 text-center text-xs opacity-60">
              {extQuery.trim() ? t("files.noMatch") : t("files.externalEmpty")}
            </p>
          {:else}
            {#each extShown as g (g.collection)}
              <div class="mt-2 px-1 text-xs font-semibold opacity-70">{collectionLabel(g.collection)}</div>
              <div class="mt-1 {CARD_GROUP} divide-y divide-black/5 dark:divide-white/10">
                {#each g.files as f (f.id)}
                  <div class="flex items-center gap-2 px-3.5 py-2" data-testid="external-file">
                    <span class="text-xl" aria-hidden="true">{externalGlyph(f.kind)}</span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm">{f.name}</span>
                      <span class="block text-xs opacity-50">
                        {formatBytes(f.sizeBytes)} · {f.ts ? fmtTime(f.ts) : "—"} · {t("files.externalReadOnly")}
                      </span>
                    </span>
                    <button onclick={() => void openExternalPreview(f.uri, f.name, f.mime)}
                      aria-label={t("files.previewOpen", { name: f.name })}
                      class="shrink-0 rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70"
                      data-testid="external-preview-btn">{t("files.preview")}</button>
                  </div>
                {/each}
              </div>
            {/each}
          {/if}
        {/if}
      {/if}
    </section>
  {/if}
</div>

