<script lang="ts">
  // AppLibrary.svelte — iOS-style "App Library" screen: groups every installed
  // (non-hidden) built-in app into category folders, with a "Frequently Used"
  // group on top (live from amos.recents, dock fallback) and an iOS-like live
  // search. Keeps the paged home grid untouched.
  //
  // A CONTROLLED leaf shared by both shells (React production via SveltePropsHost
  // "appLibrary", and the standalone Svelte Shell): the host owns navigation +
  // the layout and pushes { layout } down over propsChannel("appLibrary"); the
  // screen emits "open"(id) / "back" back up the same channel. Category folders
  // expand into an internal full-grid view (no extra surface).
  import { t } from "./locale.svelte";
  import { appIcon, appTitleKey, appIds } from "../lib/appMeta";
  import { getRecents, type HomeLayout } from "../lib/amosStore";
  import {
    categorizeApps,
    frequentTools,
    type CategoryFolder,
  } from "../lib/appGroups";
  import type { StoreTile } from "../lib/storeApps";
  import {
    getCustomGroups,
    addCustomGroup,
    removeCustomGroup,
    setGroupApps,
    renameCustomGroup,
    setGroupIcon,
    type CustomGroup,
  } from "../lib/customGroups";
  import { propsChannel } from "./propsBus";
  import AppIcon from "./AppIcon.svelte";

  interface FolderView {
    folder: CategoryFolder;
  }

  // ---- Controlled leaf: the hosting shell (React production or Svelte standalone)
  // owns navigation + the home layout and pushes it down over propsChannel
  // ("appLibrary"); the screen reports one-shot actions (open / back) back up the
  // same channel. Same pattern as HomeDock("home") / EditHome("editHome"). ----
  interface LibraryProps {
    layout: HomeLayout;
    /** Store-installed (third-party) tiles the shell owns (merged into layout). */
    ext?: StoreTile[];
  }
  const bus = propsChannel<LibraryProps>("appLibrary");
  let incoming = $state<LibraryProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const EMPTY_LAYOUT: HomeLayout = { page: [], dock: [], hidden: [] };
  const homeLayout = $derived(incoming?.layout ?? EMPTY_LAYOUT);
  const ext = $derived(incoming?.ext ?? []);
  const extById = $derived(new Map(ext.map((e) => [e.id, e])));
  // Apps that currently exist (built-in or installed third-party). Members pointing
  // at removed/uninstalled apps are reconciled out so we never render ghosts.
  const knownIds = $derived(new Set([...appIds(), ...ext.map((e) => e.id)]));

  const openId = (id: string) => bus.emit("open", id);
  const backHome = () => bus.emit("back");

  // All installed apps (built-ins + store-installed) that are not hidden-from-home.
  const hidden = $derived(new Set(homeLayout.hidden));
  const available = $derived([
    ...appIds().filter((id) => !hidden.has(id)),
    ...ext.map((e) => e.id).filter((id) => !hidden.has(id)),
  ]);
  const folders = $derived(categorizeApps(available));

  // Frequently-used group: live from recents; until anything has been opened,
  // fall back to the dock (the tools the user pinned) so the top group is never
  // empty on a fresh boot.
  const frequent = $derived.by(() => {
    const fromRecents = frequentTools(getRecents(), available, 8);
    if (fromRecents.length > 0) return fromRecents;
    return homeLayout.dock.filter((id) => !hidden.has(id)).slice(0, 8);
  });

  const labelOf = (id: string): string => {
    const key = appTitleKey(id);
    if (key) return t(key);
    return extById.get(id)?.name ?? id;
  };
  const iconOf = (id: string): string => {
    const key = appTitleKey(id);
    if (key) return appIcon(id);
    return extById.get(id)?.icon ?? "🧩";
  };

  // ---- iOS-style live search: filter apps by (localized) name across groups. ----
  let query = $state("");
  const q = $derived(query.trim().toLowerCase());
  const matchesQuery = (id: string): boolean =>
    !q || labelOf(id).toLowerCase().includes(q) || id.toLowerCase().includes(q);
  // Folders keep only matching apps; empty ones drop out while searching.
  const foldersShown = $derived(
    folders
      .map((f) => ({ id: f.id, nameKey: f.nameKey, apps: f.apps.filter(matchesQuery) }))
      .filter((f) => f.apps.length > 0),
  );
  const frequentShown = $derived(frequent.filter(matchesQuery));
  const noResults = $derived(q.length > 0 && foldersShown.length === 0 && frequentShown.length === 0);
  const matchCount = $derived(foldersShown.reduce((n, f) => n + f.apps.length, 0));

  /** Split a label into plain / highlighted segments around the query (for <mark>). */
  interface Seg {
    text: string;
    hit: boolean;
  }
  function splitMatch(text: string): Seg[] {
    if (!q) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const out: Seg[] = [];
    let from = 0;
    let at = lower.indexOf(q);
    while (at !== -1) {
      if (at > from) out.push({ text: text.slice(from, at), hit: false });
      out.push({ text: text.slice(at, at + q.length), hit: true });
      from = at + q.length;
      at = lower.indexOf(q, from);
    }
    if (from < text.length) out.push({ text: text.slice(from), hit: false });
    return out.length > 0 ? out : [{ text, hit: false }];
  }

  let openView = $state<FolderView | null>(null);

  let searchEl = $state<HTMLInputElement | undefined>();
  let renameInputEl = $state<HTMLInputElement | undefined>();
  function clearSearch(): void {
    query = "";
    searchEl?.focus();
  }

  // ---- User-created groups ----
  let customGroups = $state<CustomGroup[]>(getCustomGroups());
  let nameError = $state("");

  // Name dedup (case-insensitive) so two groups never share a label.
  function hasName(name: string, exceptId?: string): boolean {
    const t = name.trim().toLowerCase();
    return customGroups.some(
      (g) => g.id !== exceptId && g.name.trim().toLowerCase() === t,
    );
  }
  // iOS-like: tapping "＋" creates a folder immediately with a unique default name
  // (新建文件夹 / New Folder, numbered 2/3/… when needed) and opens it for rename.
  function createNewGroup(): void {
    const base = t("appLibrary.newFolder");
    let name = base;
    for (let n = 2; hasName(name); n++) name = `${base} ${n}`;
    const res = addCustomGroup(customGroups, name);
    customGroups = res.groups;
    const created = res.created;
    openGroup = { id: created.id, name: created.name, apps: [], icon: undefined };
    editingMembers = false;
    pickingIcon = false;
    renaming = true; // straight into "rename this new folder"
    renameText = created.name;
    nameError = "";
  }

  // Focus the rename field whenever it appears (new-folder flow / rename action).
  $effect(() => {
    if (renaming && openGroup) renameInputEl?.focus();
  });

  // ---- Custom group open + membership editing ----
  let openGroup = $state<CustomGroup | null>(null);
  let editingMembers = $state(false);
  let renaming = $state(false);
  let renameText = $state("");

  function startRename(): void {
    renameText = openGroup?.name ?? "";
    nameError = "";
    pickingIcon = false;
    renaming = true;
  }
  function cancelRename(): void {
    renaming = false;
    nameError = "";
  }
  function commitRename(): void {
    const g = openGroup;
    const trimmed = renameText.trim();
    if (!g || !trimmed) return;
    if (trimmed === g.name) {
      renaming = false;
      nameError = "";
      return;
    }
    if (hasName(trimmed, g.id)) {
      nameError = t("appLibrary.nameTaken");
      return;
    }
    nameError = "";
    customGroups = renameCustomGroup(customGroups, g.id, trimmed);
    openGroup = { ...g, name: trimmed };
    renaming = false;
  }

  // ---- Group icon picker (custom emoji; default folder when absent) ----
  const PRESET_ICONS = ["📁", "❤️", "⭐", "📚", "🎮", "🎵", "📷", "💼", "🍿", "✈️", "🛠️", "🧘"];
  let pickingIcon = $state(false);
  function toggleIconPicker(): void {
    pickingIcon = !pickingIcon;
  }
  function chooseIcon(icon: string | undefined): void {
    const g = openGroup;
    if (!g) return;
    customGroups = setGroupIcon(customGroups, g.id, icon);
    openGroup = { ...g, icon: icon ? icon : undefined };
    pickingIcon = false;
  }

  function openCustomGroup(id: string): void {
    const g = customGroups.find((x) => x.id === id);
    if (!g) return;
    const apps = g.apps.filter((a) => knownIds.has(a));
    if (apps.length !== g.apps.length) {
      // Some members no longer exist — reconcile the stored group.
      customGroups = setGroupApps(customGroups, g.id, apps);
    }
    openGroup = { id: g.id, name: g.name, apps: [...apps], icon: g.icon };
    editingMembers = false;
    renaming = false;
    pickingIcon = false;
    nameError = "";
  }
  function closeCustomGroup(): void {
    openGroup = null;
    editingMembers = false;
    renaming = false;
    pickingIcon = false;
    nameError = "";
  }
  function toggleMember(id: string): void {
    const g = openGroup;
    if (!g) return;
    const has = g.apps.includes(id);
    const apps = has ? g.apps.filter((x) => x !== id) : [...g.apps, id];
    customGroups = setGroupApps(customGroups, g.id, apps);
    openGroup = { ...g, apps };
  }
  function deleteOpenGroup(): void {
    if (!openGroup) return;
    customGroups = removeCustomGroup(customGroups, openGroup.id);
    closeCustomGroup();
  }

  // Snapshot helpers so the template never needs to narrow openGroup itself.
  const openGroupName = $derived(openGroup?.name ?? "");
  const openGroupIcon = $derived(openGroup?.icon ?? "📁");
  const memberApps = $derived(openGroup?.apps ?? []);
  const memberSet = $derived(new Set(openGroup?.apps ?? []));

  // ---- Member drag-to-reorder (fine-pointer): move one member before another ----
  let dragMember = $state<string | null>(null);
  // Some browsers fire a stray click on the drop target right after a drop; ignore
  // taps for a beat so a drag-reorder never accidentally opens the app.
  let ignoreTapUntil = 0;
  function moveAppBefore(list: string[], drag: string, over: string): string[] {
    const out = list.filter((x) => x !== drag);
    const i = out.indexOf(over);
    if (i < 0) return out;
    out.splice(i, 0, drag);
    return out;
  }
  function memberDragStart(id: string): void {
    dragMember = id;
  }
  // Touch-friendly micro-reorder (works regardless of pointer type).
  let sorting = $state(false);
  const sortable = $derived(memberApps.length > 1);
  function shiftMember(index: number, dir: -1 | 1): void {
    const g = openGroup;
    if (!g) return;
    const to = index + dir;
    if (to < 0 || to >= g.apps.length) return;
    const apps = [...g.apps];
    const a = apps[index];
    const b = apps[to];
    if (a === undefined || b === undefined) return;
    apps[index] = b;
    apps[to] = a;
    customGroups = setGroupApps(customGroups, g.id, apps);
    openGroup = { ...g, apps };
  }
  function memberDragOver(e: DragEvent): void {
    e.preventDefault();
  }
  function memberDragEnd(): void {
    // Clean up even if the drop landed outside a member tile.
    dragMember = null;
  }
  function memberDrop(over: string): void {
    const g = openGroup;
    const d = dragMember;
    dragMember = null;
    if (g && d && d !== over && g.apps.includes(d) && g.apps.includes(over)) {
      const apps = moveAppBefore([...g.apps], d, over);
      customGroups = setGroupApps(customGroups, g.id, apps);
      openGroup = { ...g, apps };
    }
    ignoreTapUntil = Date.now() + 400;
  }
  function openMember(id: string): void {
    if (Date.now() < ignoreTapUntil) return;
    openId(id);
  }
  function addGroupToDock(): void {
    const avail = new Set(available);
    const ids = (openGroup?.apps ?? []).filter((id) => avail.has(id));
    if (ids.length === 0) return;
    bus.emit("dockAdd", ids);
  }



  // While the library search is active, Esc clears the query (and keeps focus in
  // the box) so it is easy to start a new search — iOS-spotlight-like.
  $effect(() => {
    if (!q) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        clearSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>
<div class="fx-fade flex h-full flex-col" data-testid="app-library">
  <!-- Library home -->
  {#if openGroup !== null}
    {#if editingMembers}
      <!-- Custom group: add/remove member apps -->
      <div class="flex h-full flex-col px-4 pb-3 pt-3" data-testid="app-library-custom-edit">
        <div class="flex items-center justify-between">
          <button onclick={closeCustomGroup} aria-label="back" class="w-6 text-accent text-sm font-semibold">‹</button>
          <span class="flex-1 truncate text-center text-base font-semibold">{openGroupIcon} {openGroupName}</span>
          <button
            type="button"
            data-testid="app-library-done-members"
            onclick={() => (editingMembers = false)}
            class="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white transition active:scale-95"
          >{t("common.done")}</button>
        </div>
        <p class="mt-3 px-1 text-xs opacity-60">{t("appLibrary.editMembers")}</p>
        <div class="mt-1 min-h-0 flex-1 divide-y divide-black/5 overflow-y-auto rounded-2xl bg-white/40 px-1 shadow-sm ring-1 ring-black/5 backdrop-blur-md dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
          {#each available as id (id)}
            <button
              type="button"
              aria-pressed={memberSet.has(id)}
              aria-label={labelOf(id)}
              onclick={() => toggleMember(id)}
              class="flex w-full items-center gap-3 px-1.5 py-2 text-left text-sm outline-none transition active:bg-accent/10"
            >
              <AppIcon id={id} icon={iconOf(id)} tileClassName="h-9 w-9 rounded-[11px]" glyphClassName="text-[20px]" />
              <span class="min-w-0 flex-1 truncate font-medium text-neutral-800 dark:text-neutral-200">{@render name(id)}</span>
              <span
                class={
                  "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium " +
                  (memberSet.has(id)
                    ? "bg-danger/15 text-danger"
                    : "bg-accent/15 text-accent")
                }
              >{memberSet.has(id) ? t("appLibrary.remove") : t("appLibrary.add")}</span>
            </button>
          {/each}
        </div>
      </div>
    {:else}
      <!-- Custom group: view members -->
      <div class="flex h-full flex-col px-4 pb-3 pt-3" data-testid="app-library-custom-open">
        <div class="flex items-center justify-between">
          <button onclick={closeCustomGroup} aria-label="back" class="w-6 text-accent text-sm font-semibold">‹</button>
          <span class="flex-1 truncate text-center text-base font-semibold">{openGroupIcon} {openGroupName}</span>
          <span class="w-6"></span>
        </div>
        {#if renaming}
          <div class="mt-2 flex items-center gap-2">
            <label class="sr-only" for="app-library-rename-input">{t("appLibrary.renameGroup")}</label>
            <input
              id="app-library-rename-input"
              type="text"
              data-testid="app-library-rename-input"
              bind:this={renameInputEl}
              bind:value={renameText}
              placeholder={t("appLibrary.groupName")}
              onkeydown={(e) => {
                if (e.key === "Enter") commitRename();
              }}
              class="w-full min-w-0 flex-1 rounded-full bg-white/40 px-3 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:opacity-50 focus:ring-2 focus:ring-accent/60 dark:bg-white/10 dark:ring-white/10"
            />
            <button
              type="button"
              data-testid="app-library-rename-save"
              onclick={commitRename}
              class="rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white transition active:scale-90"
            >{t("appLibrary.save")}</button>
            <button
              type="button"
              data-testid="app-library-rename-cancel"
              onclick={cancelRename}
              class="rounded-full bg-neutral-200/70 px-3 py-1.5 text-xs font-medium text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-neutral-200"
            >{t("appLibrary.cancel")}</button>
          </div>
          {#if nameError}
            <p class="mt-1 px-1 text-xs text-danger">{nameError}</p>
          {/if}
        {:else}
          <div class="mt-2 flex items-center justify-end gap-2">
            {#if sortable}
              <button
                type="button"
                data-testid="app-library-sort-toggle"
                aria-pressed={sorting}
                onclick={() => (sorting = !sorting)}
                class="rounded-full bg-neutral-200/70 px-3 py-1 text-xs font-medium text-neutral-700 transition active:scale-95 dark:bg-white/10 dark:text-neutral-200"
              >{sorting ? t("common.done") : t("appLibrary.sort")}</button>
            {/if}
            <button
              type="button"
              data-testid="app-library-rename"
              onclick={startRename}
              class="rounded-full bg-neutral-200/70 px-3 py-1 text-xs font-medium text-neutral-700 transition active:scale-95 dark:bg-white/10 dark:text-neutral-200"
            >{t("appLibrary.renameGroup")}</button>
            <button
              type="button"
              data-testid="app-library-icon-toggle"
              aria-pressed={pickingIcon}
              onclick={toggleIconPicker}
              class="rounded-full bg-neutral-200/70 px-3 py-1 text-xs font-medium text-neutral-700 transition active:scale-95 dark:bg-white/10 dark:text-neutral-200"
            >{t("appLibrary.icon")}</button>
            <button
              type="button"
              data-testid="app-library-group-delete"
              onclick={deleteOpenGroup}
              class="rounded-full bg-danger/10 px-3 py-1 text-xs font-medium text-danger transition active:scale-95"
            >{t("appLibrary.deleteGroup")}</button>
            <button
              type="button"
              data-testid="app-library-edit-members"
              onclick={() => (editingMembers = true)}
              class="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white transition active:scale-95"
            >{t("appLibrary.editMembers")}</button>
          </div>
        {/if}
        {#if pickingIcon}
          <div class="mt-2 rounded-2xl bg-white/40 p-2 shadow-sm ring-1 ring-black/5 dark:bg-white/5 dark:ring-white/10">
            <p class="mb-1.5 px-1 text-xs opacity-60">{t("appLibrary.icon")}：{openGroup?.icon ?? "📁"}</p>
            <div class="flex flex-wrap gap-1.5">
              {#each PRESET_ICONS as ic (ic)}
                <button
                  type="button"
                  aria-label={ic}
                  data-testid="app-library-icon-choice"
                  onclick={() => chooseIcon(ic)}
                  class="grid h-9 w-9 cursor-pointer place-items-center rounded-lg bg-white/60 text-xl transition active:scale-90 dark:bg-white/10"
                >{ic}</button>
              {/each}
              <button
                type="button"
                data-testid="app-library-icon-clear"
                onclick={() => chooseIcon(undefined)}
                class="rounded-full bg-neutral-200/70 px-2.5 py-1 text-xs font-medium text-neutral-700 transition active:scale-90 dark:bg-white/10 dark:text-neutral-200"
              >{t("appLibrary.defaultIcon")}</button>
            </div>
          </div>
        {/if}
        <div class="mt-3 min-h-0 flex-1 overflow-y-auto">
          {#if memberApps.length === 0}
            <p class="px-1 pt-14 text-center text-sm opacity-60">{t("appLibrary.emptyMembers")}</p>
          {:else}
            <div class="grid grid-cols-4 gap-y-5">
              {#each memberApps as id, index (id)}
                {#if sorting}
                  <div class="flex w-full flex-col items-center gap-0.5">
                    <AppIcon
                      id={id}
                      icon={iconOf(id)}
                      tileClassName="h-12 w-12 rounded-[17px] opacity-90"
                      glyphClassName="text-[2rem]"
                    />
                    <span class="max-w-full truncate text-[10px] font-medium text-neutral-800 dark:text-neutral-200">{@render name(id)}</span>
                    <span class="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`${labelOf(id)} ${t("appLibrary.moveUp")}`}
                        data-testid="app-library-member-up"
                        onclick={() => shiftMember(index, -1)}
                        disabled={index === 0}
                        class="grid h-6 w-6 cursor-pointer place-items-center rounded-full bg-neutral-200/80 text-[10px] text-neutral-700 transition active:scale-90 disabled:cursor-default disabled:opacity-30 dark:bg-white/10 dark:text-neutral-200"
                      >▲</button>
                      <button
                        type="button"
                        aria-label={`${labelOf(id)} ${t("appLibrary.moveDown")}`}
                        data-testid="app-library-member-down"
                        onclick={() => shiftMember(index, 1)}
                        disabled={index === memberApps.length - 1}
                        class="grid h-6 w-6 cursor-pointer place-items-center rounded-full bg-neutral-200/80 text-[10px] text-neutral-700 transition active:scale-90 disabled:cursor-default disabled:opacity-30 dark:bg-white/10 dark:text-neutral-200"
                      >▼</button>
                    </span>
                  </div>
                {:else}
                  <button
                    aria-label={labelOf(id)}
                    title={labelOf(id)}
                    draggable="true"
                    ondragstart={() => memberDragStart(id)}
                    ondragover={memberDragOver}
                    ondrop={() => memberDrop(id)}
                    ondragend={memberDragEnd}
                    onclick={() => openMember(id)}
                    class="group flex w-full flex-col items-center gap-1 outline-none"
                  >
                    <AppIcon
                      id={id}
                      icon={iconOf(id)}
                      tileClassName="h-14 w-14 rounded-[19px] transition group-hover:-translate-y-0.5 group-active:scale-90"
                      glyphClassName="text-[2.5rem]"
                    />
                    <span class="max-w-full truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">{@render name(id)}</span>
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
          {#if memberApps.length > 0}
            <div class="mt-2 flex justify-center">
              <button
                type="button"
                data-testid="app-library-dock-add"
                onclick={addGroupToDock}
                class="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-white transition active:scale-95"
              >{t("appLibrary.toDock")}</button>
            </div>
          {/if}

      </div>
    {/if}
  {:else if openView === null}
    <div class="flex h-full flex-col px-4 pb-3 pt-3">
      <div class="flex items-center justify-between">
        <button onclick={backHome} class="w-6 text-accent text-sm font-semibold" aria-label="back">‹</button>
        <div class="flex-1 text-center">
          <h2 class="text-lg font-semibold tracking-tight">{t("appLibrary.title")}</h2>
          <p class="text-[10px] opacity-50">{t("appLibrary.hint")}</p>
        </div>
        <span class="w-6"></span>
      </div>

      <div class="mt-3 px-1">
        <div class="flex items-center gap-2 rounded-full bg-white/40 px-3 py-1.5 shadow-sm ring-1 ring-black/5 backdrop-blur-md transition focus-within:ring-2 focus-within:ring-accent/60 dark:bg-white/10 dark:ring-white/10">
          <span aria-hidden="true" class="text-sm opacity-60">🔍</span>
          <label for="app-library-search" class="sr-only">{t("appLibrary.searchPlaceholder")}</label>
          <input
            id="app-library-search"
            type="search"
            data-testid="app-library-search"
            bind:value={query}
            bind:this={searchEl}
            placeholder={t("appLibrary.searchPlaceholder")}
            autocomplete="off"
            class="w-full bg-transparent text-sm outline-none placeholder:opacity-50"
          />
          {#if query}
            <button
              type="button"
              aria-label="clear search"
              onclick={clearSearch}
              class="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full bg-neutral-300 text-[10px] text-neutral-700 transition active:scale-90 dark:bg-neutral-600 dark:text-neutral-200"
            >✕</button>
          {/if}
        </div>
      </div>

      <div class="mt-3 min-h-0 flex-1 overflow-y-auto pb-2">
        {#if q.length === 0}
          {#if frequentShown.length > 0}
            <p class="px-1 text-xs font-medium opacity-70">{t("appLibrary.frequent")}</p>
            <div
              data-testid="app-library-frequent"
              class="mt-1 grid grid-cols-4 gap-x-1 gap-y-3 rounded-3xl bg-white/30 p-3 shadow-sm ring-1 ring-black/5 backdrop-blur-md dark:bg-white/5 dark:ring-white/10"
            >
              {#each frequentShown as id (id)}
                <button
                  aria-label={labelOf(id)}
                  title={labelOf(id)}
                  onclick={() => openId(id)}
                  class="flex w-full flex-col items-center gap-1 outline-none transition active:scale-90"
                >
                  <AppIcon
                    id={id}
                    icon={iconOf(id)}
                    tileClassName="h-12 w-12 rounded-[17px]"
                    glyphClassName="text-[2rem]"
                  />
                  <span class="max-w-full truncate text-[10px] font-medium text-neutral-800 dark:text-neutral-200">{@render name(id)}</span>
                </button>
              {/each}
            </div>
          {/if}

          {#if foldersShown.length > 0}
            <div data-testid="app-library-folders" class="mt-4 grid grid-cols-4 gap-x-2 gap-y-4">
              {#each foldersShown as f (f.id)}
                <button
                  type="button"
                  data-testid="app-library-folder"
                  aria-label={t(f.nameKey)}
                  onclick={() => (openView = { folder: f })}
                  class="group flex flex-col items-center gap-1.5 outline-none"
                >
                  <span class="relative grid h-16 w-16 place-items-center rounded-2xl bg-white/40 p-1.5 shadow-sm ring-1 ring-black/5 transition group-hover:scale-[1.03] group-active:scale-95 dark:bg-white/10 dark:ring-white/10">
                    <span class="grid w-full grid-cols-2 place-items-center gap-0.5">
                      {#each f.apps.slice(0, 4) as id (id)}
                        <AppIcon
                          id={id}
                          icon={iconOf(id)}
                          tileClassName="h-6 w-6 rounded-[8px]"
                          glyphClassName="text-[14px]"
                        />
                      {/each}
                    </span>
                    {#if f.apps.length > 4}
                      <span class="absolute -right-1 -top-1 rounded-full bg-neutral-500/90 px-1 text-[9px] font-semibold leading-4 text-white ring-2 ring-white dark:bg-neutral-700 dark:ring-neutral-900">{t("appLibrary.more", { n: f.apps.length - 4 })}</span>
                    {/if}
                  </span>
                  <span class="max-w-full truncate text-[10px] font-medium text-neutral-800 dark:text-neutral-200">{t(f.nameKey)}</span>
                </button>
              {/each}
            </div>
          {/if}
          <!-- User-created groups (empty for now; membership comes later) -->
          {#if customGroups.length > 0}
            <p class="mt-4 px-1 text-xs font-medium opacity-70">{t("appLibrary.customSection")}</p>
          {/if}
          <div data-testid="app-library-custom" class="mt-2 grid grid-cols-4 gap-x-2 gap-y-4">
            {#each customGroups as g (g.id)}
              {@const gKnown = g.apps.filter((a) => knownIds.has(a))}
              <button
                type="button"
                data-testid="app-library-custom-group"
                aria-label={g.name}
                title={g.name}
                onclick={() => openCustomGroup(g.id)}
                class="group flex flex-col items-center gap-1.5 outline-none"
              >
                <span class="relative grid h-16 w-16 place-items-center rounded-2xl border-2 border-dashed border-neutral-300 bg-white/25 p-1.5 shadow-sm transition group-hover:scale-[1.03] group-active:scale-95 dark:border-neutral-700 dark:bg-white/5">
                  {#if gKnown.length > 0}
                    <span class="grid w-full grid-cols-2 place-items-center gap-0.5">
                      {#each gKnown.slice(0, 4) as id (id)}
                        <AppIcon
                          id={id}
                          icon={iconOf(id)}
                          tileClassName="h-6 w-6 rounded-[8px]"
                          glyphClassName="text-[14px]"
                        />
                      {/each}
                    </span>
                    {#if gKnown.length > 4}
                      <span class="absolute -right-1 -top-1 rounded-full bg-neutral-500/90 px-1 text-[9px] font-semibold leading-4 text-white ring-2 ring-white dark:bg-neutral-700 dark:ring-neutral-900">{t("appLibrary.more", { n: gKnown.length - 4 })}</span>
                    {/if}
                  {:else}
                    <span aria-hidden="true" class="grid place-items-center text-[24px] leading-none drop-shadow-sm">{g.icon ?? "📁"}</span>
                  {/if}
                </span>
                <span class="max-w-full truncate text-[10px] font-medium text-neutral-800 dark:text-neutral-200">{g.name}</span>
              </button>
            {/each}

              <button
                type="button"
                data-testid="app-library-new-group"
                aria-label={t("appLibrary.newGroup")}
                onclick={createNewGroup}
                class="flex flex-col items-center gap-1.5 outline-none transition active:scale-95"
              >
                <span class="grid h-16 w-16 place-items-center rounded-2xl border-2 border-dashed border-accent/50 bg-accent/5 text-2xl text-accent">＋</span>
                <span class="max-w-full truncate text-[10px] font-medium text-accent">{t("appLibrary.newGroup")}</span>
              </button>
          </div>

        {:else if noResults}
          <p class="px-1 pt-14 text-center text-sm opacity-60">{t("appLibrary.noResults")}</p>
        {:else}
          <!-- Live-search results: matched apps grouped under their category with
               the query substring highlighted (cross-group). -->
          <div data-testid="app-library-results" class="space-y-3">
            <p
              class="px-1 text-xs font-medium opacity-60"
              data-testid="app-library-matches"
              role="status"
              aria-live="polite"
            >{t("appLibrary.matches", { n: matchCount })}</p>
            {#each foldersShown as f (f.id)}
              <p class="px-1 text-xs font-medium opacity-70">{t(f.nameKey)}</p>
              <div class="grid grid-cols-4 gap-x-1 gap-y-3 px-1">
                {#each f.apps as id (id)}
                  <button
                    aria-label={labelOf(id)}
                    title={labelOf(id)}
                    onclick={() => openId(id)}
                    class="flex w-full flex-col items-center gap-1 outline-none transition active:scale-90"
                  >
                    <AppIcon
                      id={id}
                      icon={iconOf(id)}
                      tileClassName="h-12 w-12 rounded-[17px]"
                      glyphClassName="text-[2rem]"
                    />
                    <span class="max-w-full truncate text-[10px] font-medium text-neutral-800 dark:text-neutral-200">{@render name(id)}</span>
                  </button>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Expanded single-category grid -->
    <div class="flex h-full flex-col px-4 pb-3 pt-3">
      <div class="flex items-center justify-between">
        <button onclick={() => (openView = null)} class="w-6 text-accent text-sm font-semibold" aria-label="back">‹</button>
        <span class="flex-1 truncate text-center text-base font-semibold">{t(openView.folder.nameKey)}</span>
        <span class="w-6"></span>
      </div>
      <div class="mt-3 grid min-h-0 flex-1 auto-rows-min grid-cols-4 place-content-start gap-y-5 overflow-y-auto">
        {#each openView.folder.apps as id (id)}
          <button
            aria-label={labelOf(id)}
            title={labelOf(id)}
            onclick={() => openId(id)}
            class="group flex w-full flex-col items-center gap-1 outline-none"
          >
            <AppIcon
              id={id}
              icon={iconOf(id)}
              tileClassName="h-14 w-14 rounded-[19px] transition group-hover:-translate-y-0.5 group-active:scale-90"
              glyphClassName="text-[2.5rem]"
            />
            <span class="max-w-full truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">{@render name(id)}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Home indicator: a horizontal bar (iOS-style); tapping returns to the home. -->
  <div class="flex justify-center pb-1 pt-0.5">
    <button
      aria-label="home"
      data-testid="library-home-indicator"
      title="Home"
      onclick={backHome}
      class="grid w-32 cursor-pointer place-items-center py-1"
    >
      <span class="block h-1.5 w-14 rounded-full bg-neutral-800/80 ring-1 ring-white/10 dark:bg-neutral-200/90 dark:ring-black/10"></span>
    </button>
  </div>
</div>

<!-- Reusable app-name renderer: highlights the live-search query substring. -->
{#snippet name(id: string)}
  {#each splitMatch(labelOf(id)) as seg, i (i)}
    {#if seg.hit}
      <mark class="rounded bg-accent/25 px-0.5 text-accent dark:text-white">{seg.text}</mark>
    {:else}
      {seg.text}
    {/if}
  {/each}
{/snippet}



<style>
  /* Light entrance polish for the App Library screen + view switches (CSS-only,
     no JS timing — safe under headless tests). */
  .fx-fade {
    animation: fx-fade-up 0.22s ease-out both;
  }
  @keyframes fx-fade-up {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>

