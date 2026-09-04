import { useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import {
  CONTACTS_KEY,
  addContact,
  contactsWithPhone,
  contactsWithPhoneExcept,
  editContact,
  normalizeContacts,
  primaryPhone,
  removeContact,
  searchContacts,
  setContactFav,
  sortContacts,
  avatarHue,
  groupContacts,
  type Contact,
} from "../lib/contacts";
import { bridged, telephonyDial } from "../lib/backend";
import { useOutgoingCalls } from "../lib/useOutgoingCalls";

/** First visible glyph of a name for the avatar (uppercased), else "?". */
function contactInitial(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

/** The address book ("通信录") — durable, searchable, favorites, call-out. */
export default function ContactsApp() {
  const { t } = useI18n();
  const [contacts, setContacts] = useState<Contact[]>(() =>
    normalizeContacts(readStoreValue<unknown>(CONTACTS_KEY, [])),
  );
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phones, setPhones] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** Non-null while an existing contact's fields are being edited. */
  const [editing, setEditing] = useState<Contact | null>(null);

  const persist = (next: Contact[]) => {
    writeStoreValue(CONTACTS_KEY, next);
    setContacts(next);
  };

  const { recents, frequent, recordOutgoing } = useOutgoingCalls(contacts);

  const shown = searchContacts(sortContacts(contacts), q);
  const groups = groupContacts(shown);

  const submit = () => {
    const ph = phones
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const input = { name, phones: ph, note: note || undefined };
    // Duplicate guard (both add & edit): refuse a number that already belongs to
    // another contact (when editing, the contact's own number is allowed).
    if (ph.length > 0) {
      const dup = (editing ? contactsWithPhoneExcept(contacts, ph[0]!, editing.id) : contactsWithPhone(contacts, ph[0]!));
      if (dup.length > 0) {
        setStatus(t("contacts.dup"));
        return;
      }
    }
    const next = editing
      ? editContact(contacts, editing.id, input)
      : addContact(contacts, input);
    if (next === contacts) {
      setStatus(t("contacts.required"));
      return;
    }
    persist(next);
    setEditing(null);
    setAdding(false);
    setName("");
    setPhones("");
    setNote("");
    setStatus("");
  };

  /** Start editing an existing contact: prefill the composer fields. */
  const openEdit = (c: Contact) => {
    setEditing(c);
    setAdding(false);
    setName(c.name);
    setPhones(c.phones.join("\n"));
    setNote(c.note ?? "");
    setStatus("");
  };

  /** Close the composer (add or edit) without saving. */
  const closeComposer = () => {
    setEditing(null);
    setAdding(false);
    setStatus("");
  };

  const callNumber = async (num: string, nameHint?: string) => {
    if (!num) return;
    if (!bridged()) {
      setStatus(t("contacts.offline"));
      return;
    }
    try {
      await telephonyDial(num);
      recordOutgoing(num, nameHint, t("contacts.dialed"));
      setStatus(t("contacts.dialing"));
    } catch {
      setStatus(t("contacts.offline"));
    }
  };
  const call = (c: Contact) => void callNumber(primaryPhone(c) ?? "", c.name);

  const chipRow = (header: string, items: { num: string; label: string }[]) =>
    items.length === 0 ? null : (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-widest opacity-50">
          {header}
        </span>
        {items.map(({ num, label }) => (
          <button
            key={num}
            onClick={() => void callNumber(num, label)}
            className="rounded-full bg-neutral-200/80 px-3 py-1 text-xs text-neutral-700 active:scale-95 dark:bg-white/10 dark:text-neutral-200"
            title={num}
          >
            📞 {label}
          </button>
        ))}
      </div>
    );

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("contacts.search")}
          className="min-w-0 flex-1 rounded-full bg-black/5 px-3.5 py-1.5 text-sm outline-none ring-1 ring-black/5 placeholder:text-black/30 dark:bg-white/10 dark:ring-white/10 dark:placeholder:text-white/30"
        />
        <button
          onClick={() => {
            setEditing(null);
            setAdding((v) => !v);
          }}
          className="rounded-full bg-accent px-3 py-1.5 text-sm text-white active:scale-95"
        >
          {t("contacts.add")}
        </button>
      </div>
      {status && <p className="mt-1 text-xs text-accent">{status}</p>}
      {chipRow(t("contacts.frequent"), frequent)}
      {chipRow(t("contacts.recent"), recents)}

      {(adding || editing) && (
        <div className="mt-2 space-y-2 rounded-2xl bg-white/70 p-3 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/10">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("contacts.name")}
            className="w-full rounded-xl bg-black/5 px-3 py-1.5 text-sm outline-none dark:bg-white/10"
          />
          <input
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            placeholder={t("contacts.phone")}
            className="w-full rounded-xl bg-black/5 px-3 py-1.5 text-sm outline-none dark:bg-white/10"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("contacts.note")}
            className="w-full rounded-xl bg-black/5 px-3 py-1.5 text-sm outline-none dark:bg-white/10"
          />
          <div className="flex gap-2">
            <button
              onClick={submit}
              className="rounded-full bg-accent px-4 py-1.5 text-sm text-white active:scale-95"
            >
              {t("contacts.save")}
            </button>
            <button
              onClick={closeComposer}
              className="rounded-full bg-neutral-300 px-4 py-1.5 text-sm dark:bg-neutral-700"
            >
              {t("contacts.cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {groups.length === 0 ? (
          <p className="py-10 text-center text-sm opacity-60">{t("contacts.empty")}</p>
        ) : (
          groups.map((grp) => (
            <div key={grp.letter}>
              <div className="sticky top-0 z-10 bg-neutral-100/90 px-1 py-0.5 text-[11px] font-bold uppercase tracking-widest text-neutral-400 dark:bg-black/40">
                {grp.letter}
              </div>
              {grp.items.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-2xl bg-white/60 px-3 py-2 ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
                >
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white"
                    style={{ backgroundColor: `hsl(${avatarHue(c.name)} 55% 55%)` }}
                  >
                    {contactInitial(c.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-neutral-900 dark:text-white">
                      {c.name}
                      {c.fav ? " ★" : ""}
                    </span>
                    {primaryPhone(c) && (
                      <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                        {primaryPhone(c)}
                        {c.note ? ` · ${c.note}` : ""}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => openEdit(c)}
                    aria-label={t("contacts.edit")}
                    title={t("contacts.edit")}
                    className="grid h-8 w-8 place-items-center rounded-full text-sm text-neutral-500 opacity-80 active:scale-90 dark:text-neutral-300"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => persist(setContactFav(contacts, c.id, !c.fav))}
                    aria-label={t("contacts.fav")}
                    title={t("contacts.fav")}
                    className="text-base opacity-70 active:scale-90"
                  >
                    {c.fav ? "⭐" : "☆"}
                  </button>
                  <button
                    onClick={() => void call(c)}
                    aria-label={t("contacts.call")}
                    title={t("contacts.call")}
                    className="grid h-8 w-8 place-items-center rounded-full bg-green-600/90 text-white active:scale-90"
                  >
                    📞
                  </button>
                  <button
                    onClick={() =>
                      confirmId === c.id
                        ? persist(removeContact(contacts, c.id))
                        : setConfirmId(c.id)
                    }
                    aria-label={t("contacts.delete")}
                    title={t("contacts.delete")}
                    className="h-8 w-8 text-danger/80 active:scale-90"
                  >
                    {confirmId === c.id ? "✓" : "🗑"}
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

