<script lang="ts">
  /**
   * RadiosWidget.svelte — the top bar's Wi-Fi / cellular glyphs.
   *
   * Moved out of `TopBar` **verbatim in behaviour**: it owns the `amos.settings`
   * subscription and the `online`/`offline` listeners, and renders exactly what
   * `lib/netStatus.ts` already decides (connected / searching / off — never an
   * invented signal strength). Split from the battery read-out so each widget has
   * one reason to re-render: the bar used to tick every second *and* repaint both
   * read-outs whenever quick settings changed.
   */
  import { iconSvg, radioIcon } from "../../lib/sysIcons";
  import { statusIcons } from "../../lib/netStatus";
  import { SETTINGS_KEY, normalizeQuick } from "../../lib/settings";
  import { createStoreValue } from "../store";
  import { t } from "../locale.svelte";
  import { CHROME_STATUS_GLYPH, CHROME_TEXT_SHADOW } from "../../lib/shellChrome";

  const settingsStore = createStoreValue<unknown>(SETTINGS_KEY, {});
  let quickRaw = $state<unknown>({});
  let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

  $effect(() => {
    const un = settingsStore.subscribe((v) => (quickRaw = v));
    return un;
  });
  $effect(() => {
    const on = () => (online = true);
    const off = () => (online = false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  });

  const quick = $derived(normalizeQuick(quickRaw));
  const icons = $derived(
    statusIcons(quick, online, typeof quick.wifi === "string" ? quick.wifi : null),
  );

  /** 规范化 title 为字符串（i18n key 可能返回 undefined） */
  function titleOrUndef(s: unknown): string | undefined {
    return typeof s === "string" ? s : undefined;
  }
</script>

<div class="flex items-center gap-2.5" data-testid="chrome-radios">
  {#each icons as ic (ic.kind)}
    <span
      title={titleOrUndef(
        ic.titleKey ? t(ic.titleKey, ic.titleSsid ? { ssid: ic.titleSsid } : undefined) : undefined,
      )}
      class="{CHROME_STATUS_GLYPH} text-[11px] {ic.on ? 'text-white/90' : 'text-white/30'}"
      style="text-shadow: {CHROME_TEXT_SHADOW};"
    >{@html iconSvg(radioIcon(ic.kind), "")}</span>
  {/each}
</div>
