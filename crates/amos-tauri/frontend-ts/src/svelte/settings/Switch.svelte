<script lang="ts">
  // Switch.svelte — iOS-style toggle used across the refactored Settings screen.
  // Mirrors the look/behaviour previously inlined in SettingsApp (green track +
  // white thumb, translate-x). Exported as its own component so every sub page
  // (lock, display, wifi/bluetooth, iCloud, airplane …) shares one implementation.
  let {
    on,
    ontoggle,
    aria,
    id,
    labelledby,
    disabled = false,
  }: {
    on: boolean;
    ontoggle: () => void;
    /** Accessible name as a *string* (`aria-label`). Prefer `labelledby` when the row has a
     *  visible label — see the two notes below. */
    aria?: string;
    /** The switch's own id, so a row's `<label for={id}>` can point at the button
     *  (`<button>` is a labelable element: this is what forwards a label click to the
     *  toggle, on top of the `labelledby` name). Handed over by `Field.svelte`. */
    id?: string;
    /** Id of the element that carries the visible label text → `aria-labelledby`
     *  (REQ-A283). This is the association a Settings row uses: the name the screen reader
     *  reads is then literally the text on screen, so the two cannot drift.
     *
     *  When both `labelledby` and `aria` are given, `aria-labelledby` wins (ARIA name
     *  computation order) — pass only one of them. */
    labelledby?: string;
    disabled?: boolean;
  } = $props();
</script>

<button
  role="switch"
  aria-checked={on}
  {id}
  aria-labelledby={labelledby}
  aria-label={aria}
  onclick={ontoggle}
  disabled={disabled}
  class={"h-7 w-[46px] shrink-0 rounded-full p-0.5 transition disabled:opacity-40 " +
    (on ? "bg-green-500" : "bg-neutral-300 dark:bg-neutral-600")}
>
  <span
    class={"block h-6 w-6 rounded-full bg-white shadow transition-transform " +
      (on ? "translate-x-[18px]" : "translate-x-0")}
  ></span>
</button>
