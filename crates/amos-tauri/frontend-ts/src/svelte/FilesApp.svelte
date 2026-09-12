<script lang="ts">
  // FilesApp.svelte — Svelte 5 (runes) implementation of the file manager. All
  // logic reuses pure lib/files.ts. Feature-complete (create folder/file, rename,
  // move, single + multi-select batch delete/move, favorites, search, sort,
  // all/fav/recent views). The former React body was removed in the subtraction
  // phase — this is the only implementation, mounted by `appRegistry`.
  import {
    FILES_FAV_KEY,
    FILES_KEY,
    addEntry,
    childrenOf,
    deleteEntries,
    deleteEntry,
    filterByName,
    folderPath,
    folderTree,
    hasName,
    makeEntry,
    moveEntries,
    moveEntry,
    normalizeFiles,
    pathOf,
    recentFiles,
    renameEntry,
    searchFiles,
    sortChildren,
    toggleFav,
  } from "../lib/files";
  import type { FEntry, SortKey } from "../lib/files";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { fmtTime } from "../lib/notes";
  import { canonicalPath, hasMediaBridge, mediaGrantRead, mediaList, type StandardDir } from "../lib/media";
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
  import { t } from "./locale.svelte";
  import { filesChannel } from "./appLinks";

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
  const GROUP =
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
  let creating = $state<null | "folder" | "file">(null);
  let name = $state("");
  let content = $state("");
  let err = $state("");
  // The store refused a write (full/unavailable): say so and keep showing the truth.
  let storeErr = $state("");
  let renameId = $state<string | null>(null);
  let renameVal = $state("");
  let cutId = $state<string | null>(null);
  let sortKey = $state<SortKey>("default");
  let query = $state("");
  let globalSearch = $state(false);
  let mode = $state<"all" | "fav" | "recent">("all");
  const initFavs = readStoreValue<string[]>(FILES_FAV_KEY, []);
  let favs = $state<string[]>(initFavs);
  let selecting = $state(false);
  let selIds = $state<ReadonlySet<string>>(new Set());
  /** Entry a Spotlight link asked to reveal (marked while on screen; `null` = none). */
  let spotId = $state<string | null>(null);
  let linkNonce = 0;

  const persist = (l: FEntry[]): boolean => {
    if (!writeStoreValueChecked(FILES_KEY, l)) {
      storeErr = t("common.storeWriteFailed");
      return false;
    }
    storeErr = "";
    list = l;
    return true;
  };
  const fav = (id: string) => {
    const next = toggleFav(favs, id);
    if (!writeStoreValueChecked(FILES_FAV_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
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
  };
  const toggleSelectAll = () => {
    const visible = display.map((e) => e.id);
    if (visible.length === 0) return;
    const hasAll = visible.every((id) => selIds.has(id));
    selIds = hasAll ? new Set() : new Set(visible);
  };
  const deleteSelected = () => {
    if (selIds.size === 0) return;
    persist(deleteEntries(list, selIds));
    exitSelect();
  };
  const moveSelectedTo = (destId: string) => {
    if (selIds.size === 0) return;
    persist(moveEntries(list, selIds, destId === "__root" ? undefined : destId));
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
      const target = list.find((e) => e.id === v.id);
      if (target) {
        mode = "all";
        globalSearch = false;
        query = "";
        exitSelect();
        cwd = target.parent; // show the entry where it actually lives
        spotId = target.id;
      }
      filesChannel().set({ id: "", nonce: linkNonce });
    });
  });

  const openFolder = (id: string) => {
    if (globalSearch) {
      globalSearch = false;
      query = "";
    }
    spotId = null; // navigating away ends the "here it is" mark
    cwd = id;
  };
  const cycleSort = () =>
    (sortKey = sortKey === "default" ? "name" : sortKey === "name" ? "time" : "default");
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
      return;
    }
    const entry = makeEntry(creating ?? "folder", v, cwd, Date.now());
    if (creating === "file") entry.content = content;
    // Keep the create form (and its typed name/content) if the store rejected it.
    if (!persist(addEntry(list, entry))) return;
    creating = null;
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
      return;
    }
    // A rejected rename keeps the inline input open with the typed name.
    if (!persist(renameEntry(list, renameId, v))) return;
    renameId = null;
  };
  const doCut = (id: string) => (cutId = id);
  const moveHere = () => {
    if (!cutId) return;
    persist(moveEntry(list, cutId, cwd));
    cutId = null;
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

  <!-- view: all / favorites / recent -->
  <div class="mt-2 flex flex-wrap gap-1.5">
    <button onclick={() => (mode = "all")} aria-pressed={mode === "all"} class={chip(mode === "all")}>{t("files.all")}</button>
    <button onclick={() => (mode = "fav")} aria-pressed={mode === "fav"} class={chip(mode === "fav")}>{t("files.fav")}</button>
    <button onclick={() => (mode = "recent")} aria-pressed={mode === "recent"} class={chip(mode === "recent")}>{t("files.recent")}</button>
  </div>

  <!-- search + sort -->
  <div class="mt-2 flex items-center gap-2">
    <input bind:value={query} placeholder={t("files.search")} aria-label="file-search"
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
      <input bind:value={name} placeholder={t("files.name")} aria-label="file-new-name"
        class="w-full rounded-lg bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900" />
      {#if creating === "file"}
        <span class="block text-xs opacity-60">{t("files.content")}</span>
        <textarea bind:value={content} rows={2} aria-label="file-new-content"
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
      <input bind:value={renameVal} aria-label="file-rename"
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
    <div class="divide-y divide-black/5 dark:divide-white/10 mt-2 {GROUP}">
      {#each display as e (e.id)}
        {@const isFolder = e.type === "folder"}
        {@const isSel = selecting && selIds.has(e.id)}
        {@const actionable = selecting || isFolder}
        <div class="flex items-center gap-2 {isSel || spotId === e.id ? 'bg-accent/15' : ''}" data-spotlight={spotId === e.id ? "hit" : undefined}>
          <button
            type="button"
            onclick={actionable ? (selecting ? () => toggleSel(e.id) : () => openFolder(e.id)) : undefined}
            class={"flex min-w-0 flex-1 items-center gap-2 px-3.5 py-2.5 text-left " + (isFolder && !selecting ? "cursor-pointer" : "")}
          >
            {#if selecting}
              <span class={"grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold " +
                (isSel ? "bg-accent text-white" : "bg-black/15 dark:bg-white/15")}>{isSel ? "✓" : ""}</span>
            {/if}
            <span class="text-xl">{isFolder ? FOLDER : FILE}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{e.name}</span>
              <span class="block text-xs opacity-50">{globalSearch ? folderPath(list, e.id) || t("files.root") : fmtTime(e.ts)}</span>
            </span>
          </button>
          {#if !selecting}
            <div class="flex gap-1 pr-2">
              <button onclick={() => fav(e.id)} aria-label="favorite"
                class={"rounded-full px-2 py-0.5 text-xs " + (favs.includes(e.id) ? "text-amber-500" : "text-neutral-400")}>
                {favs.includes(e.id) ? "★" : "☆"}
              </button>
              <button onclick={() => beginRename(e.id, e.name)} class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.rename")}</button>
              <button onclick={() => doCut(e.id)} class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs dark:bg-neutral-700/70">{t("files.move")}</button>
              <button onclick={() => persist(deleteEntry(list, e.id))} class="rounded-full bg-neutral-300/70 px-2 py-0.5 text-xs text-danger dark:bg-neutral-700/70">{t("files.delete")}</button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
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
              aria-label="external-search"
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
              <div class="mt-1 {GROUP} divide-y divide-black/5 dark:divide-white/10">
                {#each g.files as f (f.id)}
                  <div class="flex items-center gap-2 px-3.5 py-2" data-testid="external-file">
                    <span class="text-xl" aria-hidden="true">{externalGlyph(f.kind)}</span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm">{f.name}</span>
                      <span class="block text-xs opacity-50">
                        {formatBytes(f.sizeBytes)} · {f.ts ? fmtTime(f.ts) : "—"} · {t("files.externalReadOnly")}
                      </span>
                    </span>
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

