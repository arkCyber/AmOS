<script lang="ts">
  /**
   * ControlCenterButton.svelte — the ⚙️ item in the top bar, next to the clock.
   *
   * **This widget used to be the audit's example of a defect**: a `<button>` with an
   * accessible name, keyboard focus and no behaviour, then (REQ-A261) a **disabled**
   * control whose name said why. Both were honest about the same missing thing — the panel
   * — and the module boundary was the promise that landing the panel would be a one-file
   * change. It is one file, plus its registry row:
   *
   *   • `toggleOverlay("control-center-panel")` — macOS's own behaviour for this item
   *     (click opens the popover, click again dismisses it; a trigger that can only open
   *     would leave a panel the user cannot close the way they opened it);
   *   • `aria-expanded` from `isOverlayOpen(...)`, so the state the assistive layer hears is
   *     the state the shell has, not a guess.
   *
   * Mounted without a shell (a component test) there is no handle: it renders, and does
   * nothing when clicked — never throws, and never invents an open state.
   */
  import { getContext } from "svelte";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { t } from "../locale.svelte";
  import ChromeIconButton from "./ChromeIconButton.svelte";

  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const open = $derived(api?.isOverlayOpen("control-center-panel") ?? false);
</script>

<ChromeIconButton
  label={t("desktop.controlCenter")}
  testId="chrome-control-center"
  glyph="⚙️"
  expanded={open}
  onclick={() => api?.toggleOverlay("control-center-panel")}
/>
