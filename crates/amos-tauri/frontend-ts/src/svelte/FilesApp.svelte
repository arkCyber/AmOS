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
    FILES_VIEW_KEY,
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
    normalizeFavs,
    normalizeFiles,
    normalizeReveal,
    normalizeTrash,
    normalizeViewIntent,
    pathOf,
    purgeFromTrash,
    recentFiles,
    renameEntry,
    restoreFromTrash,
    searchFiles,
    sortChildren,
    toggleFav,
  } from "../lib/files";
  import type { FEntry, FilesView, SortKey, TrashItem } from "../lib/files";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import { openShareSheet } from "./shareSheetState.svelte";
  import { fileShare } from "../lib/shareSheet";
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
  import {
    planPreview,
    previewBytesLabel,
    previewUnavailablePlan,
    type PreviewPlan,
  } from "../lib/filesPreview";
  import { exportBundle, importBundle } from "../lib/filesCompression";
  import { buildSnapshot, deleteSnapshot, loadSnapshot, saveSnapshot, formatSnapshotSize, type CloudSnapshot } from "../lib/filesCloud";
  import {
    hostFsReadDir,
    hostFsRootStatus,
    hostFsWatchSubscribe,
    hostFsWatchUnsubscribe,
    hostFsCreateDir,
    hostFsWriteText,
    hostFsWriteBytes,
    hostFsStat,
    hostFsWatchList,
    hostFsRename,
    hostFsRemove,
    hostFsCopy,
    bytesToBase64,
    hostParent,
    normalizeHostDir,
    onHostFsEvent,
    type FsDirEntry,
    type FsStatResult,
  } from "../lib/hostFs";
  import { openHostFile } from "../lib/hostFileOpen";
  import { t } from "./locale.svelte";
  import { filesChannel } from "./appLinks";
  import { masterDetail } from "../lib/formLayout";
  import { layoutSnap } from "./shellState.svelte";
  import { onDestroy, onMount } from "svelte";
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
   * The cross-window **view** intent (REQ-A783) — the Dock's trash tile's route into this window.
   *
   * Subscribed exactly like the reveal above, and for the same reasons (a request written before
   * this window existed is picked up from the store's initial value; a request that arrives while
   * it is open lands immediately). Kept as a *second* intent rather than folded into the reveal
   * because the two say different things: a reveal names an entry to navigate to, a view names one
   * of the four screens — and a caller that only wants "the trash" has no entry to name.
   */
  const viewStore = createStoreValue<unknown>(FILES_VIEW_KEY, null);
  /** Highest view nonce this window has served (asking for the same view twice still fires). */
  let viewNonce = 0;
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
  /**
   * What 重试 actually re-runs (REQ-A468).
   *
   * The banner used to be handed a handler that only *cleared the error*, so 重试 and 关闭 were
   * the same button: the failure looked resolved and nothing was attempted again. Each failure
   * site now captures a thunk that re-enters **its own** user action with the same arguments, and
   * `null` means there is nothing to retry — in which case the banner must not offer one.
   */
  let retryAction = $state<(() => void) | null>(null);
  let renameId = $state<string | null>(null);
  let renameVal = $state("");
  let cutId = $state<string | null>(null);
  let sortKey = $state<SortKey>("default");
  let query = $state("");
  let globalSearch = $state(false);
  let mode = $state<FilesView>("all");
  const initFavs = normalizeFavs(readStoreValue<unknown>(FILES_FAV_KEY, []));
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
  // bytes via `media_load`; host-filesystem files fetch bytes through
  // `lib/hostFileOpen.ts` when the host says the file is not text (REQ-A971),
  // so a photo in the host browser reaches the same `<img>` a device photo does.
  let previewTarget = $state<FEntry | null>(null);
  let previewPlan = $state<PreviewPlan | null>(null);
  let previewBusy = $state(false);
  // The **host read**'s truncation flag for the file in the preview panel, which is a
  // different fact from `previewPlan.error` (the preview command's own cap). Kept beside the
  // plan rather than folded into it so the notice renders in this view's own language.
  let previewTrunc = $state(false);

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
  /** The **success** line (「已保存 ∕ 已恢复」). Green; a refusal must not land here. */
  let cloudMsg = $state("");
  /**
   * The **refusal** line, its own slot (REQ-A1439 / FMEA F-SH-697). The "cloud" here is
   * one key — `amos.files.cloud` — and both verbs that write it (save, delete) can be
   * refused: `saveSnapshot` returns `false` when `setItem` throws, and `deleteSnapshot`
   * returns `false` when `removeItem` throws (storage unavailable — the arm
   * `removeStoreValue` logs for exactly this). The save path always read its verdict;
   * the delete path discarded it and blanked the panel anyway, so a refused delete drew
   * 「尚未保存快照」 over a snapshot still on disk (it comes back next launch, and 恢复
   * works again). A refusal also must not be printed in the success colour, which is why
   * this is a separate slot rather than more text in `cloudMsg`.
   */
  let cloudErr = $state("");

  const persist = (l: FEntry[], retry?: () => void): boolean => {
    if (!writeStoreValueChecked(FILES_KEY, l)) {
      storeErr = t("common.storeWriteFailed");
      // Record error with enhanced tracking
      const error = createFileError("write", "store_unavailable", { store: FILES_KEY });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      // 重试 re-enters the caller's own action (REQ-A468); `undefined` ⇒ the banner shows 关闭 only.
      retryAction = retry ?? null;
      return false;
    }
    storeErr = "";
    // Clear error on success
    currentError = null;
    isErrorStorm = false;
    retryAction = null;
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
  const persistTrash = (next: TrashItem[], retry?: () => void): boolean => {
    if (!writeStoreValueChecked(FILES_TRASH_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      const error = createFileError("write", "store_unavailable", { store: FILES_TRASH_KEY });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      retryAction = retry ?? null;
      return false;
    }
    storeErr = "";
    currentError = null;
    isErrorStorm = false;
    retryAction = null;
    trash = next;
    return true;
  };

  /**
   * Commit a delete/restore as **one** user-visible action, ordering the two writes so a
   * partial failure can only ever *duplicate* the item, never lose it.
   *
   * The two keys cannot be written atomically, so one order has to be the fallback. The safe
   * order is always **the store that gains the item before the store that drops it**: if the
   * gaining write lands and the dropping write is refused, the item is in **both** places — a
   * duplicate the user can see and fix. Writing the dropping store first, a refused gaining
   * write leaves the item in **neither** — the data is gone, which is the one outcome a safety
   * net must not have.
   *
   * That ordering is **not the same for the two directions**, which is why there are two
   * functions rather than one shared sequence:
   *
   *   • **delete** — `moveToTrash` puts the item in the ledger and takes it out of the tree,
   *     so the ledger gains it ⇒ ledger first (`commitDelete`);
   *   • **restore** — `restoreFromTrash` takes it out of the ledger and puts it in the tree,
   *     so the tree gains it ⇒ tree first (`commitRestore`).
   *
   * A single fixed order therefore protects one direction and silently loses data on the
   * other.
   */
  const commitDelete = (next: FEntry[], nextTrash: TrashItem[], retry?: () => void): boolean => {
    if (!persistTrash(nextTrash, retry)) return false;
    return persist(next, retry);
  };

  /**
   * Commit a **restore** — the mirror of `commitDelete`, and the reason one order cannot serve
   * both. The tree gains the item, so it is written first; a refused ledger write then leaves
   * the item in both places (a duplicate), never in neither.
   */
  const commitRestore = (next: FEntry[], nextTrash: TrashItem[], retry?: () => void): boolean => {
    if (!persist(next, retry)) return false;
    // The tree has the item now; only the ledger write is left, so its retry re-attempts
    // **that** — re-entering `restoreItem` with the item already back in the tree would report
    // a bogus id-conflict and finish nothing.
    const retryLedger = (): void => {
      persistTrash(nextTrash, retryLedger);
    };
    return persistTrash(nextTrash, retryLedger);
  };

  /**
   * Delete = **move to the trash** (REQ-A455). This is the only path the UI offers for
   * "delete" now; the destructive act lives in the trash view, behind a second click.
   */
  const removeToTrash = (ids: ReadonlySet<string>): boolean => {
    if (ids.size === 0) return false;
    const r = moveToTrash(list, trash, ids, Date.now());
    if (r.moved.length === 0) return false;
    // The retry re-enters this same action with the same ids: the selection is unchanged by a
    // refused write, so re-running is what the user asked for when they pressed 重试.
    if (!commitDelete(r.list, r.trash, () => void removeToTrash(ids))) return false;
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
        persistTrash(r.trash, () => restoreItem(id));
        trashNote = t("files.trashNotFound");
        return;
      case "name-conflict":
        trashNote = t("files.trashNameConflict", { name: r.outcome.name });
        return;
      case "id-conflict":
        trashNote = t("files.trashIdConflict");
        return;
      case "restored-to-root":
        if (commitRestore(r.list, r.trash, () => restoreItem(id)))
          trashNote = t("files.trashRestoredToRoot", { name });
        return;
      case "restored":
        if (commitRestore(r.list, r.trash, () => restoreItem(id))) trashNote = "";
        return;
    }
  };

  /** Delete one ledger row for good (the read-only `dismiss` vs. this: a real destroy). */
  const purgeItem = (id: string): void => {
    const next = purgeFromTrash(trash, new Set([id]));
    if (next === trash) return;
    if (persistTrash(next, () => purgeItem(id))) trashNote = "";
  };

  /** Empty the trash. Nothing is written when it is already empty. */
  const emptyTrash = (): void => {
    if (trash.length === 0) return;
    if (persistTrash([], () => emptyTrash())) trashNote = "";
  };
  const fav = (id: string) => {
    const next = toggleFav(favs, id);
    if (!writeStoreValueChecked(FILES_FAV_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      const error = createFileError("write", "store_unavailable", { store: FILES_FAV_KEY });
      errorHistory = addError(errorHistory, error);
      currentError = error;
      isErrorStorm = detectErrorStorm(errorHistory);
      retryAction = () => fav(id);
      return;
    }
    storeErr = "";
    currentError = null;
    isErrorStorm = false;
    retryAction = null;
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
    if (!selecting || display.length === 0) return;
    selIds = allShownSelected ? new Set() : new Set(display.map((e) => e.id));
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
    if (!persist(result, () => moveSelectedTo(destId))) {
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
  /**
   * Is every row currently *shown* selected? (REQ-A1081) — declared **after** `display`, which it
   * reads: a `$derived` is evaluated where it stands, not when a caller reaches it.
   *
   * The select-all chip's label and its action both read this **same** predicate. They used to
   * answer the question twice — the action by membership (`display.every(id => selIds.has(id))`),
   * the label by count (`selIds.size === display.length`) — and the two disagree the moment
   * `selIds` holds an id that is no longer on screen. That is the normal case, not an edge: the
   * selection deliberately survives a view switch (`applyView`'s own comment) and a search edit
   * (only `query` changes), so selecting 文档 and then typing a query that matches only 说明.txt
   * leaves |selIds| === |display| while *nothing* shown is selected. The chip then read 「全不选」
   * and pressing it **selected** — a control promising the opposite of what it does.
   */
  const allShownSelected = $derived(
    display.length > 0 && display.every((e) => selIds.has(e.id)),
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

  /**
   * ⌘Y — Quick Look for the focused row (REQ-A789).
   *
   * Preview used to be reachable **only** through the per-row 「预览」 button, so a keyboard-only
   * user could not look at a file at all while every neighbouring action (navigate, open,
   * delete, toggle, select-all) had a key. The key is ⌘Y rather than Space because Space is
   * this listbox's selection toggle — see `lib/filesA11y.ts` for the full reasoning.
   *
   * A folder has nothing to preview, so ⌘Y leaves folders alone instead of opening an empty
   * panel that claims the folder has no content (a preview panel saying "binary" about a
   * directory is exactly the kind of screen that lies).
   */
  const handleKeyQuickLook = () => {
    if (!focusedId) return;
    const entry = display.find((e) => e.id === focusedId);
    if (entry && entry.type === "file") void openPreview(entry);
  };

  /**
   * Enter on a **file** — the dead key this round removed.
   *
   * `onOpen` is documented as "Enter on focused item", but the handler only ever acted on
   * folders: pressing Enter on a file did nothing at all, silently. That is F-SH-001 inside the
   * keyboard contract — a key advertised as "open" that opens nothing. In this app "open" for a
   * file has exactly one honest meaning, because there is no editor or single-file viewer
   * route: look at it. So a file opens its preview, the same destination ⌘Y reaches.
   */
  const handleKeyOpen = () => {
    if (!focusedId) return;
    const entry = display.find((e) => e.id === focusedId);
    if (!entry) return;
    if (entry.type === "folder") {
      openFolder(entry.id);
      focusedId = null; // reset focus when navigating
    } else {
      void openPreview(entry);
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
      onQuickLook: handleKeyQuickLook,
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

  /**
   * The view half of the cross-window intent (REQ-A783): the Dock's trash tile asks for 「废纸篓」
   * from the shell window. Same consume-and-clear discipline as the reveal above — and the same
   * "clear after serving, not before": a cleared-but-unserved intent is a lost click.
   */
  $effect(() => {
    const un = viewStore.subscribe((raw) => {
      const v = normalizeViewIntent(raw);
      if (!v || v.nonce === viewNonce) return;
      viewNonce = v.nonce;
      applyView(v.view);
      if (!writeStoreValueChecked(FILES_VIEW_KEY, null)) {
        storeErr = t("common.storeWriteFailed");
      }
    });
    return un;
  });

  /**
   * Land on one of the four views. Deliberately the *same* state change the 废纸篓 chip in the
   * toolbar makes and no more: the tile is a second door onto the same room, so a user who clicks
   * the dock tile and a user who clicks the tab must end up in the same place — if this grew extra
   * side effects (clearing the folder, the search, the selection) the two doors would diverge and
   * the view would depend on which one was used.
   */
  function applyView(view: FilesView): void {
    mode = view;
  }

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

  /* ---- Tablet master-detail (iPadOS 文件) --------------------------------------
   *
   * The decision belongs to `lib/formLayout::masterDetail` — the same pure rule the
   * Settings page already reads (REQ-A512 sibling), consuming the host's measured
   * **class + columns + screen** from the shell's one layout snapshot, never the
   * WebView's own width. This is the second built-in app to adopt the reusable
   * sidebar decision (`docs/multi-window.md` §1.5② named "其余 app 仍未采纳"); Files
   * has the real navigation model it needs — `folderTree(list)` is the hierarchy.
   *
   * When the surface is a phone (or a not-yet-measured narrow tablet window) `wide`
   * is false, the sidebar is not rendered and the screen is exactly the single-column
   * browser it has always been: the detail wrapper's `contents` display means the
   * phone DOM has no extra box. */
  const snap = $derived(layoutSnap());
  const md = $derived(masterDetail(snap?.form ?? "phone", snap?.columns ?? 0, snap?.screen_w ?? 0));
  const wide = $derived(md.sidebar);
  /** Jump to a folder (or the root) from the sidebar — same resets `openFolder` makes. */
  const selectCwd = (id: string | undefined) => {
    mode = "all";
    globalSearch = false;
    query = "";
    spotId = null;
    focusedId = null;
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
    previewTrunc = false;
  };

  /**
   * The sentence for a preview this shell could not produce (F-SH-281).
   *
   * Three separate keys, because they are three different facts — no host to ask at all, a
   * host that refused the read, and a host that answered something this shell cannot read as
   * bytes. `printRefusalMessage` states the rule for the print pipeline: one sentence for
   * every refusal makes three different events read identically in a bug report.
   */
  function previewUnavailableText(plan: PreviewPlan): string {
    switch (plan.reason) {
      case "no-bridge":
        return t("files.previewNoHost");
      case "refused":
        return t("files.previewRefused");
      default:
        return t("files.previewUnreadable");
    }
  }

  async function openPreview(entry: FEntry): Promise<void> {
    // This panel is one surface with the host `<pre>` and stat card; carving out the claim here
    // retires them the way `openHostEntry` retires the panel for the reverse order.
    const gen = takeOverSharedPanel();
    previewTarget = entry;
    previewPlan = null;
    previewBusy = true;
    // `previewTrunc` is a fact about **one host read** ("the read stopped at the cap"), and
    // this panel outlives the file it was showing. Every other writer of the panel's title
    // clears it — `closePreview` does, and `openHostEntry`'s preview branch sets it — so a
    // writer that paints the panel for a *different* file must clear it too, or the notice
    // follows onto a file the host never read (the local-device and MediaStore routes below,
    // and this one, are exactly those writers).
    previewTrunc = false;
    try {
      // Local files: use the inline `content` if any (text-only), else report
      // empty.  In a future revision, the Files app could persist binary bytes
      // by reference (e.g. `media_uri`) and route through `media_load` here too.
      const body = entry.content ?? "";
      let next: PreviewPlan | null;
      if (entry.type === "file" && body.length === 0) {
        next = await planPreview(entry.name, null, new Uint8Array(0));
      } else if (entry.type === "file") {
        const bytes = new TextEncoder().encode(body);
        next = await planPreview(entry.name, null, bytes);
      } else {
        // Folders cannot be previewed — show a clear "binary" panel.
        next = { kind: "binary", src: "", bytes: 0, isText: false, error: null, sizeLabel: "—", mime: null };
      }
      // A later open — device or host — owns the panel now, so its reply paints and this one's
      // does not: the title moved to the newer file when *it* started, and drawing these bytes
      // under that title would name one file and show another.
      if (gen !== hostSurfaceGen) return;
      previewPlan = next;
    } finally {
      // Only the claim that still owns the surface may end its spinner; a superseded reply must
      // not clear the flag the newer open is holding.
      if (gen === hostSurfaceGen) previewBusy = false;
    }
  }

  /**
   * Hand a file's text to the system share sheet (REQ-A703). A file with no
   * content has nothing to share, and the sheet refuses empty payloads rather than
   * handing an empty string to every handler — so say so here instead of opening a
   * sheet that does nothing.
   */
  function shareFile(entry: FEntry): void {
    err = "";
    if (!openShareSheet(fileShare(entry.content ?? "", entry.name))) {
      err = t("files.shareNothing");
    }
  }

  async function openExternalPreview(uri: string, name: string, mime: string | null): Promise<void> {
    // Same rule as `openPreview`: another device-side writer onto the shared panel, so it retires
    // the host surfaces and claims the token too.
    const gen = takeOverSharedPanel();
    previewTarget = { id: uri, type: "file", name, ts: Date.now() } as FEntry;
    previewPlan = null;
    previewBusy = true;
    // Same gate, same reason as `openPreview` above: this is another writer of the shared
    // panel, and a MediaStore item was never read from the host.
    previewTrunc = false;
    try {
      const item = { id: uri, kind: "file" as const, collection: "download" as StandardDir, name, uri, mime, size_bytes: null, ts: Date.now() };
      // `mediaLoad` has **three** outcomes, not two: the bytes, `null` (its documented
      // failure value — offline, or a host that will not serve the item), and a
      // **rejection** on a real error (`media.ts::call` does not catch). A genuinely
      // empty file is `[]`, which is truthy here — so this `else` is reached *only* when
      // the read failed, and 「二进制文件」 would be a claim nobody made (F-SH-281).
      const bytes = await mediaLoad(item);
      let next: PreviewPlan | null;
      if (bytes) {
        next = await planPreview(name, mime, bytes);
      } else {
        // `media_load`'s contract (`lib/media.ts`) decides this without a diagnostic:
        // offline → `null`, a bridge present and erroring → a rejection. So a `null` here
        // means there was no host to ask.
        next = previewUnavailablePlan(mime, hasMediaBridge() ? "refused" : "no-bridge");
      }
      // Same check as `openPreview`: a later open owns the panel now.
      if (gen !== hostSurfaceGen) return;
      previewPlan = next;
    } catch {
      // The panel's template has no `{:else}` after `{:else if previewPlan}`, so a
      // rejected read used to leave an open panel with an empty body — and, because this
      // is called as `void openExternalPreview(…)` from the row's button, the rejection
      // itself went nowhere. Same rule as `PlayerApp.svelte`'s resolve path: a failure to
      // read is surfaced as "unavailable" rather than rendered as a fact about the file.
      if (gen !== hostSurfaceGen) return;
      previewPlan = previewUnavailablePlan(mime, "refused");
    } finally {
      // Same rule as `openPreview`: a superseded reply must not end the newer open's spinner.
      if (gen === hostSurfaceGen) previewBusy = false;
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
      // The bundle text goes into the textarea so it can be copied by hand. It is also what
      // 「保存到主机文件」 writes, byte-for-byte, when a host root is configured — so the two
      // paths describe the same artifact rather than two encodings of it.
      exportMsg = `${t("files.bundleExported")} (${r.ratioLabel}, ${r.compressedBytes} B)`;
      // Stash the bundle text in `importText` so the user can copy it.
      importText = r.text;
      // A new bundle replaced the one that was saved, so the save report describes an artifact
      // that is no longer in the textarea. Retire it rather than leave a stale "已保存到 …".
      bundleSaveMsg = "";
      bundleSaveOk = false;
    } finally {
      exportBusy = false;
    }
  }

  /**
   * The bundle text as a file on the host, through `host_fs_write_bytes`.
   *
   * Bytes rather than `host_fs_write_text` on purpose: a bundle is an **artifact** whose bytes
   * matter (the import side compares its magic line and base64 body), so it is encoded here to
   * UTF-8 once and handed over as the exact byte string — the host never re-encodes it.
   *
   * The name carries a millisecond timestamp because `host_fs_write_bytes` has no create-only
   * flag: without it two exports would be one file, the second silently replacing the first.
   * The result sentence quotes the path the host actually used, not the one we asked for.
   */
  async function saveBundleToHost(): Promise<void> {
    if (!hostReady) {
      bundleSaveOk = false;
      bundleSaveMsg = t("files.bundleSaveNoHost");
      return;
    }
    const text = importText;
    if (!text.trim()) {
      bundleSaveOk = false;
      bundleSaveMsg = t("files.bundleImportFailed", { reason: t("files.bundleFormatError") });
      return;
    }
    bundleSaveBusy = true;
    bundleSaveMsg = "";
    try {
      const b64 = bytesToBase64(new TextEncoder().encode(text));
      const r = await hostFsWriteBytes(hostChildPath(bundleFileName()), b64);
      if (!r.ok) {
        bundleSaveOk = false;
        bundleSaveMsg = hostErrText(r.code, r.isOffline === true);
        return;
      }
      bundleSaveOk = true;
      bundleSaveMsg = t("files.bundleSavedToHost", { path: r.value.path });
      // The host now has a file it did not a moment ago, so any listing on screen may be
      // stale. Re-read the folder being browsed rather than trying to guess whether the write
      // landed in it: the reply's path is absolute, `hostCwd` is fence-relative, and a
      // comparison between the two would be a claim dressed up as a check.
      if (hostOpen) loadHostDir(hostCwd);
    } finally {
      bundleSaveBusy = false;
    }
  }

  /**
   * `amos-bundle-YYYYMMDD-HHMMSSmmm.amos-bundle` — the milliseconds are load-bearing, not
   * decoration. `host_fs_write_bytes` has no create-only flag, so a name collision is a
   * **silent replace** of an artifact the user meant to keep; a second-resolution stamp
   * would let every export saved within the same second overwrite the one before it.
   */
  function bundleFileName(): string {
    const d = new Date();
    const p = (n: number, width = 2) => String(n).padStart(width, "0");
    return `amos-bundle-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}.amos-bundle`;
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
        persist([], () => void doImportBundle());
      } else {
        // Replace: the bundle is the source of truth.
        persist(r.entries, () => void doImportBundle());
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
    cloudErr = "";
    // The snapshot is built from the **device-file list**, so a save may only answer
    // about a list this shell has actually *read*. Three facts, three sentences (the
    // rule `previewUnavailableText` states, F-SH-281) — answering any of the first two
    // with 「没有可保存的设备文件」 would report the device as empty while its listing was
    // in flight or refused, and answering with `files.cloudEmpty` (「尚未保存快照」, the
    // *before* state) told the user their save had not happened.
    if (extBusy) {
      // No observation yet: the media read is still in flight, so the shell knows
      // neither that the device has files nor that it has none.
      cloudMsg = t("files.cloudSaveReading");
      return;
    }
    if (extBlocked) {
      // The refusal is a fact about the *read* (F-SH-281's rule): it goes to the
      // refusal bar, and says the same thing the external section says, not that the
      // device is empty.
      cloudErr = t("files.externalBlocked");
      return;
    }
    if (extFlat.length === 0) {
      // A settled, readable, empty list — the one case where "no device files" is a
      // fact this shell observed. Distinct from the `cloudEmpty` row below the
      // controls, which is about the *snapshot* record: "no snapshot saved" is the
      // state a save is meant to change, not a reason it could not run.
      cloudMsg = t("files.cloudNothingToSave");
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
        cloudMsg = "";
        cloudErr = t("files.cloudSaveFailed");
      }
    } finally {
      cloudBusy = false;
    }
  }

  function doDeleteCloud(): void {
    // The delete's own verdict decides whether the panel may say 「尚未保存快照」:
    // a refused removal leaves the key on disk (and it comes back next launch), so
    // the row draws as if it succeeded only when the removal really landed.
    if (!deleteSnapshot()) {
      cloudErr = t("common.storeWriteFailed");
      return;
    }
    cloudSnap = null;
    cloudMsg = "";
    cloudErr = "";
  }

  function doRestoreCloud(): void {
    const snap = loadSnapshot();
    if (snap) {
      cloudSnap = snap;
      cloudMsg = t("files.cloudRestored", { count: snap.fileCount });
      cloudErr = "";
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
    if (!persist(addEntry(list, entry), () => submitCreate())) return;
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
    if (!persist(renameEntry(list, renameId, v), () => submitRename())) return;
    renameId = null;
    err = "";
    currentError = null;
    isErrorStorm = false;
  };
  const doCut = (id: string) => (cutId = id);
  const moveHere = () => {
    if (!cutId) return;
    if (!persist(moveEntry(list, cutId, cwd), () => moveHere())) {
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

  // ---- Host filesystem (read-only window onto AMOS_HOST_FS_ROOT) ------------
  // The `host_fs_*` bridge lets this screen browse the machine AmOS runs on, but
  // only through one fenced directory the operator named at startup. The optional
  // env var means "not configured" is the normal case, so the section renders
  // **only** for a real root: the bridge absent, the fence unset, or a fence that
  // is not a readable directory all leave the surface off rather than posing as an
  // empty folder.
  let hostReady = $state(false);
  let hostRoot = $state<string | null>(null);
  let hostOpen = $state(false);
  let hostCwd = $state("");
  let hostEntries = $state<FsDirEntry[]>([]);
  let hostBusy = $state(false);
  /**
   * A host *listing* read is in flight. Kept apart from `hostBusy` because the two host reads
   * that hold `hostBusy` are treated differently by a device takeover: a superseded *open* is
   * dropped and can never clear its own flag, while a *listing* (own token now) still lands.
   * `takeOverSharedPanel` needs to know which one it is looking at.
   */
  let hostListPending = $state(false);
  let hostErr = $state("");
  /**
   * Did the **listing itself** fail (as opposed to an action inside it)?
   *
   * `hostErr` is the one banner for any host refusal, and it is right for that. But the list
   * region used to key off `hostErr`, so a refused *mutation* (a rename that collided, a
   * delete the host declined) replaced a listing that was still exactly right with nothing —
   * the user lost the folder they were looking at. Only a failed *read* licenses dropping the
   * list: the entries on screen would then describe a directory the host never handed over.
   * Kept separate from `hostErr` so the two facts cannot be re-conflated (REQ-A542's rule —
   * "never render a refusal as an empty folder" — still holds, and now covers only this case).
   */
  let hostListFailed = $state(false);
  /** The text file being looked at (`null` = listing only). Read-only for now. */
  let hostFile = $state<{ path: string; body: string; truncated: boolean } | null>(null);
  /** Our own watch id — events we do not own are someone else's window's. */
  let hostSubId: number | null = null;
  /**
   * Set on teardown so an async registration that lands *after* the screen is gone can release
   * itself. The `$effect` cleanup below can only unsubscribe an id it can already see, and the
   * subscribe resolves a few hops after mount — a screen unmounted inside that window would
   * otherwise leave the host's OS-level watcher running for the life of the process (REQ-A1177).
   */
  let hostDestroyed = false;
  /**
   * Which claim on the **shared info surface** is the current one. The `<pre>`, the stat card and
   * the preview panel are one surface: at most one of them may describe a file at a time.
   *
   * Every read that **takes over** that surface — a host file open (`openHostEntry`), or a
   * device/MediaStore preview (`openPreview` / `openExternalPreview`, which paint the same panel
   * through `takeOverSharedPanel`) — bumps this; the stat card only *observes* the surface it was
   * asked about, so it captures the token without bumping. A host *listing* (`loadHostDir`) does
   * **not** belong here: it paints the host browser's list, a different region, and has its own
   * order token (`hostListGen`) — see there for what overloading this counter cost.
   *
   * Every one of these reads can be answered after the surface has moved on, because the row
   * button that starts the next one is never disabled. Without the token the slower reply paints
   * last: a `<pre>` for the file they clicked *before* the one they clicked last, a device file's
   * preview landing over the host file just opened, or a stat card appearing *alongside* the
   * preview a later open had just claimed (the one-thing-at-a-time rule `openHostEntry` states).
   * A superseded reply paints nothing and leaves `hostBusy` to the newer call **when that call is
   * another host read** — a host taker sets `hostBusy` itself, so it owns the flag. A
   * device/MediaStore takeover does not, which is why it must release the flag here.
   */
  let hostSurfaceGen = 0;
  /**
   * Order of **host listings** — a counter of its own, deliberately not `hostSurfaceGen`.
   *
   * A listing and the shared info panel are two different regions: the listing renders in the
   * host browser's list, the panel is a top-level card. They share no pixels, so neither may
   * cancel the other. They *did* share one counter, and the cost was that opening a device
   * preview while a folder was still listing **dropped that listing**: the folder the user
   * clicked never opened, and (once the takeover began clearing `hostBusy` for the strand that
   * caused) the region settled on 「此文件夹为空」 — a claim nobody established, the rule this
   * file states for refused reads (REQ-A542). What genuinely overlaps is the *panel*, and that
   * is still one counter: `hostSurfaceGen`.
   */
  let hostListGen = 0;
  /**
   * Which generation of the panel's token was claimed by a **device/MediaStore** door
   * (`takeOverSharedPanel`) rather than by a host read. It answers one question for a listing
   * that is landing: *is the newest claim on the panel one that belongs to no directory?*
   *
   * A listing retires the claims that describe rows of the listing it replaces, but a device
   * preview's file is not one of those rows — so it must keep its own reply and its own spinner.
   * A **host open** is the other case: it *is* a row of the directory being left, so the landing
   * must retire it and take the token again, or its late reply paints a `<pre>`/card for a file
   * the breadcrumb no longer names. A listing that started first cannot bump past an open that
   * started after it, which is why that retake has to happen at the landing.
   */
  let devicePanelGen = 0;
  /**
   * The device and MediaStore routes onto the **shared** panel take it over here: this retires the
   * two host panel surfaces (`<pre>`, stat card) — the reciprocal of `closePreview()`, which
   * retires the panel they share — and returns the new claim token. The caller must check that
   * token before painting `previewPlan`: without the bump a host open (or another device preview)
   * still in flight repaints its claim over the file the user just opened.
   *
   * `hostBusy` is released here only for a dropped host *open*. Its reply is dropped by the token
   * check, so it never reaches its own `hostBusy = false`; and this takeover never set the flag, so
   * it could not be "left to the newer call" the way another host read leaves it — left alone it
   * strands at `true`, freezing the host browser (`disabled={hostBusy}` on every row *action*; the
   * empty-list line reading 「加载中」) for the life of the screen. A *listing* is not dropped — it
   * has its own token and lands — so a pending one keeps its flag, or the region would read
   * 「此文件夹为空」 for the read's duration.
   */
  function takeOverSharedPanel(): number {
    const gen = ++hostSurfaceGen;
    devicePanelGen = gen;
    hostFile = null;
    hostStat = null;
    hostBusy = hostListPending;
    return gen;
  }
  /** Inline name entry: `"newdir"` (create) or `"rename"` (a row's new name). */
  let hostNameMode = $state<"newdir" | "newfile" | "rename" | null>(null);
  let hostNameValue = $state("");
  /** The row being renamed; `null` when the input is creating a folder. */
  let hostRenameTarget = $state<FsDirEntry | null>(null);
  /** Row-path currently mid-mutation, so its action buttons disable. */
  let hostMutating = $state<string | null>(null);
  /**
   * The row whose `host_fs_stat` answer is on screen. A row comes from a **listing**, and a
   * listing is a snapshot: the file can be gone, replaced, or moved outside AmOS before the
   * user asks about it. That is why this is a fresh `stat` of the path rather than a re-render
   * of `e` — `exists: false` is the answer that says "the list you are looking at is stale",
   * and it is the whole reason to have the command at all.
   */
  let hostStat = $state<FsStatResult | null>(null);
  let hostStatBusy = $state(false);
  /**
   * The host's live subscription ids, straight from `host_fs_watch_list`. `null` = the bridge
   * never answered. The host serves every window from one process, so this counts **all**
   * watchers, not just ours — which is the point: a Files screen that never released its own
   * watcher (REQ-A1177) leaves the count one too high and this chip is where that shows.
   */
  let hostWatchIds = $state<number[] | null>(null);
  /**
   * The host **refused to install** our file watch — so an edit made outside AmOS will not
   * refresh this listing, and nothing else on screen says so (REQ-A1595 / FMEA F-SH-810).
   *
   * Kept in its **own** state rather than folded into `hostErr`: `hostErr` is the *last
   * listing's* verdict and `loadHostDir`'s success branch clears it, so an ordinary refresh
   * would erase a standing fact about the screen's own wiring. Same split, same reason, as
   * `hostListFailed` below (REQ-A542's rule). `""` = no refusal recorded.
   *
   * A dedicated sentence is unavoidable here because the header's count chip cannot carry it:
   * that chip is hidden at zero (`0 watchers` is the ordinary state of a host nobody is
   * watching, REQ-A1177), so a refused watch and a quiet working one rendered identically —
   * the conflation `hostFs.ts::onHostFsEvent` names for the sibling listen seam (REQ-A838).
   */
  let hostWatchRefused = $state("");
  /** Bundle → host file. Kept apart from `exportMsg` (the clipboard-text report). */
  let bundleSaveBusy = $state(false);
  let bundleSaveMsg = $state("");
  let bundleSaveOk = $state(false);

  /** The localized sentence for a refusal, chosen by the host's **stable code**. */
  const HOST_ERR_KEYS: Record<string, string> = {
    "amos.host_fs.path_escapes_root": "files.hostErrEscapes",
    "amos.host_fs.read_not_utf8": "files.hostErrNotUtf8",
    "amos.host_fs.file_too_large": "files.hostErrTooLarge",
    "amos.host_fs.root_not_configured": "files.hostDisabled",
    "amos.host_fs.root_not_found": "files.hostBadRoot",
    "amos.host_fs.root_not_a_dir": "files.hostBadRoot",
    "amos.host_fs.target_exists": "files.hostErrExists",
    "amos.host_fs.dir_not_empty": "files.hostErrDirNotEmpty",
    "amos.host_fs.recursion_limit": "files.hostErrRecursion",
    "amos.host_fs.create_dir_failed": "files.hostErrWrite",
    "amos.host_fs.remove_failed": "files.hostErrWrite",
    "amos.host_fs.rename_failed": "files.hostErrWrite",
    "amos.host_fs.copy_failed": "files.hostErrWrite",
  };

  /** Turn a typed refusal into a sentence. An unmapped code still shows itself. */
  function hostErrText(code: string, isOffline: boolean): string {
    if (isOffline) return t("files.hostDisabled");
    const key = HOST_ERR_KEYS[code];
    return key ? t(key) : t("files.hostErrGeneric", { code });
  }

  function loadHostDir(path: string): void {
    // Navigations can overlap (a folder click, then "up" before the first listing answers), and
    // the host is free to answer the second before the first. Without this token the older reply
    // would land last and paint a directory the user has already left — with the breadcrumb
    // agreeing with it, so nothing on screen would look wrong.
    const listGen = ++hostListGen;
    // Whether this listing **moves** the browser into another directory, read before `hostCwd` is
    // overwritten. It decides whether the panel's token is taken at all. A listing that replaces
    // the directory already on screen — `loadHostDir(hostCwd)`: the host's watch event, and every
    // post-mutation relist — leaves the panel's *subject* exactly where it is, so taking the token
    // there invalidates claims the listing never moved away from. And the watch is **recursive from
    // the root**, so the event that triggers it can come from a file in a different folder: an
    // unrelated edit used to drop the open the user had just started and wipe the `<pre>` they were
    // reading. Only leaving a directory retires the panel — the rule `closePreview` states ("a
    // panel still showing a file from the directory we just left") — so only leaving takes it.
    const moved = path !== hostCwd;
    // A moving listing retires the claims on the panel: the stat card and the `<pre>` describe rows
    // in the listing being replaced, and a device preview is retired by leaving the directory. So
    // it takes the panel claim for itself...
    if (moved) ++hostSurfaceGen;
    // ... and remembers it, so the landing below can tell a claim that *supersedes* it from its
    // own. Note the direction — a listing cancels panel claims, but a panel claim must never
    // cancel a listing (that is what `hostListGen` above is for).
    const panelGen = hostSurfaceGen;
    hostBusy = true;
    hostListPending = true;
    void hostFsReadDir(path).then((r) => {
      if (listGen !== hostListGen) {
        // This reply loses the **listing** region, but it may still hold the **panel** token — and
        // the listing that beat it need not be a taker at all: a same-directory refresh (the watch
        // event, a post-mutation relist) never takes the token, so `panelGen === hostSurfaceGen`
        // here means no newer claim exists and this dropped reply is the only owner left of the
        // panel's transient. A device preview superseded by this listing had its reply dropped by
        // that bump, so nobody else can end its spinner: leaving it here strands the device file's
        // title over a spinner that never stops — the failure arm's debt, owed one order-check
        // earlier. A newer **host** claim or a newer **device** claim both bump the token, so they
        // are excluded by the equality and resolve their own.
        if (moved && panelGen === hostSurfaceGen) closePreview();
        return;
      }
      hostBusy = false;
      hostListPending = false;
      if (r.ok) {
        const rows = normalizeHostDir(r.value);
        if (moved) {
          hostEntries = rows;
          hostCwd = path;
          // Retire the panel unless a newer claim must keep its own reply: a **device** claim (it
          // belongs to no directory, so a folder landing must not close it). A newer **host** claim
          // is a row of the directory being left, so it must be retired — and the token retaken,
          // because a host open can claim it *after* this listing started (the row it was clicked
          // on was still drawn) and its late reply would otherwise paint a `<pre>`/card for a file
          // the breadcrumb no longer names. Without the bump the breadcrumb would move and the old
          // claim would stand.
          if (!(panelGen !== hostSurfaceGen && devicePanelGen === hostSurfaceGen)) {
            hostFile = null;
            hostStat = null;
            closePreview();
            ++hostSurfaceGen;
          }
        } else {
          // A refresh of the directory already on screen retires only what the new listing says is
          // **gone**: a surface naming a row this listing still has describes a row that is still
          // on screen, so retiring it would throw away what the user asked for. The set is the
          // difference between the listing that was on screen and the one arriving, so a surface is
          // retired exactly when its row left — which is the rule the old unconditional retire
          // existed for ("a card still describing a file that is not in the listing on screen").
          const gone = new Set(
            hostEntries.filter((e) => !rows.some((x) => x.path === e.path)).map((e) => e.path),
          );
          hostEntries = rows;
          hostCwd = path;
          if (hostFile && gone.has(hostFile.path)) hostFile = null;
          if (hostStat && gone.has(hostStat.path)) hostStat = null;
          // `previewTarget.id` is a row's path for a host binary file (`openHostEntry`'s preview
          // arm) and a uri/id for a device or MediaStore file. A device id is never in `gone` — the
          // set only holds paths that were rows of this listing — so a refresh of a directory a
          // device preview does not belong to cannot close it.
          if (previewTarget && gone.has(previewTarget.id)) closePreview();
        }
        hostErr = "";
        hostListFailed = false;
      } else {
        // Only a **moving** listing has a claim to resolve here. It took the panel token above and
        // its read failed, so it can never paint over the claim it superseded: a device preview's
        // reply was dropped by that bump and nobody else can end its spinner — the panel would
        // keep the device file's title over a spinner that never stops. A refresh of the same
        // directory never took the token, so it has nothing to resolve and must not close what it
        // never invalidated: the listing on screen stays, and the panel's subject with it.
        if (moved && panelGen === hostSurfaceGen) closePreview();
        hostErr = hostErrText(r.code, r.isOffline === true);
        hostListFailed = true;
      }
    });
  }

  /**
   * Open a host file. Text goes to the `<pre>` below; anything the host refuses to decode as
   * UTF-8 goes to the **same preview panel** a device file uses, so a photo, an audio clip or
   * a video in the host browser renders instead of reporting that it is not valid UTF-8
   * (REQ-A971). The decision — and the reason only one refusal licenses the bytes reader —
   * lives in `lib/hostFileOpen.ts`, where it has two-sided controls.
   *
   * One file, one surface: opening either kind closes the other, so the panel below and the
   * preview panel can never claim two different files at once.
   */
  function openHostEntry(e: FsDirEntry): void {
    // One info surface at a time: opening a row retires the stat card, or the two would make
    // competing claims about which row is "current".
    hostStat = null;
    if (e.isDir) {
      loadHostDir(e.path);
      return;
    }
    // Opening a row **takes over** the info surface (it just retired the stat card above), so it
    // claims the token too. That covers both the open that races a navigation and the open that
    // races another open: click two files quickly and only the one clicked last may paint, whatever
    // order the reads come back in. Note the `hostBusy` clear sits *after* the check — a superseded
    // reply must not clear the flag the newer call is holding until its own reply lands.
    const gen = ++hostSurfaceGen;
    hostBusy = true;
    void openHostFile(e.name, e.path).then((out) => {
      if (gen !== hostSurfaceGen) return;
      hostBusy = false;
      // This open still holds the token, so it owns the shared panel's fate: a device preview it
      // superseded had its reply dropped by the bump, and nobody else can end its spinner. The
      // obligation is therefore owed on **every** path below, including the one that returns early
      // — the row check is new, the obligation is not, and a dropped reply that skips it leaves the
      // panel showing the device file's title over a spinner that never stops. (It is the same
      // debt the error arm used to pay on its own; hoisting it here is what makes the two one
      // obligation instead of two copies of it.)
      closePreview();
      // A refresh of the directory on screen does not take the panel token (see `loadHostDir`), so
      // the token is no longer what keeps this reply off a listing it does not belong to: the two
      // **claims** below have to ask the other half themselves. If the row it names is no longer
      // listed, the refresh dropped it (an edit outside AmOS) and there is no row for the `<pre>`
      // or the panel to describe — the same claim the moving case is dropped by the token for.
      // A **refusal** is exempt: it is a fact about the read, not a claim about a row, so it stands
      // exactly as `hostShowStat`'s refusal arm does. Gating it would leave a pressed button with
      // no sentence at all — the silent no-op this file rules against.
      if (out.kind !== "error" && !hostEntries.some((x) => x.path === e.path)) return;
      if (out.kind === "text") {
        hostFile = { path: out.path, body: out.body, truncated: out.truncated };
        hostErr = "";
        return;
      }
      if (out.kind === "preview") {
        hostFile = null;
        hostErr = "";
        // A synthetic `FEntry` for the panel's title, the way the MediaStore path does it
        // (`openExternalPreview`): the panel is typed for a local entry, and a host entry has
        // a path rather than an id, so the path is the id.
        previewTarget = { id: e.path, type: "file", name: e.name, ts: e.mtimeMs ?? Date.now() } as FEntry;
        previewPlan = out.plan;
        previewTrunc = out.sourceTruncated;
        previewBusy = false;
        return;
      }
      // The refused open owes the shared panel's transient the same way — paid above, with the
      // claims' path, so the refusal needs only its sentence here. Same rule as `loadHostDir`'s
      // failed branch, one function over.
      hostErr = hostErrText(out.code, out.isOffline);
    });
  }

  /** Up one level: `hostParent` answers `null` at the fence root, not `..`. */
  function hostUp(): void {
    const up = hostParent(hostCwd);
    loadHostDir(up ?? "");
  }

  /** The secondary line under a host row: size (files only) and mtime, joined. */
  function hostMeta(e: FsDirEntry): string {
    const when = e.mtimeMs ? fmtTime(e.mtimeMs) : "";
    if (e.isDir) return when;
    const size = formatBytes(e.size);
    return when ? `${size} · ${when}` : size;
  }

  /**
   * Ask the host to stat one row's path, fresh. The row already prints a size and mtime from
   * the listing, but those describe the entry **when the directory was read** — this is the
   * only read that can disagree with them (`exists: false` after an outside deletion, a size
   * that grew). A refusal goes to the shared banner rather than the card, so the card never
   * shows a stale `hostStat` next to a newer error.
   */
  function hostShowStat(e: FsDirEntry): void {
    // The reply can outlive the listing it answers about: the row that navigates away is **not**
    // disabled while a stat is in flight, so a slow `host_fs_stat` can land after the user has
    // already descended into another folder — or opened a row, which retires the card and claims
    // the surface for a preview. Painting it then would put a card for a row that is no longer
    // drawn onto a listing it does not belong to, or *alongside* the preview that has since been
    // claimed. The card only observes the surface, so it captures the token rather than bumping
    // it: it must not invalidate the very read it is asking about.
    const gen = hostSurfaceGen;
    hostStatBusy = true;
    void hostFsStat(e.path).then((r) => {
      hostStatBusy = false;
      if (gen !== hostSurfaceGen) return;
      if (!r.ok) {
        hostStat = null;
        hostErr = hostErrText(r.code, r.isOffline === true);
        return;
      }
      // A refusal above is a fact about the **read** and stands; the card below is a claim about
      // the **row**, so it is painted only while that row is still in the listing on screen. Same
      // reason as `openHostEntry`'s reply: a same-directory refresh does not take the panel token,
      // so dropping a reply whose row a refresh removed is this check's job.
      if (!hostEntries.some((x) => x.path === e.path)) return;
      hostFile = null;
      closePreview();
      hostErr = "";
      hostStat = r.value;
    });
  }

  /** The stat card's one-line sentence: existence first, then the facts that hang off it. */
  function hostStatLine(s: FsStatResult): string {
    if (!s.exists) return t("files.hostStatMissing");
    const parts = [s.isDir ? t("files.hostStatKindDir") : t("files.hostStatKindFile")];
    if (!s.isDir) parts.push(formatBytes(s.size));
    if (s.mtimeMs) parts.push(t("files.hostStatMtime", { time: fmtTime(s.mtimeMs) }));
    return parts.join(" · ");
  }

  /**
   * Re-read the host's active subscription ids. Called after every subscribe/unsubscribe this
   * screen performs: the count is a fact about the **host process**, and dropping our own
   * watcher without re-reading would leave a number on screen that no longer holds.
   */
  function refreshHostWatches(): void {
    void hostFsWatchList().then((ids) => {
      if (hostDestroyed) return;
      hostWatchIds = ids;
    });
  }

  /**
   * A conservative single-name check before a create/rename reaches the bridge:
   * non-empty, neither `.` nor `..`, no path separator, and no surrounding
   * whitespace. The Rust chokepoint would refuse anything stranger, but catching
   * it here turns a round-trip refusal into an inline sentence.
   */
  function hostLeafNameOk(name: string): boolean {
    return (
      name !== "" &&
      name === name.trim() &&
      name !== "." &&
      name !== ".." &&
      !name.includes("/") &&
      !name.includes("\\")
    );
  }

  /** Join the current directory and a leaf into the bridge's path form. */
  function hostChildPath(name: string): string {
    return hostCwd === "" ? name : `${hostCwd}/${name}`;
  }

  function hostBeginNewFolder(): void {
    hostFile = null;
    hostRenameTarget = null;
    hostNameValue = "";
    hostNameMode = "newdir";
    hostErr = "";
  }

  function hostBeginNewFile(): void {
    hostFile = null;
    hostRenameTarget = null;
    hostNameValue = "";
    hostNameMode = "newfile";
    hostErr = "";
  }

  function hostBeginRename(e: FsDirEntry): void {
    hostFile = null;
    hostRenameTarget = e;
    hostNameValue = e.name;
    hostNameMode = "rename";
    hostErr = "";
  }

  function hostCancelName(): void {
    hostNameMode = null;
    hostRenameTarget = null;
    hostNameValue = "";
  }

  /** Create or rename, then relist. A refusal lands in `hostErr`, never silently. */
  function hostConfirmName(): void {
    if (!hostLeafNameOk(hostNameValue)) {
      hostErr = t("files.hostBadName");
      return;
    }
    const mode = hostNameMode;
    const target = hostRenameTarget;
    const name = hostNameValue;
    hostCancelName();
    if (mode === "newdir") {
      hostMutating = "__newdir__";
      void hostFsCreateDir(hostChildPath(name), false).then((r) => {
        hostMutating = null;
        if (!r.ok) {
          hostErr = hostErrText(r.code, r.isOffline === true);
          return;
        }
        loadHostDir(hostCwd);
      });
    } else if (mode === "newfile") {
      // `createOnly` so an existing name is `target_exists`, not a save-over: a
      // blank file must never replace one the user already had.
      hostMutating = "__newfile__";
      void hostFsWriteText(hostChildPath(name), "", undefined, true).then((r) => {
        hostMutating = null;
        if (!r.ok) {
          hostErr = hostErrText(r.code, r.isOffline === true);
          return;
        }
        hostFile = null;
        loadHostDir(hostCwd);
      });
    } else if (mode === "rename" && target) {
      hostMutating = target.path;
      void hostFsRename(target.path, hostChildPath(name), false).then((r) => {
        hostMutating = null;
        if (!r.ok) {
          hostErr = hostErrText(r.code, r.isOffline === true);
          return;
        }
        hostFile = null;
        loadHostDir(hostCwd);
      });
    }
  }

  /** Delete a host entry. `isDir` opts the tree into the host's recursive path. */
  function hostDelete(e: FsDirEntry): void {
    if (!confirm(t("files.hostDeleteConfirm", { name: e.name }))) return;
    hostMutating = e.path;
    void hostFsRemove(e.path, e.isDir).then((r) => {
      hostMutating = null;
      if (!r.ok) {
        hostErr = hostErrText(r.code, r.isOffline === true);
        return;
      }
      hostFile = null;
      loadHostDir(hostCwd);
    });
  }

  /** Duplicate a host entry beside itself; the suffixed name avoids a collision. */
  function hostDuplicate(e: FsDirEntry): void {
    const parent = hostParent(e.path);
    const copyName = t("files.hostCopySuffix", { name: e.name });
    const dest = parent === null ? copyName : `${parent}/${copyName}`;
    hostMutating = e.path;
    void hostFsCopy(e.path, dest, false).then((r) => {
      hostMutating = null;
      if (!r.ok) {
        hostErr = hostErrText(r.code, r.isOffline === true);
        return;
      }
      loadHostDir(hostCwd);
    });
  }

  /**
   * Turn the surface on: probe the fence, then (only with a real root) list it and
   * start **one** recursive watch so an edit made outside AmOS refreshes the list.
   */
  function startHostFs(): void {
    void hostFsRootStatus().then((st) => {
      if (hostDestroyed) return;
      // `null` = no bridge; `root: null` = env unset; `!exists` = bad fence. All
      // three are "no surface", and none of them may render as an empty folder.
      if (st === null || st.root === null || !st.exists) return;
      hostRoot = st.root;
      hostReady = true;
      loadHostDir("");
      refreshHostWatches();
      void hostFsWatchSubscribe("").then((r) => {
        if (!r.ok) {
          // The watch is the only thing that refreshes this listing when an edit lands outside
          // AmOS, and a refusal here used to be dropped on the floor: no state, no sentence, and
          // the count chip is hidden at zero — so "refused" and "quiet" read alike. Say the
          // **consequence** (which no error code carries), and quote the host's own reason inside
          // it rather than inventing a second one (REQ-A1595).
          if (!hostDestroyed) {
            hostWatchRefused = t("files.hostWatchRefused", {
              reason: hostErrText(r.code, r.isOffline === true),
            });
          }
          refreshHostWatches();
          return;
        }
        // The id can land **after** the screen is gone: the `$effect` cleanup already ran and
        // saw `hostSubId === null`, so nothing else will ever release this watcher. Drop it
        // here instead of storing it — otherwise the host keeps the OS-level watcher (its own
        // thread + directory descriptors) alive, and every app-switch into Files adds one.
        if (hostDestroyed) {
          void hostFsWatchUnsubscribe(r.value.subscriptionId);
          return;
        }
        hostSubId = r.value.subscriptionId;
        refreshHostWatches();
      });
    });
  }

  $effect(() => {
    // One probe + one watch for the life of the screen. The event carries a
    // subscription id because the host serves every window from one process — a
    // second Files window's events must not drive this listing.
    startHostFs();
    const un = onHostFsEvent((ev) => {
      if (hostDestroyed) return;
      if (hostSubId !== null && ev.subscriptionId === hostSubId) loadHostDir(hostCwd);
    });
    return () => {
      un();
      if (hostSubId !== null) {
        void hostFsWatchUnsubscribe(hostSubId);
        hostSubId = null;
        refreshHostWatches();
      }
    };
  });

  // Torn down once for the life of the component, distinct from the `$effect` cleanup above
  // (which a re-run would also invoke). Any registration that resolves after this point
  // releases itself in `startHostFs`.
  onDestroy(() => {
    hostDestroyed = true;
  });
</script>

<div class={wide ? "flex h-full min-h-0" : "p-3"}>
  {#if wide}
    <!-- Tablet master-detail (iPadOS 文件): the folder hierarchy beside the listing.
         The width is the host's measured screen; a phone never reaches this branch
         (`lib/formLayout::masterDetail`). -->
    <aside
      class="flex h-full min-h-0 shrink-0 flex-col border-r border-neutral-200/70 dark:border-neutral-800"
      style={`width:${md.sidebarWidth}px`}
      aria-label={t("files.locations")}
      data-testid="files-sidebar"
    >
      <nav class="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <button
          onclick={() => selectCwd(undefined)}
          class={"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm " +
            (cwd === undefined
              ? "bg-accent/15 font-semibold text-accent"
              : "active:bg-black/5 dark:active:bg-white/5")}
          aria-current={cwd === undefined ? "page" : undefined}
          data-testid="files-side-root"
        >
          <span aria-hidden="true">{FOLDER}</span>
          <span class="min-w-0 truncate">{t("files.root")}</span>
        </button>
        {#each folderTree(list) as n (n.id)}
          <button
            onclick={() => selectCwd(n.id)}
            class={"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm " +
              (cwd === n.id
                ? "bg-accent/15 font-semibold text-accent"
                : "active:bg-black/5 dark:active:bg-white/5")}
            style={`padding-left:${0.75 + n.depth * 0.75}rem`}
            aria-current={cwd === n.id ? "page" : undefined}
            data-testid={`files-side-${n.id}`}
          >
            <span aria-hidden="true">{FOLDER}</span>
            <span class="min-w-0 truncate">{n.name}</span>
          </button>
        {/each}
      </nav>
    </aside>
  {/if}
  <div class={wide ? "min-h-0 flex-1 overflow-y-auto p-3" : "contents"} data-testid="files-detail">
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
          {allShownSelected ? t("files.selectNone") : t("files.selectAll", { n: display.length })}
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
      onRetry={retryAction ?? undefined}
      onDismiss={() => {
        currentError = null;
        isErrorStorm = false;
        retryAction = null;
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
                  aria-keyshortcuts="Meta+Y"
                  class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.preview")}</button>
                <button onclick={() => shareFile(e)} data-testid="files-share-{e.id}"
                  aria-label={t("files.shareAria", { name: e.name })}
                  class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.share")}</button>
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
          <!-- The file is the user's own: a captions track can only come from the file itself, and
               synthesizing one we do not have would put a claim on screen that nobody made. -->
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={previewPlan.src} controls class="max-h-96 w-full rounded" data-testid="preview-video"></video>
        {:else if previewPlan.kind === "empty"}
          <p class="text-xs opacity-60">{t("files.previewEmpty")}</p>
        {:else if previewPlan.kind === "unavailable"}
          <!-- Not a kind of file: a kind of *failure*. It gets its own branch so the panel
               never claims 「二进制文件」 (or nothing at all) about a file it could not read. -->
          <p class="text-xs opacity-60" data-testid="preview-unavailable">{t("files.previewUnavailable")}</p>
          <p class="mt-1 text-xs opacity-70" data-testid="preview-unavailable-reason">{previewUnavailableText(previewPlan)}</p>
        {:else}
          <p class="text-xs opacity-60" data-testid="preview-binary">{t("files.previewBinary")}</p>
        {/if}
        {#if previewPlan.error}
          <p class="mt-1 text-xs text-amber-600 dark:text-amber-400">{previewPlan.error}</p>
        {/if}
        {#if previewTrunc}
          <!-- The host read stopped at the read cap, so the preview is of a prefix. Same
               sentence the text `<pre>` uses for the same fact (`files.hostTruncated`). -->
          <p class="mt-1 text-xs text-amber-700 dark:text-amber-200" data-testid="preview-truncated">
            {t("files.hostTruncated")}
          </p>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Bundle export/import textbox.  The Rust `files_bundle_export` produces a
       base64-encoded gzip bundle; the WebView shows the text so the user can copy it,
       and 「保存到主机文件」 (REQ-A1443) writes those same bytes to the host filesystem
       through `host_fs_write_bytes` when a host root is configured. -->
  <details class="mt-3 rounded-xl bg-neutral-200/40 p-2 dark:bg-neutral-800/40" data-testid="bundle-section">
    <summary class="cursor-pointer text-xs font-semibold opacity-80">{t("files.exportBundle")} / {t("files.importFromDevice")}</summary>
    <textarea
      bind:value={importText}
      oninput={() => {
        // Typing changes the artifact the save report was about, so the report no longer holds.
        // (A programmatic `importText = …` on export does not fire this, which is why
        // `doExportBundle` clears the same two on its own.)
        bundleSaveMsg = "";
        bundleSaveOk = false;
      }}
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
    <!-- Only for a real host root: a button that always answers "not available" is the
         surface claiming a capability the host never granted. -->
    {#if hostReady}
      <button
        onclick={() => void saveBundleToHost()}
        disabled={bundleSaveBusy || !importText.trim()}
        data-testid="bundle-save-host"
        class="mt-2 rounded-full bg-accent/90 px-3 py-1 text-xs text-white disabled:opacity-50"
      >{t("files.bundleSaveToHost")}</button>
    {/if}
    {#if bundleSaveMsg}
      <p
        data-testid="bundle-save-msg"
        class="mt-1 text-xs {bundleSaveOk ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'}"
      >{bundleSaveMsg}</p>
    {/if}
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
          {cloudSnap.label} · {t("files.cloudItemCount", { n: cloudSnap.fileCount })} ·
          {formatSnapshotSize(cloudSnap.totalBytes)}
          · {new Date(cloudSnap.savedAt).toLocaleString()}
        </p>
      {:else}
        <p class="mt-1 text-xs opacity-60">{t("files.cloudEmpty")}</p>
      {/if}
      {#if cloudMsg}<p class="mt-1 text-xs text-green-700 dark:text-green-300">{cloudMsg}</p>{/if}
      <!-- The refusal: the shared bar (a refusal is not a success, so it does not go
           in `cloudMsg`'s green line). Rendered next to the controls that were pressed. -->
      <StoreErrorBar message={cloudErr} />
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
          <span class="text-xs opacity-50" data-testid="external-total">
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

  <!-- Host filesystem (fenced by AMOS_HOST_FS_ROOT). Rendered only when the
       bridge answered *and* the fence is a real directory — "off" and "bad" stay silent
       rather than posing as an empty folder. -->
  {#if hostReady}
    <section class="mt-4" aria-label={t("files.host")}>
      <div class="flex items-center justify-between px-1">
        <button
          onclick={() => (hostOpen = !hostOpen)}
          aria-pressed={hostOpen}
          class="text-sm font-semibold text-neutral-800 dark:text-neutral-200"
        >💻 {t("files.host")}</button>
        <span class="flex items-center gap-2">
          <!-- Shown regardless of the count below: a refused watch is exactly the case the
               count chip cannot express (it is hidden at zero), so it must not live behind the
               same condition (REQ-A1595 / F-SH-810). -->
          {#if hostWatchRefused}
            <span class="text-xs text-amber-700 dark:text-amber-200" data-testid="host-watch-refused">
              {hostWatchRefused}
            </span>
          {/if}
          <!-- The host reports every window's subscriptions from one process, so this counts
               watchers this screen does not own too — which is exactly what makes a leak
               visible instead of invisible (REQ-A1177). Hidden at zero: "0 watchers" is the
               ordinary state of a host nobody is watching. -->
          {#if hostWatchIds !== null && hostWatchIds.length > 0}
            <span class="text-xs opacity-50" data-testid="host-watch-count">
              {t("files.hostWatches", { n: hostWatchIds.length })}
            </span>
          {/if}
          <span class="text-xs opacity-50" data-testid="host-root">{hostRoot}</span>
        </span>
      </div>

      {#if hostOpen}
        <div class="mt-2 flex items-center gap-2">
          <button
            onclick={hostUp}
            disabled={hostBusy}
            aria-label={t("files.hostUp")}
            class="shrink-0 rounded-full bg-neutral-300 px-3 py-1 text-xs disabled:opacity-50 dark:bg-neutral-700"
          >↑ {t("files.hostUp")}</button>
          <span class="min-w-0 flex-1 truncate text-xs opacity-60" data-testid="host-cwd" title={hostRoot ?? ""}>
            {hostCwd === "" ? "/" : hostCwd}
          </span>
          <button
            onclick={hostBeginNewFolder}
            disabled={hostBusy || hostNameMode !== null}
            data-testid="host-new-folder"
            class="shrink-0 rounded-full bg-accent/90 px-3 py-1 text-xs text-white disabled:opacity-50"
          >{t("files.hostNewFolder")}</button>
          <button
            onclick={hostBeginNewFile}
            disabled={hostBusy || hostNameMode !== null}
            data-testid="host-new-file"
            class="shrink-0 rounded-full bg-accent/90 px-3 py-1 text-xs text-white disabled:opacity-50"
          >{t("files.hostNewFile")}</button>
        </div>

        {#if hostNameMode}
          <div class="mt-2 flex items-center gap-2">
            <input
              bind:value={hostNameValue}
              data-testid="host-name-input"
              aria-label={t(
                hostNameMode === "rename"
                  ? "files.hostRename"
                  : hostNameMode === "newfile"
                    ? "files.hostNewFile"
                    : "files.hostNewFolder",
              )}
              onkeydown={(ev) => {
                if (ev.key === "Enter") hostConfirmName();
                else if (ev.key === "Escape") hostCancelName();
              }}
              class="min-w-0 flex-1 rounded-full bg-black/5 px-3 py-1 text-sm outline-none ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
            />
            <button
              onclick={hostConfirmName}
              data-testid="host-name-confirm"
              class="shrink-0 rounded-full bg-accent px-3 py-1 text-xs text-white"
            >{t("files.hostConfirm")}</button>
            <button
              onclick={hostCancelName}
              data-testid="host-name-cancel"
              class="shrink-0 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700"
            >{t("files.cancel")}</button>
          </div>
        {/if}

        {#if hostErr}
          <div
            data-testid="host-error"
            role="status"
            class="mt-2 rounded-xl bg-amber-500/15 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-400/30 dark:text-amber-200"
          >{hostErr}</div>
        {/if}

        {#if hostStat}
          <!-- The listing says what a row was when the directory was read; this card says what
               the path is now. `exists: false` is the only evidence the user can get that the
               list on screen is stale, so it is drawn as a fact, not as a refusal. -->
          <div class="{CARD_GROUP} mt-2 p-3" data-testid="host-stat">
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 truncate text-xs opacity-60">{hostStat.path}</span>
              <button
                onclick={() => (hostStat = null)}
                aria-label={t("files.previewClose")}
                class="shrink-0 rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70"
              >✕</button>
            </div>
            <p class="mt-1 text-xs" data-testid="host-stat-line">{hostStatLine(hostStat)}</p>
          </div>
        {/if}

        {#if hostFile}
          <div class="{CARD_GROUP} mt-2 p-3" data-testid="host-file">
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 truncate text-xs opacity-60">{hostFile.path}</span>
              <button
                onclick={() => (hostFile = null)}
                aria-label={t("files.previewClose")}
                class="shrink-0 rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70"
              >✕</button>
            </div>
            {#if hostFile.truncated}
              <p class="mt-1 text-xs text-amber-700 dark:text-amber-200">{t("files.hostTruncated")}</p>
            {/if}
            <pre class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{hostFile.body}</pre>
          </div>
        {:else if hostListFailed}
          <!-- REQ-A542: the banner above already states the refusal; an "empty folder"
               line here would claim a fact nobody established (the listing never came back).
               Only a failed **read** hides the list — a refused mutation left the listing it
               happened in untouched, so it stays on screen with the refusal above it. -->
        {:else if hostEntries.length === 0}
          <p class="mt-2 text-center text-xs opacity-60">{hostBusy ? t("files.hostLoading") : t("files.hostEmpty")}</p>
        {:else}
          <div class="mt-1 {CARD_GROUP} divide-y divide-black/5 dark:divide-white/10">
            {#each hostEntries as e (e.path)}
              <div class="flex w-full items-center gap-1 px-3.5 py-2">
                <button
                  onclick={() => openHostEntry(e)}
                  data-testid="host-entry"
                  class="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span class="text-xl" aria-hidden="true">{e.isDir ? FOLDER : FILE}</span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm">{e.name}</span>
                    <span class="block text-xs opacity-50">{hostMeta(e)}</span>
                  </span>
                </button>
                <button
                  onclick={() => hostShowStat(e)}
                  disabled={hostBusy || hostStatBusy || hostMutating !== null || hostNameMode !== null}
                  aria-label={t("files.hostStat", { name: e.name })}
                  title={t("files.hostStat", { name: e.name })}
                  data-testid="host-stat-button"
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                >ⓘ</button>
                <button
                  onclick={() => hostBeginRename(e)}
                  disabled={hostBusy || hostMutating !== null || hostNameMode !== null}
                  aria-label={t("files.hostRename", { name: e.name })}
                  title={t("files.hostRename", { name: e.name })}
                  data-testid="host-rename"
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                >✏️</button>
                <button
                  onclick={() => hostDuplicate(e)}
                  disabled={hostBusy || hostMutating !== null || hostNameMode !== null}
                  aria-label={t("files.hostDuplicate", { name: e.name })}
                  title={t("files.hostDuplicate", { name: e.name })}
                  data-testid="host-duplicate"
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                >⧉</button>
                <button
                  onclick={() => hostDelete(e)}
                  disabled={hostBusy || hostMutating !== null || hostNameMode !== null}
                  aria-label={t("files.hostDelete", { name: e.name })}
                  title={t("files.hostDelete", { name: e.name })}
                  data-testid="host-delete"
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                >🗑️</button>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </section>
  {/if}
  </div>
</div>

