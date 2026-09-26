<script lang="ts">
  // SpotlightPanel.svelte — Svelte 5 (runes) port of the React `SystemPanels`
  // SpotlightPanel (a CONTROLLED chrome overlay). The shell owns `open` and pushes
  // it over propsBus "spotlight"; search text is LOCAL state (persists across
  // opens like React), and choosing a result emits 'open'(id)+'close'.
  import { t } from "./locale.svelte";
  import { APP_META, appIcon } from "../lib/appMeta";
  import { NOTES_KEY, normalizeNotes, noteTitle, searchNotes, prependNote } from "../lib/notes";
  import { FILES_KEY, normalizeFiles, searchFiles, folderPath } from "../lib/files";
  import { CONTACTS_KEY, normalizeContacts, searchContacts, primaryPhone } from "../lib/contacts";
  import {
    RECENTS_KEY,
    normalizeRecents,
    readStoreValue,
    writeStoreValueChecked,
  } from "../lib/amosStore";
  import { createStoreValue } from "./store";
  import { orderByRecency } from "../lib/appGroups";
  import { openContact, openFile, openNote, dialNumber, openSettingsSearch } from "./appLinks";
  import { dialableQuery } from "../lib/phone";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { attachFocusTrap } from "../lib/focusTrap";
  import { nextListIndex } from "../lib/overviewKeys";
  import { propsChannel } from "./propsBus";
  import AppIcon from "./AppIcon.svelte";
  import { GLASS_SPOTLIGHT_STYLE } from "../lib/shellChrome";

  interface SpotlightProps {
    open: boolean;
  }
  const bus = propsChannel<SpotlightProps>("spotlight");

  let incoming = $state<SpotlightProps | null>(null);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) incoming = v;
    });
    return un;
  });
  const open = $derived(incoming?.open ?? false);

  let q = $state("");
  let inputEl: HTMLInputElement | undefined = $state();

  // Focus the search field when the sheet opens (summons the OS keyboard). A plain
  // autoFocus is not enough because the opening tap keeps focus on the trigger.
  $effect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputEl?.focus());
    return () => cancelAnimationFrame(id);
  });

  const needle = $derived(q.trim().toLowerCase());
  // A non-empty query can be **acted on** (see the actions block below).
  const canNewNote = $derived(needle.length > 0);
  // App results are ordered by this device's **actual use** — the same `amos.recents`
  // list the App Library's "Frequently Used" group reads — so an app you just opened
  // comes first. Nothing is invented: an app with no recorded use keeps its registry
  // order (see `orderByRecency`).
  //
  // 「Live」 is the load-bearing word, so the list is **subscribed**, not read once
  // (`getRecents()` is a one-shot `readJson`). A `$derived` that reads nothing reactive is
  // evaluated once and never again, and this sheet is mounted permanently in `Shell.svelte`
  // — so reading it here would order the apps by whatever `amos.recents` held the first time
  // the sheet was opened, and the sentence above would be false for the rest of the session.
  const recentsStore = createStoreValue<string[]>(RECENTS_KEY, []);
  let recents = $state<string[]>([]);
  $effect(() => {
    const un = recentsStore.subscribe((v) => {
      // Narrow here, not at the store: a cross-window `store-updated` payload and the boot
      // snapshot are both written into `localStorage` verbatim, so `v` can be any JSON value.
      // `orderByRecency` iterates it (`recents.forEach`), and `hits` is a `$derived` on this
      // permanently-mounted panel's render path — a non-array would blank the sheet.
      recents = normalizeRecents(v);
    });
    return un;
  });
  const hits = $derived(
    orderByRecency(
      needle
        ? APP_META.filter(
            (a) => t(a.titleKey).toLowerCase().includes(needle) || a.id.includes(needle),
          )
        : APP_META,
      (a) => a.id,
      recents,
    ).slice(0, 12),
  );
  // Content results: the user's own NOTES, matched with the domain's own matcher
  // (`lib/notes.searchNotes` — the same one the Notes screen uses), so Spotlight can
  // find a note and open it, not just find an app. Bounded to keep the sheet short.
  const noteHits = $derived.by(() => {
    if (!needle) return [];
    const list = normalizeNotes(readStoreValue<unknown>(NOTES_KEY, []));
    return searchNotes(list, q).slice(0, 6);
  });
  // FILES are matched by name **and content** (`includeContent`), using the Files
  // screen's own cross-directory matcher — so a phrase inside a text file is
  // findable from Spotlight. Each row also shows where the file lives.
  //
  // The list is **live**, not a one-shot `readStoreValue` hoisted into a `$derived`:
  // `readStoreValue` is not reactive, and a `$derived` that reads nothing reactive is
  // evaluated once and never again — so the first non-empty query would freeze the file
  // list for the life of the mount (this panel is mounted permanently in `Shell.svelte`),
  // and a file saved afterwards would never be findable. That is precisely the failure the
  // desktop twin already avoids (`SpotlightOverlay` subscribes through `createStoreValue`);
  // this is the same subscription, so both shells answer from the store, not from a snapshot.
  const filesStore = createStoreValue<unknown>(FILES_KEY, []);
  let filesRaw = $state<unknown>([]);
  $effect(() => {
    const un = filesStore.subscribe((raw) => {
      filesRaw = raw;
    });
    return un;
  });
  const fileList = $derived(normalizeFiles(filesRaw));
  const fileHits = $derived(needle ? searchFiles(fileList, q, true).slice(0, 6) : []);
  // CONTACTS are matched with the Contacts screen's own matcher (name / phone) — live the
  // same way, for the same reason: a contact added after the panel has been used once is
  // otherwise never findable.
  const contactsStore = createStoreValue<unknown>(CONTACTS_KEY, []);
  let contactsRaw = $state<unknown>([]);
  $effect(() => {
    const un = contactsStore.subscribe((raw) => {
      contactsRaw = raw;
    });
    return un;
  });
  const contactList = $derived(normalizeContacts(contactsRaw));
  const contactHits = $derived(needle ? searchContacts(contactList, q).slice(0, 6) : []);
  const noHits = $derived(
    !canNewNote &&
      hits.length === 0 &&
      noteHits.length === 0 &&
      fileHits.length === 0 &&
      contactHits.length === 0,
  );

  // ---- actions ----------------------------------------------------------------
  // Spotlight is not only a finder: a non-empty query can be **acted on**. The one
  // action offered today is "save this text as a note" — always available for a
  // non-empty query, and honest about the write (a rejected store keeps the sheet
  // open with the text intact instead of closing over a note that was never saved).
  // Deliberately NOT offered (yet): dialing / settings toggles — they would need a
  // phone/settings deep link that does not exist, and guessing one would be worse
  // than the boundary (see gap #23).
  let actionErr = $state("");
  // A query that **is** a number additionally offers the dialler prefill — again only
  // when it really is one (`dialableQuery` strips separators and refuses prose).
  const dialTarget = $derived(dialableQuery(q));
  const runDial = () => {
    const n = dialTarget;
    if (!n) return;
    dialNumber(n); // prefills the Phone dialler and opens it — never auto-dials
    bus.emit("close");
  };
  // Settings search prefill: offered for **any** non-empty query. Settings' own index
  // search knows every page, its synonyms and its live values, so it is a strictly
  // better matcher than anything guessed here — we hand the text over and let it decide.
  // (A search link only *navigates*; it never flips a switch for the user.)
  const runSettingsSearch = () => {
    const s = q.trim();
    if (s === "") return;
    openSettingsSearch(s);
    bus.emit("close");
  };
  const runNewNote = () => {
    const text = q.trim();
    if (!text) return;
    const list = normalizeNotes(readStoreValue<unknown>(NOTES_KEY, []));
    const next = prependNote(list, text, Date.now());
    const created = next[0];
    if (!created || !writeStoreValueChecked(NOTES_KEY, next)) {
      actionErr = t("common.storeWriteFailed");
      return; // nothing was stored ⇒ nothing is claimed, the query stays put
    }
    actionErr = "";
    openNote(created.id); // Notes' own deep-link channel, then opens the app
    bus.emit("close");
  };

  const close = () => bus.emit("close");
  const choose = (id: string) => {
    bus.emit("open", id);
    bus.emit("close");
  };
  const chooseNote = (id: string) => {
    openNote(id); // sets the Notes link channel, then opens the app
    bus.emit("close");
  };
  const chooseFile = (id: string) => {
    openFile(id); // Files navigates to the entry's folder and marks it
    bus.emit("close");
  };
  const chooseContact = (id: string) => {
    openContact(id); // Contacts clears its filter and marks the row
    bus.emit("close");
  };

  // ---- the keyboard's place in the list ----------------------------------------
  /**
   * Every row the panel draws, in the order it draws them — one flat list, because that is
   * what the keyboard walks. Each row carries its own `run`, so Return needs no second
   * `switch` that could drift from the one the pointer uses (this repo has a name for that
   * shape: two entry points that can give different answers).
   */
  interface PanelRow {
    key: string;
    /** A suggestion (save as note / dial / Settings search) — **not** a hit. */
    kind: "action" | "result";
    run: () => void;
  }
  const panelRows = $derived.by<PanelRow[]>(() => {
    const out: PanelRow[] = [];
    if (canNewNote) {
      out.push({ key: "new-note", kind: "action", run: runNewNote });
      if (dialTarget) out.push({ key: "dial", kind: "action", run: runDial });
      out.push({ key: "settings", kind: "action", run: runSettingsSearch });
    }
    for (const a of hits) out.push({ key: `app-${a.id}`, kind: "result", run: () => choose(a.id) });
    for (const n of noteHits) out.push({ key: `note-${n.id}`, kind: "result", run: () => chooseNote(n.id) });
    for (const f of fileHits) out.push({ key: `file-${f.id}`, kind: "result", run: () => chooseFile(f.id) });
    for (const c of contactHits) out.push({ key: `contact-${c.id}`, kind: "result", run: () => chooseContact(c.id) });
    return out;
  });

  /** Where Return goes with no arrow pressed: the **top hit**, not the first suggestion.
   *
   *  macOS Spotlight opens the best match with Return and draws its suggestions further down;
   *  this panel draws the suggestions *above* the hits, so "index 0" would make Return save a
   *  note named after whatever the user typed. The suggestions stay reachable — one ↑ from the
   *  top hit lands on the last of them. */
  const defaultRow = $derived.by(() => {
    const i = panelRows.findIndex((r) => r.kind === "result");
    return i >= 0 ? i : 0;
  });

  /** The row the keyboard is on (clamped: the list shrinks as the query narrows). */
  let selected = $state(0);
  const active = $derived(
    Math.min(Math.max(selected, 0), Math.max(0, panelRows.length - 1)),
  );
  // A new query is a new list with a new top hit — the selection starts there again.
  $effect(() => {
    void q;
    selected = defaultRow;
  });

  /** The flat index of a drawn row. The highlight and Return read the *same* fact. */
  const rowIndex = (key: string) => panelRows.findIndex((r) => r.key === key);
  /** Is this row the one the keyboard is on? */
  const isActive = (key: string) => rowIndex(key) === active;

  /**
   * One row of the panel — the same shape for a suggestion and for every kind of hit, with the
   * keyboard's place drawn on it. `bg-accent/10` is the repo's AA-safe tint (REQ-A387); the
   * class lives here so the five row blocks cannot drift into five different highlights.
   */
  const SPOT_ROW = "flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition";
  /** The row's class, including whether the keyboard is on it. */
  const rowClass = (key: string) =>
    `${SPOT_ROW} ${isActive(key) ? "bg-accent/10" : "active:bg-accent/10"}`;

  // Keyboard focus trap while open (shared lib/focusTrap). Tab wraps
  // inside the sheet; Escape closes. The search field keeps its own rAF focus.
  let rootEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open || !rootEl) return;
    return attachFocusTrap(rootEl, close);
  });

  /**
   * ↑ / ↓ walk the rows and Return runs the one the panel highlights.
   *
   * The listener sits on the sheet (not the field) so the same keys work wherever the focus
   * is, and the **field keeps the caret**: Spotlight is "type, glance, Return", so moving the
   * selection must not take the text cursor away mid-word. `nextListIndex` owns only ↑/↓ —
   * Home/End are the caret's here — and is shared with the desktop overlay, which draws the
   * same list (REQ-A1040).
   *
   * Return also arrives as ⌘/Ctrl+Return, which is the glyph the app rows draw.
   */
  $effect(() => {
    // Bound to a local: `rootEl` is `$state` and may be re-assigned, so the guard above does
    // not narrow it inside the returned cleanup.
    const el = rootEl;
    if (!open || !el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const next = nextListIndex(e.key, active, panelRows.length);
        if (next === null) return;
        e.preventDefault();
        selected = next;
        return;
      }
      if (e.key !== "Enter") return;
      const row = panelRows[active];
      if (!row) return;
      e.preventDefault();
      row.run();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  });
</script>

{#if open}
  <div
    bind:this={rootEl}
    class="sheet-in absolute inset-0 z-40 flex flex-col p-4"
    style={GLASS_SPOTLIGHT_STYLE}
  >
    <div class="flex items-center justify-between px-1">
      <h2 class="text-xl font-semibold tracking-tight">{t("shell.search")}</h2>
      <button
        onclick={close}
        class="rounded-full bg-neutral-200/80 px-4 py-1.5 text-sm font-medium text-accent transition active:scale-95 dark:bg-white/10"
      >{t("common.done")}</button>
    </div>
    <input
      bind:this={inputEl}
      bind:value={q}
      placeholder={t("shell.searchPh")}
      class="mt-3 w-full rounded-full bg-white/70 px-4 py-2.5 text-sm text-neutral-900 shadow-sm ring-1 ring-black/5 outline-none placeholder:text-black/30 dark:bg-white/10 dark:text-white dark:ring-white/10 dark:placeholder:text-white/30"
    />
    <div class="mt-3 min-h-0 flex-1 overflow-auto">
      <StoreErrorBar message={actionErr} />
      {#if noHits}
        <p class="py-16 text-center text-sm opacity-50">{t("shell.noMatch")}</p>
      {:else}
        {#if canNewNote}
          <div class="mb-3">
            <h3 class="px-1 pb-1 text-xs font-semibold uppercase tracking-widest opacity-50">{t("shell.spotActions")}</h3>
            <div class="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
              <button
                onclick={runNewNote}
                data-testid="spotlight-new-note"
                data-selected={isActive("new-note") ? "true" : "false"}
                class={rowClass("new-note")}
              >
                <span class="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-accent/15 text-[22px]" aria-hidden="true">📝</span>
                <span class="min-w-0 flex-1 truncate font-medium">{t("shell.spotNewNote", { q: q.trim() })}</span>
              </button>
              {#if dialTarget}
                <button
                  onclick={runDial}
                  data-testid="spotlight-dial"
                  data-selected={isActive("dial") ? "true" : "false"}
                  class={rowClass("dial")}
                >
                  <span class="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-accent/15 text-[22px]" aria-hidden="true">📞</span>
                  <span class="min-w-0 flex-1 truncate font-medium">{t("shell.spotDial", { q: dialTarget })}</span>
                </button>
              {/if}
              <button
                onclick={runSettingsSearch}
                data-testid="spotlight-settings"
                data-selected={isActive("settings") ? "true" : "false"}
                class={rowClass("settings")}
              >
                <span class="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-accent/15 text-[22px]" aria-hidden="true">⚙️</span>
                <span class="min-w-0 flex-1 truncate font-medium">{t("shell.spotSettingsSearch", { q: q.trim() })}</span>
              </button>
            </div>
          </div>
        {/if}
        {#if hits.length > 0}
          <div class="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
            {#each hits as a (a.id)}
              <button
                onclick={() => choose(a.id)}
                data-testid={`spot-app-${a.id}`}
                data-selected={isActive(`app-${a.id}`) ? "true" : "false"}
                aria-label={t(a.titleKey)}
                class={rowClass(`app-${a.id}`)}
              >
                <AppIcon id={a.id} icon={appIcon(a.id)} tileClassName="h-11 w-11 rounded-[12px]" glyphClassName="text-[26px]" />
                <span class="min-w-0 flex-1 truncate font-medium">{t(a.titleKey)}</span>
                <!-- Return is the key that opens the row the panel highlights. It used to draw
                     "⌘↵" while **nothing** in this panel answered Return at all (REQ-A1040) — a
                     keycap naming a binding that did not exist, which is the one thing this
                     repo's menus are forbidden to do. ⌘/Ctrl+Return still works. -->
                <span class="text-xs text-accent">↵</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if noteHits.length > 0}
          <div class="mt-3">
            <h3 class="px-1 pb-1 text-xs font-semibold uppercase tracking-widest opacity-50">{t("shell.spotNotes")}</h3>
            <div class="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
              {#each noteHits as n (n.id)}
                <button
                  onclick={() => chooseNote(n.id)}
                  data-testid={`spot-note-${n.id}`}
                  data-selected={isActive(`note-${n.id}`) ? "true" : "false"}
                  aria-label={noteTitle(n.text) || t("note.untitled")}
                  class={rowClass(`note-${n.id}`)}
                >
                  <span aria-hidden="true" class="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-black/5 text-[22px] dark:bg-white/10">📝</span>
                  <span class="min-w-0 flex-1 truncate font-medium">{noteTitle(n.text) || t("note.untitled")}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
        {#if fileHits.length > 0}
          <div class="mt-3">
            <h3 class="px-1 pb-1 text-xs font-semibold uppercase tracking-widest opacity-50">{t("shell.spotFiles")}</h3>
            <div class="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
              {#each fileHits as f (f.id)}
                <button
                  onclick={() => chooseFile(f.id)}
                  data-testid={`spot-file-${f.id}`}
                  data-selected={isActive(`file-${f.id}`) ? "true" : "false"}
                  aria-label={f.name}
                  class={rowClass(`file-${f.id}`)}
                >
                  <span aria-hidden="true" class="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-black/5 text-[22px] dark:bg-white/10">{f.type === "folder" ? "📁" : "📄"}</span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-medium">{f.name}</span>
                    <span class="block truncate text-xs opacity-50">{folderPath(fileList, f.id) || t("files.root")}</span>
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
        {#if contactHits.length > 0}
          <div class="mt-3">
            <h3 class="px-1 pb-1 text-xs font-semibold uppercase tracking-widest opacity-50">{t("shell.spotContacts")}</h3>
            <div class="divide-y divide-black/5 overflow-hidden rounded-2xl bg-white/55 shadow-sm ring-1 ring-black/5 dark:divide-white/5 dark:bg-white/5 dark:ring-white/10">
              {#each contactHits as c (c.id)}
                <button
                  onclick={() => chooseContact(c.id)}
                  data-testid={`spot-contact-${c.id}`}
                  data-selected={isActive(`contact-${c.id}`) ? "true" : "false"}
                  aria-label={c.name}
                  class={rowClass(`contact-${c.id}`)}
                >
                  <span aria-hidden="true" class="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-black/5 text-[22px] dark:bg-white/10">👤</span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-medium">{c.name}</span>
                    <span class="block truncate text-xs opacity-50">{primaryPhone(c) ?? ""}</span>
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
