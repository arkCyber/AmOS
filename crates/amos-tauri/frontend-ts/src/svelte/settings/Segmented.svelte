<script lang="ts">
  // Segmented.svelte — iOS segmented control used for single-choice rows
  // (外观 浅/深/自动, 语言, 自动息屏时长). Same visuals as the previous
  // inline implementation in SettingsApp.
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
</script>

<div
  role="radiogroup"
  aria-label={aria}
  class="inline-flex rounded-[9px] bg-neutral-200/70 p-[3px] ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
>
  {#each options as o (o.value)}
    <button
      role="radio"
      aria-checked={o.value === value}
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
