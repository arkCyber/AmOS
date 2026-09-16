<script lang="ts">
  /**
   * Field.svelte — one Settings row whose **visible label is structurally bound to the
   * control beside it** (REQ-A283).
   *
   * Before this, every page wrote the row by hand —
   *   `<div class={ROW}><span class={LABEL}>{label}</span><Switch aria={label} … /></div>`
   * — i.e. the text was written twice (once visible, once as the control's `aria-label`) and
   * the association existed only because a human kept the two copies equal. Two of the
   * fourteen Settings pages had already drifted: `<Segmented>` rows passed the *English slug*
   * (`aria="appearance"`, `aria="auto-screen-off"`, `aria="language"`) while the visible text
   * was Chinese — a screen reader read a string no user can see (WCAG 2.5.3 "Label in Name").
   *
   * Here the label is text on screen **and** the name of the control, from one `label` prop,
   * wired by two ids this component mints (`nextFieldId`, kit.ts) and hands to the control:
   *
   *   • `labelId` → the label element's `id`, referenced by the control as
   *     `aria-labelledby` (right for composite widgets such as <Segmented>'s radiogroup);
   *   • `id` → the label's `for`, for a native labelable control the snippet gives that id
   *     to (`<input>`/`<textarea>`/`<select>`, and `<button>`, which is what makes clicking
   *     the label toggle our <Switch>).
   *
   * A row that shows a **value** rather than a control is not a Field — a status readout has
   * nothing to associate, so those stay plain `ROW`/`LABEL`/`VALUE` markup.
   */
  import type { Snippet } from "svelte";
  import { LABEL, ROW, nextFieldId } from "./kit";

  let {
    label,
    control,
    icon,
  }: {
    /** The row's visible label text — localized by the caller (`t(...)`). This exact string
     *  is what a screen reader reads as the control's name. */
    label: string;
    /** Renders the control, applying the ids it is handed (see the two bullets above). */
    control: Snippet<[{ id: string; labelId: string }]>;
    /** Optional leading glyph, rendered `aria-hidden`: it is decoration, so it must never
     *  become part of the name (`"🛡️ 外发网闸"` would be read out as an emoji + text). */
    icon?: string;
  } = $props();

  const id = nextFieldId();
  const labelId = `${id}-label`;
</script>

<div class={ROW}>
  <label for={id} id={labelId} class={LABEL}>
    {#if icon}<span aria-hidden="true">{icon}</span> {/if}{label}
  </label>
  {@render control({ id, labelId })}
</div>
