import { useEffect, useState } from "react";
import {
  clipboardHistory,
  onClipboardChanged,
  previewClipboard,
  type ClipboardEntry,
} from "../lib/clipboard";

export interface ClipboardTrayProps {
  /** When `true` the panel loads + shows the clipboard history. */
  open: boolean;
  /** User tapped a history row → hand its full entry to the caller to paste. */
  onPick: (entry: ClipboardEntry) => void;
  /** Request to close (✕ button / Escape key). */
  onClose: () => void;
  /** Max history rows to fetch + render. */
  limit?: number;
}

/**
 * Clipboard **history tray**: a small overlay listing the most recent entries of
 * the AmOS global clipboard. Shows `clipboardHistory(limit)`, refreshes whenever a
 * new `clipboard-changed` notice arrives (then refetches so the row has content —
 * the actual read is foreground-gated on the Rust side), and hands a picked entry
 * to `onPick` so the caller can paste it.
 *
 * Renders as an inline panel so a caller can float it (absolute within a `relative`
 * wrapper) or drop it in normal flow. Renders `null` while closed.
 */
export function ClipboardTray({ open, onPick, onClose, limit = 8 }: ClipboardTrayProps) {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);

  // (Re)load history whenever we open and whenever a new copy notice arrives.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      const list = await clipboardHistory(limit);
      if (!cancelled) setEntries(list ?? []);
    };
    void refresh();
    let un: (() => void) | undefined;
    void onClipboardChanged(() => {
      void refresh();
    }).then((u) => {
      un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [open, limit]);

  // Escape closes the tray.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Clipboard history"
      className="w-72 rounded-2xl bg-white/95 p-2 shadow-lg ring-1 ring-black/10 dark:bg-neutral-800/95 dark:ring-white/10"
    >
      <div className="mb-1 flex items-center justify-between px-1 text-[11px] opacity-70">
        <span>📋 剪贴板</span>
        <button onClick={onClose} aria-label="Close clipboard history" className="px-1 hover:opacity-100">
          ✕
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs opacity-50">（暂无复制历史）</p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {entries.map((e) => (
            <li key={e.seq}>
              <button
                onClick={() => onPick(e)}
                className="block w-full truncate rounded-xl px-2 py-1.5 text-left text-sm text-neutral-800 ring-1 ring-transparent hover:bg-black/5 hover:ring-black/10 dark:text-neutral-100 dark:hover:bg-white/5 dark:hover:ring-white/10"
                title={previewClipboard(e)}
              >
                <span className="block truncate">{previewClipboard(e)}</span>
                <span className="block truncate text-[10px] opacity-50">{e.source}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
