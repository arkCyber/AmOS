<script lang="ts">
  // Segmented.svelte — iOS segmented control used for single-choice rows
  // (外观 浅/深/自动, 语言, 自动息屏时长). Same visuals as the previous
  // inline implementation in SettingsApp.
  //
  // Keyboard (REQ-A149): an ARIA `radiogroup` is expected to move the selection with the
  // arrow keys, and to expose exactly one tab stop (roving tabindex). Native `<button>`
  // gave each option its own tab stop and ignored the arrows — usable, but not what a
  // radiogroup means to a screen reader or to a keyboard user.
  import { tick } from "svelte";
  let {
    options,
    value,
    onpick,
    aria,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onpick: (v: string) => void;
    aria?: string;
  } = $props();

  let group = $state<HTMLDivElement | null>(null);
  // The `radiogroup` container needs a handle for focus lookup, but the keydown handler
  // lives on the options (see the markup): a handler on a non-focusable element would be
  // unreachable by keyboard and trips Svelte's `a11y_interactive_supports_focus`.
  const el = (node: HTMLDivElement) => {
    group = node;
  };

  async function move(delta: number) {
    const i = options.findIndex((o) => o.value === value);
    if (i < 0) return;
    const j = (i + delta + options.length) % options.length;
    const next = options[j];
    if (!next || next.value === value) return;
    onpick(next.value);
    // Selection follows focus, so the focus ring lands on the newly picked option.
    await tick();
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[j]?.focus();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      void move(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      void move(-1);
    }
  }
</script>

<div
  role="radiogroup"
  aria-label={aria}
  use:el
  class="inline-flex rounded-[9px] bg-neutral-200/70 p-[3px] ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
>
  {#each options as o (o.value)}
    <button
      role="radio"
      aria-checked={o.value === value}
      tabindex={o.value === value ? 0 : -1}
      onkeydown={onkeydown}
      onclick={() => onpick(o.value)}
      class={"rounded-md px-3.5 py-1.5 text-sm leading-none transition " +
        (o.value === value
          ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-white dark:shadow-black/40"
          : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white")}
    >
      {o.label}
    </button>
  {/each}
</div>
