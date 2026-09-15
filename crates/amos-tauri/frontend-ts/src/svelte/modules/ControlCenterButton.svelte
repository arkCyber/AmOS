<script lang="ts">
  /**
   * ControlCenterButton.svelte — the ⚙️ widget in the top bar.
   *
   * **Audit finding (fixed here):** this glyph used to be a `<button>` with an
   * accessible name and *no* click handler — a control that looks pressable, is
   * announced as pressable, and does nothing. The shell has no control-centre panel
   * yet (that is G6 work), so the honest form is a **disabled** control whose label
   * says why; an inert control must not soak up a click and pretend.
   *
   * When the panel lands, this widget gets an intent on the chrome handle
   * (`openControlCenter`) and stops being disabled — the module boundary is what
   * makes that a one-file change.
   */
  import { t } from "../locale.svelte";
  import ChromeIconButton from "./ChromeIconButton.svelte";
</script>

<ChromeIconButton
  label={t("desktop.controlCenterUnavailable")}
  testId="chrome-control-center"
  glyph="⚙️"
  onclick={() => {}}
  disabled={true}
/>
