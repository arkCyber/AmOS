<script lang="ts">
  /**
   * LaunchpadTrigger.svelte — the 🚀 widget in the top bar.
   *
   * A shell module (see `lib/shellModule.ts`): it owns its own label and rendering
   * and asks the *container* for the Launchpad through the chrome handle — it never
   * touches `shellState` or the overlay components.
   */
  import { getContext } from "svelte";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../../lib/shellModule";
  import { t } from "../locale.svelte";
  import ChromeIconButton from "./ChromeIconButton.svelte";

  // `undefined` when the widget is rendered outside its container (an isolated
  // component test): then it simply does nothing rather than throwing.
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
</script>

<ChromeIconButton
  label={t("desktop.launchpad")}
  testId="chrome-launchpad"
  glyph="🚀"
  shortcut={api?.overlayShortcut("launchpad") ?? null}
  onclick={() => api?.openLaunchpad()}
/>
