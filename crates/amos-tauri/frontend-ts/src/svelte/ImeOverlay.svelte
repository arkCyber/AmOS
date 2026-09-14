<script lang="ts">
  // ImeOverlay.svelte — the System UI's input method.
  //
  // Behavior owner for the on-screen pinyin keyboard:
  //  • tracks the focused text field (`focusin`/`focusout` on `document`) and
  //    shows the docked keyboard while one is focused (and the IME is on),
  //  • routes taps to the Rust engine (`lib/ime` wrappers) and writes the
  //    committed text into that field with `insertTextAtCursor`,
  //  • abandons an in-flight pinyin code when the field goes away, so a
  //    half-typed code can never be committed into the *next* field.
  //
  // The keyboard is off by default on a fine-pointer (desktop) device and on for
  // `(pointer: coarse)` — a physical keyboard already works on a desktop, while a
  // touch device has no other way to type. The preference is persisted
  // (`amos-ui.ime`), and the ⌨ button enables/disables it on the spot, so the
  // default is never a dead end. See `docs/input-method.md`.
  import { onMount } from "svelte";
  import {
    IME_CANDIDATE_PAGE_SIZE,
    IME_ENABLED_KEY,
    candidatePageCount,
    deleteBeforeCaret,
    imeBackspace,
    imeClear,
    imeCommit,
    imeForgetLast,
    imeFuzzyPreset,
    imeFuzzyToggle,
    imeKey,
    imeLearningClear,
    imeStatus,
    insertTextAtCursor,
    isTextEntry,
    readImeEnabled,
    writeImeEnabled,
    type ImeState,
  } from "../lib/ime";
  import { STORE_CHANGED_EVENT } from "../lib/amosStore";
  import { amosWarn } from "../lib/debugLog";
  import ImeKeyboard from "./ImeKeyboard.svelte";
  import { t } from "./locale.svelte";

  /** The keyboard's own root, used to tell "focus moved into the keyboard" from
   *  "the user left the field". */
  const KEYBOARD_SEL = '[data-testid="ime-keyboard"]';

  let enabled = $state(readImeEnabled());
  let active = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
  /** Collapsed for this focus session (the ⌨ button brings it back). */
  let hidden = $state(false);
  let settingsOpen = $state(false);
  let mode = $state<"zh" | "en">("zh");
  let page = $state(0);
  let session = $state<ImeState | null>(null);
  /** Whether the Rust bridge answered at all (browser preview ⇒ no engine). */
  let online = $state(false);
  /** A command that never reached the engine — shown, never swallowed. */
  let bridgeError = $state(false);
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  const visible = $derived(enabled && !!active && !hidden);

  /** Adopt a state from the engine. */
  function apply(next: ImeState | null): void {
    if (!next) {
      // A command that could not reach the bridge. Keep the last known state: a
      // transient failure must not permanently demote the keyboard (there would be
      // no way back, since a degraded keyboard stops calling the engine at all) —
      // but the user must **see** that their tap did not land.
      bridgeError = true;
      amosWarn("ime", "the input-method bridge did not answer");
      return;
    }
    bridgeError = false;
    online = true;
    session = next;
    page = Math.min(page, candidatePageCount(next.candidates.length) - 1);
  }

  /**
   * The engine is not there at all (browser preview, or a build without it): the
   * only honest configuration is literal typing, so the keyboard drops to English
   * and offers nothing that would need the engine (the banner explains why).
   */
  function degrade(): void {
    online = false;
    mode = "en";
    session = null;
    bridgeError = false; // the offline banner says it, so no second notice
  }

  /** Turn the IME on/off and remember it. */
  function setEnabled(on: boolean): void {
    enabled = on;
    hidden = !on;
    settingsOpen = false;
    writeImeEnabled(on);
    if (!on) abandon();
  }

  /** Give up the current session: drop the field and any in-flight code. */
  function abandon(): void {
    active = null;
    settingsOpen = false;
    if (session?.composing) {
      void imeClear().then((s) => apply(s));
    }
  }

  function focusTargetOf(e: FocusEvent): HTMLInputElement | HTMLTextAreaElement | null {
    const raw = e.relatedTarget;
    const el = raw instanceof Element ? raw : null;
    return isTextEntry(el) ? el : null;
  }

  function onFocusIn(e: FocusEvent): void {
    const raw = e.target;
    const el = raw instanceof Element ? raw : null;
    if (!isTextEntry(el)) return;
    if (active !== el && session?.composing) {
      // Moving straight into another field abandons the old code.
      void imeClear().then((s) => apply(s));
    }
    active = el;
    hidden = false;
  }

  function onFocusOut(e: FocusEvent): void {
    const next = focusTargetOf(e);
    if (next) {
      if (active !== next && session?.composing) void imeClear().then((s) => apply(s));
      active = next;
      return;
    }
    if (e.relatedTarget instanceof Element && e.relatedTarget.closest(KEYBOARD_SEL)) {
      return; // focus moved onto a key: the session stays
    }
    // Defer: some engines clear `activeElement` before assigning the next target.
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusTimer = null;
      const el = document.activeElement;
      if (isTextEntry(el)) {
        active = el;
        return;
      }
      if (el instanceof Element && el.closest(KEYBOARD_SEL)) return;
      abandon();
    }, 0);
  }

  /**
   * The focused field, if it is still a field the keyboard may write into.
   *
   * `active` can outlive the element it points at: **removing the focused node from
   * the document moves focus to `<body>`, and no `focusout` is fired**, so the
   * overlay would keep writing into a node the user can no longer see — a
   * programmatic `.value` write into a detached input "succeeds" and reports
   * success while nothing appears on screen (silently losing the text). A field
   * that left the document therefore ends the session, exactly like losing focus
   * does; the code is abandoned and the dock goes away instead of typing nowhere.
   *
   * A field can also become read-only/disabled *while* it is focused, and a
   * programmatic `.value` write sails straight past `readOnly` — that is refused
   * too. Both refusals are reported through the diagnostics ledger rather than
   * losing the text quietly.
   */
  function liveField(): HTMLInputElement | HTMLTextAreaElement | null {
    const field = active;
    if (!field) return null;
    if (!field.isConnected) {
      amosWarn("ime", "the focused field left the document; ending the session");
      abandon();
      return null;
    }
    if (!isTextEntry(field)) {
      amosWarn("ime", "insertion refused: the focused field is no longer editable");
      return null;
    }
    return field;
  }

  /** Insert committed text into the focused field (the only write path). */
  function typeInto(text: string): boolean {
    const field = liveField();
    if (!field) return false;
    if (!insertTextAtCursor(field, text)) {
      amosWarn("ime", "the focused field refused the inserted text");
      return false;
    }
    return true;
  }

  /** Insert a literal character: a space, a newline, a symbol or an English letter. */
  function insertLiteral(ch: string): void {
    if (ch === "\n") {
      // A newline only exists in a multi-line field — an `<input>` would silently
      // strip it while we claimed to have inserted something.
      if (active instanceof HTMLTextAreaElement) typeInto("\n");
      return;
    }
    typeInto(ch);
  }

  function commitAt(index: number): void {
    void imeCommit(index).then((out) => {
      if (!out) return;
      apply(out.state);
      if (out.committed) typeInto(out.committed);
    });
  }

  /** Commit the highlighted candidate, then insert `ch` after it. */
  function commitThenInsert(ch: string): void {
    void imeCommit(0).then((out) => {
      if (!out) return;
      apply(out.state);
      if (out.committed) typeInto(out.committed);
      insertLiteral(ch);
    });
  }

  /**
   * A printable key that is **not a letter**: a digit, punctuation or a symbol.
   *
   * The engine only accepts ASCII letters, so feeding it here would swallow the
   * character. The ordinary IME move is to commit whatever is composing first and
   * then insert the character literally — otherwise the character would land in
   * the field *before* the Chinese the user typed first, and the code would stay
   * in flight behind it.
   *
   * **Both surfaces call this function** (the on-screen key pad through `press`,
   * the physical keyboard through `onKeyDown`), which is what keeps them from
   * drifting apart: a physical `,` used to reach the field on its own — in front
   * of the Chinese — while the pinyin code kept composing.
   */
  function typeNonLetter(ch: string): void {
    if (session?.composing && session.candidates.length > 0) {
      page = 0;
      commitThenInsert(ch);
      return;
    }
    insertLiteral(ch);
  }

  /** A key tap: English mode types straight through; Chinese mode composes. */
  function press(ch: string): void {
    if (mode === "en") {
      insertLiteral(ch);
      return;
    }
    if (ch === " " || ch === "\n") {
      // Space/Enter commit the first candidate while composing (IME convention)…
      if (session?.composing && session.candidates.length > 0) {
        page = 0;
        commitAt(0);
        return;
      }
      // …otherwise they mean what they say. A code the dictionary has *no*
      // candidate for is not an exception: the key must never vanish into
      // nothing (the same rule the physical Space follows).
      insertLiteral(ch);
      return;
    }
    if (/^[a-zA-Z]$/.test(ch)) {
      page = 0; // a new letter means a new candidate list, so start at page one
      void imeKey(ch).then((s) => apply(s));
      return;
    }
    typeNonLetter(ch);
  }

  function onBackspace(): void {
    if (session?.composing) {
      page = 0;
      void imeBackspace().then((s) => apply(s));
      return;
    }
    const field = liveField();
    if (field) deleteBeforeCaret(field);
  }

  function changeMode(next: "zh" | "en"): void {
    mode = next;
    page = 0;
    // Leaving Chinese mode abandons the in-flight code instead of carrying it.
    if (next === "en" && session?.composing) void imeClear().then((s) => apply(s));
  }

  function forgetLast(): void {
    void imeForgetLast().then((s) => apply(s));
  }

  function pageTo(next: number): void {
    // Clamp here as well as in the keyboard: `page` is this component's state, and
    // an out-of-range value would make a visible candidate report an index that
    // commits nothing (the engine would answer `None`).
    const pages = candidatePageCount(session?.candidates.length ?? 0);
    page = Math.min(Math.max(0, next), pages - 1);
  }

  /**
   * Physical keys drive the same engine the on-screen keys do — that is what makes
   * this an *input method* rather than a touch-only keyboard, and it is why a
   * pinyin letter can no longer reach the shell's H/V/A navigation shortcuts
   * (`osInputBridge`): this listener is on the **capture** path and consumes the
   * key, so while the IME is up it owns the keystroke.
   *
   * Only when the keyboard is actually showing (enabled + a text field focused +
   * not hidden) and only in Chinese mode; a native composition (`isComposing`) and
   * every modifier combination pass straight through.
   */
  function onKeyDown(e: KeyboardEvent): void {
    if (!visible) return;
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "Escape") {
      // Only consumed when there is something to cancel, so the shell's global
      // Escape (close overlays) keeps working the rest of the time.
      if (!session?.composing) return;
      consume(e);
      page = 0;
      void imeClear().then((s) => apply(s));
      return;
    }
    if (mode === "en") return; // English mode is literal: the field owns the keys

    if (/^[a-zA-Z]$/.test(e.key)) {
      consume(e);
      page = 0; // a new letter means a new candidate list, so start at page one
      void imeKey(e.key).then((s) => apply(s));
      return;
    }

    const candidates = session?.candidates ?? [];
    if (session?.composing !== true) return; // nothing in flight: the field owns the rest

    if (e.key === "Backspace") {
      consume(e);
      page = 0;
      void imeBackspace().then((s) => apply(s));
      return;
    }
    // 1–9 pick the candidate with that number on the page that is showing.
    if (/^[1-9]$/.test(e.key) && candidates.length > 0) {
      const index = page * IME_CANDIDATE_PAGE_SIZE + (Number(e.key) - 1);
      if (index < candidates.length) {
        consume(e);
        page = 0;
        commitAt(index);
        return;
      }
    }
    // Everything else printable — Space, Enter, a digit this page has no candidate
    // for, punctuation — goes through the **same** rule the on-screen keys use
    // (`press`), so one IME behaviour cannot depend on which keyboard produced the
    // key. The code gets committed first and the character is then inserted
    // literally, never swallowed and never placed in front of the Chinese.
    // Non-printable keys (Tab, arrows, PageUp/Down, …) are left to the field.
    if (e.key === " " || e.key === "Enter" || e.key.length === 1) {
      consume(e);
      press(e.key === "Enter" ? "\n" : e.key);
    }
  }

  /** Take the keystroke: no text goes into the field, and no shell shortcut fires. */
  function consume(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
  }

  function toggleFuzzy(pair: string): void {
    void imeFuzzyToggle(pair).then((s) => apply(s));
  }

  function applyPreset(preset: string): void {
    void imeFuzzyPreset(preset).then((s) => apply(s));
  }

  function clearLearning(): void {
    void imeLearningClear().then((s) => apply(s));
  }

  // The dock covers the bottom of the screen, so a field that sits low would be
  // hidden behind the keyboard the moment it opens — bring it back into view so
  // the user can see what they are typing. (A field that is already gone is not
  // scrolled: `liveField` would end the session for a rendering side effect.)
  $effect(() => {
    if (!visible) return;
    const field = active;
    if (!field || !field.isConnected) return;
    field.scrollIntoView?.({ block: "nearest" });
  });

  onMount(() => {
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // Capture phase: while the keyboard is up, the input method takes the keystroke
    // *before* the focused component (or the shell's shortcuts) sees it.
    document.addEventListener("keydown", onKeyDown, true);
    // The Settings page owns the same switch this keyboard does: a store change is
    // how the two surfaces stay in step (same key, same window).
    const onStore = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (key !== IME_ENABLED_KEY) return;
      enabled = readImeEnabled();
      hidden = false;
      if (!enabled) abandon();
    };
    window.addEventListener(STORE_CHANGED_EVENT, onStore);
    void imeStatus().then((s) => {
      if (s) apply(s);
      else degrade();
    });
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(STORE_CHANGED_EVENT, onStore);
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = null;
    };
  });
</script>

{#if visible}
  <div class="absolute inset-x-0 bottom-0 z-40" data-testid="ime-dock">
    <ImeKeyboard
      session={session}
      {online}
      error={bridgeError}
      {mode}
      {page}
      {settingsOpen}
      onkey={press}
      onbackspace={onBackspace}
      onclear={() => void imeClear().then((s) => apply(s))}
      oncommit={commitAt}
      onpage={pageTo}
      onmode={changeMode}
      onhide={() => (hidden = true)}
      onsettings={() => (settingsOpen = !settingsOpen)}
      onpreset={applyPreset}
      onfuzztoggle={toggleFuzzy}
      onlearnclear={clearLearning}
      ondisable={() => setEnabled(false)}
      onforget={forgetLast}
    />
  </div>
{:else if active}
  <!-- A field is focused but the keyboard is hidden/off: the one tap that brings it
       back (and the only way to turn it on from a desktop). -->
  <button
    type="button"
    data-testid="ime-show"
    aria-label={enabled ? t("ime.show") : t("ime.toggleOn")}
    onclick={() => (enabled ? (hidden = false) : setEnabled(true))}
    class="absolute bottom-6 right-3 z-40 grid h-10 w-10 place-items-center rounded-full bg-white/90 text-lg shadow-md ring-1 ring-black/10 dark:bg-neutral-800/90 dark:text-neutral-100 dark:ring-white/10"
  >
    ⌨
  </button>
{/if}
