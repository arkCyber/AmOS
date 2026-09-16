<script lang="ts">
  // ChoiceRow.svelte — a Settings row whose control is the shared <Segmented> (外观浅/深/自动,
  // 语言, 自动息屏时长 …). The group is named by the row's *visible* label: the three pages
  // that predate this passed an English slug instead (`aria="appearance"`), which no user can
  // see. Named through the ids Field.svelte mints (REQ-A283).
  import Field from "./Field.svelte";
  import Segmented from "./Segmented.svelte";

  let {
    label,
    options,
    value,
    onpick,
  }: {
    /** Visible label text; also the radiogroup's accessible name. */
    label: string;
    options: { value: string; label: string }[];
    value: string;
    onpick: (v: string) => void;
  } = $props();
</script>

{#snippet control(ids: { id: string; labelId: string })}
  <Segmented id={ids.id} labelledby={ids.labelId} {options} {value} {onpick} />
{/snippet}

<Field {label} {control} />
