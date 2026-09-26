/**
 * DOM + channel tests for the share sheet's built-in targets (REQ-A1458).
 *
 * `lib/shareTargets.ts` is the *table*; its delivery rides the deep-link channels in
 * `svelte/appLinks.ts`, which is why this lives in the `.svelte` harness. Two things are
 * asserted: the table is not a second copy of the app metadata (it reads `appTitleKey` /
 * `appIcon`, so a renamed app renames the row), and a delivery really writes the target's
 * channel rather than merely reporting success.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import ShareSheet from "../src/svelte/ShareSheet.svelte";
import MailApp from "../src/svelte/MailApp.svelte";
import { BUILTIN_SHARE_TARGETS, builtinTargetsFor } from "../src/lib/shareTargets";
import { fileShare, textShare } from "../src/lib/shareSheet";
import { mailChannel, notesChannel } from "../src/svelte/appLinks";
import { resetPropsChannels } from "../src/svelte/propsBus";
import { openShareSheet, closeShareSheet } from "../src/svelte/shareSheetState.svelte";
import { appIcon, appTitleKey } from "../src/lib/appMeta";

beforeEach(() => {
  resetPropsChannels();
  closeShareSheet();
});

afterEach(() => {
  resetPropsChannels();
  closeShareSheet();
});

const byId = (id: string) => BUILTIN_SHARE_TARGETS.find((t) => t.id === id)!;

describe("shareTargets · the built-in table", () => {
  test("offers Notes and Mail by default, in a stable order", () => {
    expect(BUILTIN_SHARE_TARGETS.map((t) => t.id)).toEqual(["notes", "mail"]);
  });

  test("labels and icons are read from each app's own metadata, not copied", () => {
    for (const t of BUILTIN_SHARE_TARGETS) {
      expect(t.titleKey).toBe(appTitleKey(t.id));
      expect(t.icon).toBe(appIcon(t.id));
    }
  });

  test("a text payload offers both; the filter is over the payload's kind", () => {
    expect(builtinTargetsFor("text").map((t) => t.id)).toEqual(["notes", "mail"]);
    expect(builtinTargetsFor("file").map((t) => t.id)).toEqual(["notes", "mail"]);
  });

  test("a target that accepts nothing of this kind is not offered", () => {
    // The filter reads `accepts` (not a hard-coded list), so an entry narrowed to one
    // kind drops out of the other's rows.
    const narrowed = BUILTIN_SHARE_TARGETS.map((t) => ({ ...t, accepts: ["text" as const] }));
    const forFile = narrowed.filter((t) => t.accepts.includes("file"));
    expect(forFile).toEqual([]);
  });
});

describe("shareTargets · delivery really writes the target's channel", () => {
  test("Notes receives the content as a draft", () => {
    const ok = byId("notes").deliver(textShare("hello world", "note"));
    expect(ok).toBe(true);
    expect(notesChannel().get()?.draftText).toBe("hello world");
  });

  test("Mail receives the content as the body and the share title as the subject", () => {
    const ok = byId("mail").deliver(textShare("hello world", "note title"));
    expect(ok).toBe(true);
    const draft = mailChannel().get();
    expect(draft?.subject).toBe("note title");
    expect(draft?.body).toBe("hello world");
  });

  test("a body Mail will not take is refused, and nothing is handed over", () => {
    // `deliver` answers `false` rather than reporting a hand-off that did not happen —
    // the sheet keys its "do not close" decision on exactly this.
    const ok = byId("mail").deliver({ kind: "text", value: "   ", title: "blank" });
    expect(ok).toBe(false);
    expect(mailChannel().get()).toBeUndefined();
  });

  /**
   * The sibling of the Mail refusal above (REQ-A1557 ∕ F-SH-791). `openMailDraft`
   * answers `false` for an empty body and its entry reports that; `openNoteDraft`
   * refused the same input by silently returning, so this entry had to hard-code
   * `return true` — `deliver` reported a hand-off that never happened. The tell was
   * the asymmetry: the same row, one call over, reads its own verdict. The body is
   * passed un-normalized on purpose, exactly as the Mail case does — `deliver` is a
   * contract in its own right, not a function of who happens to call it.
   */
  test("a body Notes will not take is refused, and nothing is handed over", () => {
    const ok = byId("notes").deliver({ kind: "text", value: "   ", title: "blank" });
    expect(ok).toBe(false);
    expect(notesChannel().get()).toBeUndefined();
  });
});

describe("ShareSheet · built-in rows", () => {
  test("a file share lists the built-ins above the shortcut targets", async () => {
    expect(openShareSheet(fileShare("file contents", "a.txt"))).toBe(true);
    const h = render(ShareSheet);
    await tick();
    expect(h.queryByTestId("share-target-notes")).not.toBeNull();
    expect(h.queryByTestId("share-target-mail")).not.toBeNull();
  });

  test("choosing Mail closes the sheet and prefills the composer", async () => {
    expect(openShareSheet(textShare("file contents", "a.txt"))).toBe(true);
    const h = render(ShareSheet);
    await tick();
    const row = h.getByTestId("share-target-mail");
    row.click();
    await tick();
    // Closing *is* the success gesture: it must have happened only because the draft
    // really landed on the channel.
    expect(mailChannel().get()?.body).toBe("file contents");
    expect(h.queryByTestId("share-sheet")).toBeNull();
  });
});

/**
 * **A props channel is not a one-shot** (REQ-A1499 / F-SH-739).
 *
 * `mailChannel()` is a module singleton: it keeps the last value it was handed, and
 * `subscribe` replays that value to every late attach. `MailApp`'s reader consumed the
 * marker (`draftNonce`) but never the **channel**, so the marker guard only worked
 * within one mount — `draftNonce` resets to `0` with the component, and the next mount
 * replayed the previous share straight into a fresh composer. `MessagesApp`'s
 * `applyCompose` and `NotesApp`'s draft branch both re-`set` the channel to an empty
 * payload for exactly this reason; the comment on Mail's reader claimed the same
 * consume without doing it.
 */
describe("shareTargets · a Mail hand-off is consumed, not just remembered", () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const bodyBox = (h: { container: HTMLElement }) =>
    h.container.querySelector("textarea") as HTMLTextAreaElement | null;

  test("Mail prefills once, clears the channel, and a remount starts clean", async () => {
    expect(byId("mail").deliver(textShare("hello world", "note title"))).toBe(true);

    const first = render(MailApp);
    await tick();
    await settle();
    // The draft landed on the composer: the hand-off itself is intact.
    expect(bodyBox(first)?.value).toBe("hello world");
    cleanup();

    // …and it must NOT come back. A remount re-attaches to the same module-level
    // channel; if the reader only remembered the marker, `draftNonce` reset to `0`
    // here and the previous share reopened the composer the user had already handled.
    const again = render(MailApp);
    await tick();
    await settle();
    expect(bodyBox(again)).toBeNull();
    // The mechanism behind that: the channel was left empty, not merely ignored.
    expect(mailChannel().get()?.body).toBe("");
    cleanup();
  });
});
