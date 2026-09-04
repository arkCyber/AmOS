import { useState } from "react";
import { readStoreValue, writeStoreValue } from "./amosStore";
import {
  CALLLOG_KEY,
  frequentNumbers,
  normalizeCallLog,
  recentNumbers,
  recordCall,
  type CallRecord,
} from "./calllog";
import { NOTIF_KEY, addNotif, type Notif } from "./settings";
import { contactNameFor, type Contact } from "./contacts";
import { zh } from "../i18n/locales/zh";

/**
 * Shared "outgoing call" log + quick-dial state, used by both `ContactsApp` and
 * `PhoneApp` so call history / Frequent ⭐ / Recent / recording + notification are
 * identical everywhere. Label resolution uses the caller's live contacts.
 */
export function useOutgoingCalls(contacts: Contact[]) {
  const [recent, setRecent] = useState<CallRecord[]>(() =>
    normalizeCallLog(readStoreValue(CALLLOG_KEY, [])),
  );
  const recents = recentNumbers(recent, 4).map((n) => ({
    num: n,
    label: contactNameFor(contacts, n) ?? n,
  }));
  const frequent = frequentNumbers(recent, 3).map((n) => ({
    num: n,
    label: contactNameFor(contacts, n) ?? n,
  }));

  /** Record a placed call + raise a phone notification (functional update). */
  const recordOutgoing = (num: string, name?: string, body?: string) => {
    setRecent((prev) => {
      const next = recordCall(prev, num, name);
      writeStoreValue(CALLLOG_KEY, next);
      return next;
    });
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
  };

  return { recents, frequent, recordOutgoing };
}
