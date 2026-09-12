<script lang="ts">
  // ContactsApp.svelte — Svelte 5 (runes) implementation of the contacts app.
  // All data logic reuses the pure helpers in
  // lib/contacts.ts; persistence goes through the shared amos.* store; the quick
  // "Frequent / Recent" call chips are derived from the shared call log via
  // createStoreValue (lib/calllog.ts) — never reimplemented.
  import {
    CONTACTS_KEY,
    addContact,
    avatarHue,
    contactById,
    contactNameFor,
    contactsWithPhone,
    contactsWithPhoneExcept,
    editContact,
    groupContacts,
    normalizeContacts,
    primaryPhone,
    removeContact,
    searchContacts,
    setContactFav,
    sortContacts,
  } from "../lib/contacts";
  import type { Contact } from "../lib/contacts";
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
  import { NOTIF_KEY, addNotif } from "../lib/settings";
  import type { Notif } from "../lib/settings";
  import { zh } from "../i18n/locales/zh";
  import { t } from "./locale.svelte";
  import { createStoreValue } from "./store";
  import { contactsChannel } from "./appLinks";

  /** First visible glyph of a name for the avatar (uppercased), else "?". */
  function contactInitial(name: string): string {
    const ch = name.trim().charAt(0);
    return ch ? ch.toUpperCase() : "?";
  }

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
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
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
      class="min-w-0 flex-1 rounded-full bg-black/5 px-3.5 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30"
    />
    <button
      onclick={() => {
        editing = null;
        adding = !adding;
      }}
      aria-label={t("contacts.add")}
      class="rounded-full bg-accent px-3 py-1.5 text-sm text-white active:scale-95"
    >
      {t("contacts.add")}
    </button>
  </div>

  {#if status}
    <p class="mt-1 text-xs text-accent">{status}</p>
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

  <div class="mt-3 space-y-1.5">
    {#if groups.length === 0}
      <p class="py-10 text-center text-sm opacity-60">{t("contacts.empty")}</p>
    {:else}
      {#each groups as grp (grp.letter)}
        <div>
          <div class="sticky top-0 z-10 bg-neutral-100/90 px-1 py-0.5 text-xs font-bold uppercase tracking-widest text-neutral-400 dark:bg-black/40">
            {grp.letter}
          </div>
          {#each grp.items as c (c.id)}
            <div class="flex items-center gap-3 rounded-2xl px-3 py-2 ring-1 transition {spotId === c.id ? 'bg-accent/15 ring-accent dark:bg-accent/20' : 'bg-white/60 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10'}" data-spotlight={spotId === c.id ? "hit" : undefined}>
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white"
                style:background-color={`hsl(${avatarHue(c.name)} 55% 55%)`}>
                {contactInitial(c.name)}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium text-neutral-900 dark:text-white">
                  {c.name}{c.fav ? " ★" : ""}
                </span>
                {#if primaryPhone(c)}
                  <span class="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {primaryPhone(c)}{c.note ? ` · ${c.note}` : ""}
                  </span>
                {/if}
              </span>
              <button onclick={() => openEdit(c)} aria-label={t("contacts.edit")} title={t("contacts.edit")}
                class="grid h-8 w-8 place-items-center rounded-full text-neutral-500 opacity-80 active:scale-90 dark:text-neutral-300">{@html iconSvg("pencil", "h-4 w-4")}</button>
              <button onclick={() => persist(setContactFav(contacts, c.id, !c.fav))} aria-label={t("contacts.fav")} title={t("contacts.fav")}
                class="text-base opacity-70 active:scale-90">{c.fav ? "⭐" : "☆"}</button>
              <button onclick={() => void call(c)} aria-label={t("contacts.call")} title={t("contacts.call")}
                class="grid h-8 w-8 place-items-center rounded-full bg-green-600/90 text-white active:scale-90">{@html iconSvg("phone", "h-4 w-4")}</button>
              <button
                onclick={() => (confirmId === c.id ? persist(removeContact(contacts, c.id)) : (confirmId = c.id))}
                aria-label={t("contacts.delete")}
                title={t("contacts.delete")}
                data-icon={confirmId === c.id ? "check" : "trash"}
                class="grid h-8 w-8 place-items-center text-danger/80 active:scale-90">{@html iconSvg(confirmId === c.id ? "check" : "trash", "h-4 w-4")}</button>
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

