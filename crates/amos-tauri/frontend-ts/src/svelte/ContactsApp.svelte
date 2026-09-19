<script lang="ts">
  // ContactsApp.svelte — Svelte 5 (runes) implementation of the contacts app.
  // All data logic reuses the pure helpers in
  // lib/contacts.ts; persistence goes through the shared amos.* store; the quick
  // "Frequent / Recent" call chips are derived from the shared call log via
  // createStoreValue (lib/calllog.ts) — never reimplemented.
  import {
    CONTACTS_KEY,
    addContact,
    avatarEmoji,
    avatarHue,
    contactById,
    contactNameFor,
    contactsWithPhone,
    contactsWithPhoneExcept,
    editContact,
    getAvatarTheme,
    getAvatarThemes,
    getContactAvatarSrc,
    groupContacts,
    hasCustomAvatar,
    normalizeContacts,
    primaryPhone,
    processAvatarUpload,
    removeContact,
    searchContacts,
    setAvatarTheme,
    setContactAvatar,
    setContactFav,
    sortContacts,
  } from "../lib/contacts";
  import type { AvatarTheme, Contact } from "../lib/contacts";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { iconSvg } from "../lib/sysIcons";
  import { bridged, telephonyDial } from "../lib/backend";
  import {
    CALLLOG_KEY,
    frequentNumbers,
    normalizeCallLog,
    recentNumbers,
    recordCall,
  } from "../lib/calllog";
  import type { CallRecord } from "../lib/calllog";
  import { NOTIF_KEY, addNotif, newNotifId } from "../lib/settings";
  import type { Notif } from "../lib/settings";
  import { zh } from "../i18n/locales/zh";
  import { t } from "./locale.svelte";
  import { createStoreValue } from "./store";
  import { contactsChannel } from "./appLinks";
  import { buildVcf, countVCards, MAX_IMPORT_BYTES, mergeImported, parseVcf } from "../lib/contactTransfer";
  import type { ParseVcfResult } from "../lib/contactTransfer";
  import { copySelection } from "../lib/clipboard";
  import { calculateVirtualRange } from "../lib/virtualScroll";

  // Contacts list: seeded from the shared store; every mutation persists.
  // NOTE: $state does NOT lazily invoke a function initializer — compute first.
  const initialContacts = normalizeContacts(readStoreValue<unknown>(CONTACTS_KEY, []));
  let contacts = $state<Contact[]>(initialContacts);
  // The store refused a write (full/unavailable): say so and keep showing the truth.
  let storeErr = $state("");
  const persist = (next: Contact[]): boolean => {
    // Verified: a rejected write must not be applied (the row would vanish on reload).
    if (!writeStoreValueChecked(CONTACTS_KEY, next)) {
      storeErr = t("common.storeWriteFailed");
      return false;
    }
    storeErr = "";
    contacts = next;
    return true;
  };

  // ---- composer / search / row-local UI state ----
  let q = $state("");
  let adding = $state(false);
  let editing = $state<Contact | null>(null);
  let name = $state("");
  let phones = $state("");
  let note = $state("");
  let status = $state("");
  let confirmId = $state<string | null>(null);

  // ---- avatar theme & animation state ----
  let avatarTheme = $state<AvatarTheme>(getAvatarTheme());
  let avatarThemeMenuOpen = $state(false);
  let animatingAvatarId = $state<string | null>(null);
  let flippingAvatarId = $state<string | null>(null);
  let spinningAvatarId = $state<string | null>(null);
  let longPressTimer = $state<number | null>(null);
  let longPressTarget = $state<string | null>(null);
  let lastClickTime = $state<number>(0);
  let lastClickTarget = $state<string | null>(null);

  // ---- custom avatar upload state ----
  let uploadingAvatarFor = $state<string | null>(null);
  let avatarFileInput = $state<HTMLInputElement | null>(null);
  let uploadProgress = $state<string>("");
  let previewingAvatarFor = $state<string | null>(null);

  // ---- vCard import/export (domain logic lives in lib/contactTransfer.ts) ----
  let importOpen = $state(false);
  let importText = $state("");
  let pendingImport = $state<ParseVcfResult | null>(null);

  /** Download `vcf` as contacts.vcf via a temporary object URL. */
  function downloadVcf(vcf: string): boolean {
    try {
      if (typeof URL.createObjectURL !== "function") return false;
      const url = URL.createObjectURL(new Blob([vcf], { type: "text/vcard" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "contacts.vcf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
  }

  /** Export the whole book as a .vcf download (honest about empty / failure). */
  function exportVcf(): void {
    const vcf = buildVcf(contacts);
    if (vcf === "") {
      status = t("contacts.exportEmpty");
      return;
    }
    if (!downloadVcf(vcf)) {
      status = t("contacts.exportFailed");
      return;
    }
    // Count with the lib (never by substring: a note may contain "BEGIN:VCARD").
    status = t("contacts.exported", { n: countVCards(contacts) });
  }

  /** Copy the whole book as vCard text through the OS clipboard bridge. */
  async function copyVcf(): Promise<void> {
    const vcf = buildVcf(contacts);
    if (vcf === "") {
      status = t("contacts.exportEmpty");
      return;
    }
    try {
      if (!(await copySelection(vcf))) {
        status = t("contacts.clipOffline"); // outside the shell the bridge is null
        return;
      }
    } catch {
      status = t("contacts.clipOffline");
      return;
    }
    status = t("contacts.copied");
  }

  function openImport(): void {
    importText = "";
    pendingImport = null;
    importOpen = true;
    status = "";
  }

  function closeImport(): void {
    importOpen = false;
    pendingImport = null;
    importText = "";
  }

  /** Read a picked .vcf file into the paste box (the same parse path either way). */
  async function pickImportFile(e: Event): Promise<void> {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    // Bounded read: refuse an oversized file BEFORE reading it, instead of
    // ballooning memory on a mis-picked archive-sized .vcf.
    if (typeof file.size === "number" && file.size > MAX_IMPORT_BYTES) {
      pendingImport = null;
      status = t("contacts.importTooBig");
      return;
    }
    try {
      importText = await file.text();
      // The box now holds DIFFERENT text than any earlier preview — and this
      // programmatic assignment fires NO `input` event, so the stale parse must
      // be voided here (same defect class as the textarea's oninput guard).
      pendingImport = null;
      status = "";
    } catch {
      status = t("contacts.importReadFail"); // a read failure is not "not a vCard"
    }
  }

  /** Parse the pasted/loaded text; zero vCard blocks is "not a vCard" — say so. */
  function previewImport(): void {
    const res = parseVcf(importText);
    if (res.blocks === 0) {
      pendingImport = null;
      status = t("contacts.importBad");
      return;
    }
    pendingImport = res;
    status = "";
  }

  /** Merge the previewed entries in; counts are reported, never silent. */
  function confirmImport(): void {
    const pending = pendingImport;
    if (!pending) return;
    const out = mergeImported(contacts, pending.entries, Date.now());
    // A rejected write keeps the dialog open (banner shows why); nothing was applied.
    if (out.added > 0 && !persist(out.list)) return;
    // "Unusable" = blocks the parser already rejected + anything the merge's
    // defensive re-validation still catches (normally 0, but report it anyway).
    status = t("contacts.importDone", {
      added: out.added,
      dup: out.dupSkipped,
      invalid: out.invalidSkipped + pending.invalid,
    });
    closeImport();
  }

  // ---- quick-dial chips come from the shared call log (reactive store) ----
  const callLogStore = createStoreValue<unknown>(CALLLOG_KEY, []);
  let callLog = $state<CallRecord[]>([]);
  $effect(() => {
    const unsub = callLogStore.subscribe((v) => {
      callLog = normalizeCallLog(v);
    });
    return unsub;
  });
  const recents = $derived(
    recentNumbers(callLog, 4).map((n) => ({ num: n, label: contactNameFor(contacts, n) ?? n })),
  );
  const frequent = $derived(
    frequentNumbers(callLog, 3).map((n) => ({ num: n, label: contactNameFor(contacts, n) ?? n })),
  );

  const shown = $derived(searchContacts(sortContacts(contacts), q));
  const groups = $derived(groupContacts(shown));

  // ---- Virtual scrolling for performance with large contact lists ----------------
  let scrollTop = $state(0);
  let containerHeight = $state(600);
  const ITEM_HEIGHT = 64; // Contact row height in px

  // Flatten groups into a single array with metadata for virtual scrolling
  interface FlatItem {
    type: "header" | "contact";
    letter?: string;
    contact?: Contact;
    groupIndex: number;
    itemIndex: number;
  }

  const flatItems = $derived((): FlatItem[] => {
    const result: FlatItem[] = [];
    groups.forEach((grp, groupIndex) => {
      result.push({ type: "header", letter: grp.letter, groupIndex, itemIndex: result.length });
      grp.items.forEach((contact) => {
        result.push({ type: "contact", contact, groupIndex, itemIndex: result.length });
      });
    });
    return result;
  });

  const totalHeight = $derived(flatItems().length * ITEM_HEIGHT);

  const visibleRange = $derived(
    calculateVirtualRange(scrollTop, containerHeight, flatItems().length, ITEM_HEIGHT, 5)
  );

  const visibleItems = $derived(
    visibleRange.items.map((vItem) => {
      const item = flatItems()[vItem.index];
      return item ? { ...item, vStart: vItem.start } : null;
    }).filter((item): item is FlatItem & { vStart: number } => item !== null)
  );

  // ---- Deep link: Spotlight → one contact -----------------------------------------
  // Spotlight sets the `contacts` channel and opens this app. This screen has no
  // single-contact page, so the honest reveal is: clear the filter that would hide the
  // contact and **mark** its row. The link is consumed (channel cleared) so re-opening
  // Contacts never re-fires it, and an id that no longer exists is ignored.
  let spotId = $state<string | null>(null);
  let linkNonce = 0;
  $effect(() => {
    return contactsChannel().subscribe((v) => {
      if (!v || v.id.trim() === "" || v.nonce === linkNonce) return;
      linkNonce = v.nonce;
      const target = contactById(contacts, v.id);
      if (target) {
        q = ""; // a filtered list would hide the very contact we were asked to show
        spotId = target.id;
      }
      contactsChannel().set({ id: "", nonce: linkNonce });
    });
  });

  function submit(): void {
    const ph = phones
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const input = { name, phones: ph, note: note || undefined };
    if (ph.length > 0) {
      const dup = editing
        ? contactsWithPhoneExcept(contacts, ph[0]!, editing.id)
        : contactsWithPhone(contacts, ph[0]!);
      if (dup.length > 0) {
        status = t("contacts.dup");
        return;
      }
    }
    const next = editing ? editContact(contacts, editing.id, input) : addContact(contacts, input);
    if (next === contacts) {
      status = t("contacts.required");
      return;
    }
    // The typed name/number stays in the form when the store rejected the save.
    if (!persist(next)) return;
    editing = null;
    adding = false;
    name = "";
    phones = "";
    note = "";
    status = "";
  }

  /** Start editing an existing contact: prefill the composer fields. */
  function openEdit(c: Contact): void {
    editing = c;
    adding = false;
    name = c.name;
    phones = c.phones.join("\n");
    note = c.note ?? "";
    status = "";
  }

  /** Close the composer (add or edit) without saving. */
  function closeComposer(): void {
    editing = null;
    adding = false;
    status = "";
  }

  /** Toggle avatar theme menu. */
  function toggleAvatarThemeMenu(): void {
    avatarThemeMenuOpen = !avatarThemeMenuOpen;
  }

  /** Change avatar theme and refresh UI. */
  function changeAvatarTheme(theme: AvatarTheme): void {
    setAvatarTheme(theme);
    avatarTheme = theme;
    avatarThemeMenuOpen = false;
    status = t("contacts.themeChanged", { theme: t(`contacts.theme.${theme}`) });
    
    // Trigger flip animation on all visible avatars
    // Collect all contact IDs from rendered groups
    const visibleIds = groups.flatMap((grp) => grp.items.map((c) => c.id));
    visibleIds.forEach((id, index) => {
      setTimeout(() => {
        flippingAvatarId = id;
        setTimeout(() => {
          if (flippingAvatarId === id) {
            flippingAvatarId = null;
          }
        }, 600);
      }, index * 30); // Stagger animations by 30ms
    });
  }

  /** Animate avatar on click (scale + rotate). */
  function animateAvatar(contactId: string): void {
    animatingAvatarId = contactId;
    setTimeout(() => {
      if (animatingAvatarId === contactId) {
        animatingAvatarId = null;
      }
    }, 600); // Animation duration
  }

  /** Handle avatar click - detect double click for spin animation. */
  function handleAvatarClick(contactId: string): void {
    const now = Date.now();
    const isDoubleClick = lastClickTarget === contactId && now - lastClickTime < 500;
    
    if (isDoubleClick) {
      // Double click: trigger spin animation, cancel any pending long press
      cancelLongPress();
      spinningAvatarId = contactId;
      setTimeout(() => {
        if (spinningAvatarId === contactId) {
          spinningAvatarId = null;
        }
      }, 1200); // Spin animation duration
      lastClickTime = 0;
      lastClickTarget = null;
    } else {
      // Single click: trigger bounce animation only (no preview, long press handles that)
      animateAvatar(contactId);
      lastClickTime = now;
      lastClickTarget = contactId;
    }
  }

  /** Start long press timer for avatar. */
  function startLongPress(contactId: string): void {
    longPressTarget = contactId;
    longPressTimer = window.setTimeout(() => {
      if (longPressTarget === contactId) {
        // Long press detected: open full screen preview
        previewAvatar(contactId);
        longPressTimer = null;
        longPressTarget = null;
      }
    }, 500); // 500ms for long press
  }

  /** Cancel long press timer. */
  function cancelLongPress(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressTarget = null;
  }

  /** Open file picker for avatar upload. */
  function openAvatarUpload(contactId: string): void {
    uploadingAvatarFor = contactId;
    uploadProgress = "";
    // Trigger file input click
    if (avatarFileInput) {
      avatarFileInput.value = ""; // Reset input to allow re-uploading same file
      avatarFileInput.click();
    }
  }

  /** Handle avatar file selection and upload. */
  async function handleAvatarUpload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    
    if (!file || !uploadingAvatarFor) return;
    
    try {
      uploadProgress = t("contacts.uploadProcessing");
      
      // Process image (compress and create thumbnail)
      const avatar = await processAvatarUpload(file);
      
      // Update contact with new avatar
      const next = setContactAvatar(contacts, uploadingAvatarFor, avatar);
      if (!persist(next)) {
        uploadProgress = t("common.storeWriteFailed");
        return;
      }
      
      uploadProgress = "";
      status = t("contacts.avatarUploaded");
      uploadingAvatarFor = null;
    } catch (err) {
      uploadProgress = "";
      status = err instanceof Error ? err.message : t("contacts.uploadFailed");
      uploadingAvatarFor = null;
    }
  }

  /** Remove custom avatar from contact. */
  function removeCustomAvatar(contactId: string): void {
    const next = setContactAvatar(contacts, contactId, null);
    if (!persist(next)) {
      status = t("common.storeWriteFailed");
      return;
    }
    status = t("contacts.avatarRemoved");
  }

  /** Preview avatar in full screen. */
  function previewAvatar(contactId: string): void {
    previewingAvatarFor = contactId;
  }

  /** Close avatar preview. */
  function closeAvatarPreview(): void {
    previewingAvatarFor = null;
  }

  /** Place an outgoing call through the backend bridge; record it + notify. */
  async function callNumber(num: string, nameHint?: string): Promise<void> {
    if (!num) return;
    if (!bridged()) {
      status = t("contacts.offline");
      return;
    }
    try {
      await telephonyDial(num);
      recordOutgoing(num, nameHint, t("contacts.dialed"));
      status = t("contacts.dialing");
    } catch {
      status = t("contacts.offline");
    }
  }
  const call = (c: Contact) => void callNumber(primaryPhone(c) ?? "", c.name);

  function recordOutgoing(num: string, name?: string, body?: string): void {
    const next = recordCall(callLog, num, name);
    // The entry may not reach the log — reuse the page's own error line rather than
    // losing the call silently.
    if (!callLogStore.save(next)) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    const label = name && name.trim() !== "" ? name.trim() : num;
    const entry: Notif = {
      id: newNotifId(),
      app: zh["app.phone"],
      title: label,
      body,
      icon: "📞",
      time: Date.now(),
    };
    writeStoreValue(NOTIF_KEY, addNotif(readStoreValue<Notif[]>(NOTIF_KEY, []), entry));
  }
</script>

<div class="p-3">
  <StoreErrorBar message={storeErr} />
  <div class="flex items-center gap-2">
    <input
      bind:value={q}
      placeholder={t("contacts.search")}
      aria-label={t("contacts.search")}
      class="min-w-0 flex-1 rounded-ios-input bg-neutral-100 px-4 py-2 text-ios-body outline-none placeholder:text-neutral-400 dark:bg-white/10 dark:placeholder:text-neutral-500"
    />
    <button
      onclick={() => {
        editing = null;
        adding = !adding;
      }}
      aria-label={t("contacts.add")}
      class="rounded-full bg-accent px-4 py-2 text-ios-body font-medium text-white shadow-sm active:scale-95"
    >
      {t("contacts.add")}
    </button>
  </div>

  <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
    <button onclick={exportVcf} aria-label={t("contacts.export")} title={t("contacts.export")}
      class="rounded-full bg-neutral-200/80 px-3 py-1 text-xs text-neutral-700 active:scale-95 dark:bg-white/10 dark:text-neutral-200">
      ⬇️ {t("contacts.export")}
    </button>
    <button onclick={() => void copyVcf()} aria-label={t("contacts.copyVcf")} title={t("contacts.copyVcf")}
      class="rounded-full bg-neutral-200/80 px-3 py-1 text-xs text-neutral-700 active:scale-95 dark:bg-white/10 dark:text-neutral-200">
      📋 {t("contacts.copyVcf")}
    </button>
    <button onclick={openImport} aria-label={t("contacts.import")} title={t("contacts.import")}
      class="rounded-full bg-neutral-200/80 px-3 py-1 text-xs text-neutral-700 active:scale-95 dark:bg-white/10 dark:text-neutral-200">
      📄 {t("contacts.import")}
    </button>
    <!-- Avatar Theme Selector -->
    <div class="relative">
      <button onclick={toggleAvatarThemeMenu} aria-label={t("contacts.avatarTheme")} title={t("contacts.avatarTheme")}
        class="rounded-full bg-neutral-200/80 px-3 py-1 text-xs text-neutral-700 active:scale-95 dark:bg-white/10 dark:text-neutral-200">
        🎨 {t(`contacts.theme.${avatarTheme}`)}
      </button>
      {#if avatarThemeMenuOpen}
        <div class="absolute left-0 top-full z-50 mt-1 min-w-[120px] rounded-xl bg-white shadow-lg ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10">
          {#each getAvatarThemes() as theme (theme)}
            <button
              onclick={() => changeAvatarTheme(theme)}
              class="block w-full px-4 py-2 text-left text-sm hover:bg-neutral-100 first:rounded-t-xl last:rounded-b-xl dark:hover:bg-neutral-700 {theme === avatarTheme ? 'bg-accent/10 font-semibold text-accent' : ''}"
            >
              {t(`contacts.theme.${theme}`)}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  {#if status}
    <!-- 这条状态是**用户动作之后**才出现的（改头像主题、导入了多少联系人…），
         而焦点还在原来的控件上 ⇒ 播报它；否则屏幕阅读器用户点了之后什么都听不到
         （REQ-A387）。 -->
    <p class="mt-1 text-xs text-accent" role="status">{status}</p>
  {/if}

  {#if importOpen}
    <div class="mt-2 space-y-2 rounded-2xl bg-white/70 p-3 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/10">
      <p class="text-sm font-medium">{t("contacts.importTitle")}</p>
      <textarea bind:value={importText} rows="5" placeholder={t("contacts.importPaste")}
        oninput={() => (pendingImport = null)} aria-label={t("contacts.importPaste")}
        class="w-full rounded-xl bg-black/5 px-3 py-1.5 font-mono text-xs outline-none dark:bg-white/10"></textarea>
      <input type="file" accept=".vcf,text/vcard" onchange={(e) => void pickImportFile(e)}
        aria-label={t("contacts.importPick")}
        class="block w-full text-xs text-neutral-500 dark:text-neutral-400" />
      {#if pendingImport}
        <p class="text-xs opacity-80">
          {t("contacts.importPreview", { n: pendingImport.entries.length })}
          {#if pendingImport.invalid > 0}
            · {t("contacts.importInvalid", { n: pendingImport.invalid })}
          {/if}
        </p>
      {/if}
      <div class="flex gap-2">
        <button onclick={previewImport} aria-label={t("contacts.importParse")}
          class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">{t("contacts.importParse")}</button>
        <button onclick={confirmImport} disabled={pendingImport === null || pendingImport.entries.length === 0}
          aria-label={t("contacts.importConfirm")}
          class="rounded-full bg-green-600 px-4 py-1.5 text-sm text-white active:scale-95 disabled:opacity-40">{t("contacts.importConfirm")}</button>
        <button onclick={closeImport} aria-label={t("contacts.cancel")}
          class="rounded-full bg-neutral-300 px-4 py-1.5 text-sm dark:bg-neutral-700">{t("contacts.cancel")}</button>
      </div>
    </div>
  {/if}

  {#if frequent.length}
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      <span class="text-xs font-semibold uppercase tracking-widest opacity-50">{t("contacts.frequent")}</span>
      {#each frequent as f (f.num)}
        <button
          onclick={() => void callNumber(f.num, f.label)}
          title={f.num}
          class="rounded-full bg-neutral-200/80 px-3 py-1 text-xs text-neutral-700 active:scale-95 dark:bg-white/10 dark:text-neutral-200"
        >
          📞 {f.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if recents.length}
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      <span class="text-xs font-semibold uppercase tracking-widest opacity-50">{t("contacts.recent")}</span>
      {#each recents as r (r.num)}
        <button
          onclick={() => void callNumber(r.num, r.label)}
          title={r.num}
          class="rounded-full bg-neutral-200/80 px-3 py-1 text-xs text-neutral-700 active:scale-95 dark:bg-white/10 dark:text-neutral-200"
        >
          📞 {r.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if adding || editing}
    <div class="mt-2 space-y-2 rounded-2xl bg-white/70 p-3 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/10">
      <input bind:value={name} placeholder={t("contacts.name")} aria-label={t("contacts.name")}
        class="w-full rounded-xl bg-black/5 px-3 py-1.5 text-sm outline-none dark:bg-white/10" />
      <input bind:value={phones} placeholder={t("contacts.phone")} aria-label={t("contacts.phone")}
        class="w-full rounded-xl bg-black/5 px-3 py-1.5 text-sm outline-none dark:bg-white/10" />
      <input bind:value={note} placeholder={t("contacts.note")} aria-label={t("contacts.note")}
        class="w-full rounded-xl bg-black/5 px-3 py-1.5 text-sm outline-none dark:bg-white/10" />
      <div class="flex gap-2">
        <button onclick={submit} aria-label={t("contacts.save")}
          class="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95">{t("contacts.save")}</button>
        <button onclick={closeComposer} aria-label={t("contacts.cancel")}
          class="rounded-full bg-neutral-300 px-4 py-1.5 text-sm dark:bg-neutral-700">{t("contacts.cancel")}</button>
      </div>
    </div>
  {/if}

  <div class="mt-3 flex gap-3">
    <div 
      class="flex-1 space-y-1.5 overflow-y-auto"
      onscroll={(e) => {
        const target = e.currentTarget;
        scrollTop = target.scrollTop;
        if (containerHeight !== target.clientHeight) {
          containerHeight = target.clientHeight;
        }
      }}
      style="max-height: calc(100vh - 200px);"
    >
      {#if groups.length === 0}
        <p class="py-10 text-center text-sm opacity-60">{t("contacts.empty")}</p>
      {:else}
        <!-- Virtual scrolling container -->
        <div style="height: {totalHeight}px; position: relative;">
          {#each visibleItems as item (item.itemIndex)}
            <div style="position: absolute; top: {item.vStart}px; left: 0; right: 0;">
              {#if item.type === "header" && item.letter}
                <div id={`section-${item.letter}`} class="sticky top-0 z-10 bg-neutral-100/90 px-1 py-0.5 text-xs font-bold uppercase tracking-widest text-neutral-400 backdrop-blur-sm dark:bg-black/60">
                  {item.letter}
                </div>
              {:else if item.type === "contact" && item.contact}
                {@const c = item.contact}
              <div class="flex items-center gap-3 rounded-ios-card px-3 py-3 ring-1 transition {spotId === c.id ? 'bg-accent/15 ring-accent dark:bg-accent/20' : 'bg-white/80 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10'}" data-spotlight={spotId === c.id ? "hit" : undefined}>
                <!-- Avatar with custom upload support or fallback to emoji -->
                <div class="group/avatar relative shrink-0">
                  <button
                    onclick={() => handleAvatarClick(c.id)}
                    oncontextmenu={(e) => { e.preventDefault(); openAvatarUpload(c.id); }}
                    ontouchstart={() => startLongPress(c.id)}
                    ontouchend={cancelLongPress}
                    ontouchmove={cancelLongPress}
                    onmousedown={() => startLongPress(c.id)}
                    onmouseup={cancelLongPress}
                    onmouseleave={cancelLongPress}
                    aria-label={t("contacts.viewAvatar")}
                    class="grid h-11 w-11 place-items-center overflow-hidden rounded-full shadow-md transition-all duration-300 hover:scale-105 {animatingAvatarId === c.id ? 'animate-avatar-bounce' : ''} {flippingAvatarId === c.id ? 'animate-avatar-flip' : ''} {spinningAvatarId === c.id ? 'animate-avatar-spin' : ''} {hasCustomAvatar(c) ? 'bg-neutral-100 dark:bg-neutral-800' : 'bg-gradient-to-br text-2xl'}"
                    style:background-image={hasCustomAvatar(c) ? 'none' : `linear-gradient(135deg, hsl(${avatarHue(c.name)} 60% 60%), hsl(${avatarHue(c.name)} 50% 45%))`}
                    style:transform-style="preserve-3d"
                  >
                    {#if hasCustomAvatar(c)}
                      <img src={getContactAvatarSrc(c, true)} alt={c.name} class="h-full w-full object-cover" />
                    {:else}
                      {avatarEmoji(c.name, avatarTheme)}
                    {/if}
                  </button>
                  <!-- Avatar upload/remove controls (on hover) -->
                  <div class="absolute -bottom-1 -right-1 flex gap-0.5 opacity-0 transition-opacity group-hover/avatar:opacity-100">
                    <button
                      onclick={(e) => { e.stopPropagation(); openAvatarUpload(c.id); }}
                      aria-label={t("contacts.uploadAvatar")}
                      title={t("contacts.uploadAvatar")}
                      class="grid h-5 w-5 place-items-center rounded-full bg-accent text-white shadow-md transition active:scale-90"
                    >
                      {@html iconSvg("plus", "h-3 w-3")}
                    </button>
                    {#if hasCustomAvatar(c)}
                      <button
                        onclick={(e) => { e.stopPropagation(); removeCustomAvatar(c.id); }}
                        aria-label={t("contacts.removeAvatar")}
                        title={t("contacts.removeAvatar")}
                        class="grid h-5 w-5 place-items-center rounded-full bg-red-500 text-white shadow-md transition active:scale-90"
                      >
                        {@html iconSvg("trash", "h-3 w-3")}
                      </button>
                    {/if}
                  </div>
                </div>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-ios-body font-medium text-neutral-900 dark:text-white">
                    {c.name}{c.fav ? " ★" : ""}
                  </span>
                  {#if primaryPhone(c)}
                    <span class="block truncate text-ios-footnote text-neutral-500 dark:text-neutral-400">
                      {primaryPhone(c)}{c.note ? ` · ${c.note}` : ""}
                    </span>
                  {/if}
                </span>
                <button onclick={() => openEdit(c)} aria-label={t("contacts.edit")} title={t("contacts.edit")}
                  class="grid h-9 w-9 place-items-center rounded-full text-neutral-500 opacity-80 transition active:scale-90 dark:text-neutral-300">{@html iconSvg("pencil", "h-4 w-4")}</button>
                <button onclick={() => persist(setContactFav(contacts, c.id, !c.fav))} aria-label={t("contacts.fav")} title={t("contacts.fav")}
                  class="text-lg opacity-70 transition active:scale-90">{c.fav ? "⭐" : "☆"}</button>
                <button onclick={() => void call(c)} aria-label={t("contacts.call")} title={t("contacts.call")}
                  class="grid h-9 w-9 place-items-center rounded-full bg-ios-green text-white shadow-sm transition active:scale-90">{@html iconSvg("phone", "h-4 w-4")}</button>
                <button
                  onclick={() => (confirmId === c.id ? persist(removeContact(contacts, c.id)) : (confirmId = c.id))}
                  aria-label={t("contacts.delete")}
                  title={t("contacts.delete")}
                  data-icon={confirmId === c.id ? "check" : "trash"}
                  class="grid h-9 w-9 place-items-center text-danger/80 transition active:scale-90">{@html iconSvg(confirmId === c.id ? "check" : "trash", "h-4 w-4")}</button>
              </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    
    <!-- iOS-style alphabet quick index -->
    {#if groups.length > 0}
      <div class="sticky top-1/2 flex -translate-y-1/2 flex-col items-center gap-0.5 py-2">
        {#each groups as grp (grp.letter)}
          <button
            onclick={() => {
              document.getElementById(`section-${grp.letter}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            aria-label={`${t("contacts.jumpTo")} ${grp.letter}`}
            class="grid h-4 w-4 place-items-center text-[9px] font-bold text-accent/70 transition hover:scale-150 active:text-accent dark:text-accent/60"
          >
            {grp.letter}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Hidden file input for avatar upload -->
  <input
    type="file"
    accept="image/*"
    bind:this={avatarFileInput}
    onchange={(e) => void handleAvatarUpload(e)}
    class="hidden"
    aria-label={t("contacts.uploadAvatar")}
  />

  <!-- Full-screen avatar preview modal -->
  {#if previewingAvatarFor}
    {@const contact = contactById(contacts, previewingAvatarFor)}
    {#if contact}
      <div
        onclick={closeAvatarPreview}
        onkeydown={(e) => { if (e.key === "Escape" || e.key === "Enter") closeAvatarPreview(); }}
        tabindex="0"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label={t("contacts.avatarPreview")}
      >
        <div class="relative max-h-[80vh] max-w-[80vw]">
          {#if hasCustomAvatar(contact)}
            <img
              src={getContactAvatarSrc(contact, false)}
              alt={contact.name}
              class="max-h-[80vh] max-w-[80vw] rounded-2xl shadow-2xl"
            />
          {:else}
            <div
              class="grid h-64 w-64 place-items-center rounded-2xl bg-gradient-to-br text-8xl shadow-2xl"
              style:background-image={`linear-gradient(135deg, hsl(${avatarHue(contact.name)} 60% 60%), hsl(${avatarHue(contact.name)} 50% 45%))`}
            >
              {avatarEmoji(contact.name, avatarTheme)}
            </div>
          {/if}
          <button
            onclick={closeAvatarPreview}
            aria-label={t("contacts.close")}
            class="absolute -right-3 -top-3 grid h-11 w-11 place-items-center rounded-full bg-white text-neutral-900 shadow-lg transition active:scale-90 dark:bg-neutral-800 dark:text-white"
          >
            {@html iconSvg("x", "h-5 w-5")}
          </button>
        </div>
      </div>
    {/if}
  {/if}

  {#if uploadProgress}
    <div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm">
      {uploadProgress}
    </div>
  {/if}
</div>

<style>
  /* Avatar bounce animation on click */
  @keyframes avatar-bounce {
    0% {
      transform: scale(1) rotate(0deg);
    }
    25% {
      transform: scale(1.2) rotate(-5deg);
    }
    50% {
      transform: scale(1.15) rotate(5deg);
    }
    75% {
      transform: scale(1.2) rotate(-3deg);
    }
    100% {
      transform: scale(1) rotate(0deg);
    }
  }

  :global(.animate-avatar-bounce) {
    animation: avatar-bounce 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
  }
</style>

