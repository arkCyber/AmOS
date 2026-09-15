<script lang="ts">
  /**
   * TopbarAppName.svelte — the focused app's name, next to the Apple menu.
   *
   * macOS semantics: the bar shows the name of the app that is on screen (and it is
   * *not* the window title — `wm_set_shell_title` owns that). The widget owns its own
   * data: it subscribes to the host-written shared key (`amos.app_focused`) and the bar
   * no longer does, which is the whole point of the split (the container used to hold a
   * store subscription plus a `$derived` for a read-out that is not its business).
   *
   * The fallback is the product name, from `lib/version.ts` — one source instead of a
   * second spelling of it in a template.
   */
  import { APP_FOCUSED_KEY } from "../../lib/wm";
  import { createStoreValue } from "../store";
  import { AMOS_OS_NAME } from "../../lib/version";
  import { CHROME_TEXT, CHROME_TEXT_SHADOW } from "../../lib/shellChrome";

  /**
   * 键名从 `lib/wm.ts` 导入（与 Rust `store.rs::APP_FOCUSED_KEY` 同名）：不在这里
   * 再拼一遍字面量——`scripts/store-scan.mjs` 挡的正是"同一个键两处拼写"那类漂移。
   */
  const focusedStore = createStoreValue<string>(APP_FOCUSED_KEY, "");
  let focusedApp = $state("");

  $effect(() => {
    const un = focusedStore.subscribe((v) => (focusedApp = v ?? ""));
    return un;
  });

  /** `files` → `Files`. Empty ⇒ the shell itself is on screen ⇒ the product name. */
  const displayName = $derived(
    focusedApp ? focusedApp.charAt(0).toUpperCase() + focusedApp.slice(1) : AMOS_OS_NAME,
  );
</script>

<span
  class="{CHROME_TEXT} font-semibold"
  style="text-shadow: {CHROME_TEXT_SHADOW};"
  data-testid="menu-app-name">{displayName}</span
>