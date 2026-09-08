<script lang="ts">
  // Switch.svelte — iOS-style toggle used across the refactored Settings screen.
  // Mirrors the look/behaviour previously inlined in SettingsApp (green track +
  // white thumb, translate-x). Exported as its own component so every sub page
  // (lock, display, wifi/bluetooth, iCloud, airplane …) shares one implementation.
  let {
    on,
    ontoggle,
    aria,
    disabled = false,
  }: { on: boolean; ontoggle: () => void; aria?: string; disabled?: boolean } = $props();
</script>

<button
  role="switch"
  aria-checked={on}
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
