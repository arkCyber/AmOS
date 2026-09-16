<script lang="ts">
  // ToggleRow.svelte — a Settings row whose control is the shared <Switch>: the common case
  // (14 pages, ~30 rows) as one component, so a page cannot write the label without the
  // association. The ids and the `<label>` element come from Field.svelte (REQ-A283).
  import Field from "./Field.svelte";
  import Switch from "./Switch.svelte";

  let {
    label,
    on,
    ontoggle,
    icon,
    disabled = false,
  }: {
    /** Visible label text; also the switch's accessible name. */
    label: string;
    on: boolean;
    ontoggle: () => void;
    /** Optional leading glyph, announced as decoration only (see Field.svelte). */
    icon?: string;
    disabled?: boolean;
  } = $props();
</script>

{#snippet control(ids: { id: string; labelId: string })}
  <Switch id={ids.id} labelledby={ids.labelId} {on} {ontoggle} {disabled} />
{/snippet}

<Field {label} {icon} {control} />
