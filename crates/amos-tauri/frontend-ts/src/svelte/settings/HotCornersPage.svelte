<script lang="ts">
  /**
   * HotCornersPage.svelte — settings page for configuring hot corners.
   *
   * Allows users to assign actions to each screen corner, set delays, and
   * optionally require modifier keys to prevent accidental triggers.
   */
  import { readStoreValue, writeStoreValueChecked } from "../../lib/amosStore";
  import {
    DEFAULT_HOT_CORNERS,
    HOT_CORNER_KEY,
    normalizeHotCorners,
    type Corner,
    type HotCornerAction,
    type HotCornerConfig,
  } from "../../lib/hotCorners";
  import { t } from "../locale.svelte";
  import { GROUP, HINT } from "./kit";
  import StoreErrorBar from "../StoreErrorBar.svelte";

  let configs = $state<HotCornerConfig[]>(
    normalizeHotCorners(readStoreValue(HOT_CORNER_KEY, DEFAULT_HOT_CORNERS))
  );
  let storeErr = $state("");

  const actions: { value: HotCornerAction; labelKey: string }[] = [
    { value: "disabled", labelKey: "settings.hotCorner.disabled" },
    { value: "mission-control", labelKey: "settings.hotCorner.missionControl" },
    { value: "launchpad", labelKey: "settings.hotCorner.launchpad" },
    { value: "desktop", labelKey: "settings.hotCorner.desktop" },
    { value: "notification-center", labelKey: "settings.hotCorner.notificationCenter" },
    { value: "lock-screen", labelKey: "settings.hotCorner.lockScreen" },
  ];

  const modifiers: { value: string; labelKey: string }[] = [
    { value: "", labelKey: "settings.hotCorner.noModifier" },
    { value: "shift", labelKey: "settings.hotCorner.shift" },
    { value: "control", labelKey: "settings.hotCorner.control" },
    { value: "alt", labelKey: "settings.hotCorner.alt" },
    { value: "meta", labelKey: "settings.hotCorner.meta" },
  ];

  function updateCorner(
    corner: Corner,
    updates: Partial<Omit<HotCornerConfig, "corner">>
  ) {
    const next = configs.map((c) =>
      c.corner === corner ? { ...c, ...updates } : c
    );
    if (writeStoreValueChecked(HOT_CORNER_KEY, next)) {
      configs = next;
      storeErr = "";
    } else {
      storeErr = t("common.storeWriteFailed");
    }
  }

  function getConfig(corner: Corner): HotCornerConfig {
    return configs.find((c) => c.corner === corner) || DEFAULT_HOT_CORNERS[0];
  }

  const cornerLabels: Record<Corner, string> = {
    "top-left": t("settings.hotCorner.topLeft"),
    "top-right": t("settings.hotCorner.topRight"),
    "bottom-left": t("settings.hotCorner.bottomLeft"),
    "bottom-right": t("settings.hotCorner.bottomRight"),
  };
</script>

<section class="space-y-4">
  <div class="px-4 pt-4">
    <h2 class="text-lg font-semibold">{t("settings.hotCorners")}</h2>
    <p class={HINT}>{t("settings.hotCornersHint")}</p>
  </div>

  <StoreErrorBar message={storeErr} />

  <!-- Grid layout mimicking screen corners -->
  <div class="grid grid-cols-2 gap-4 px-4 pb-4">
    {#each ["top-left", "top-right", "bottom-left", "bottom-right"] as corner}
      {@const config = getConfig(corner as Corner)}
      <div class={GROUP}>
        <div class="px-4 py-3">
          <label class="block text-sm font-medium mb-2">
            {cornerLabels[corner as Corner]}
          </label>

          <!-- Action selector -->
          <select
            value={config.action}
            onchange={(e) =>
              updateCorner(corner as Corner, {
                action: e.currentTarget.value as HotCornerAction,
              })}
            class="w-full rounded-lg bg-white/50 px-3 py-2 text-sm dark:bg-white/10 border border-black/10 dark:border-white/10"
          >
            {#each actions as { value, labelKey }}
              <option {value}>{t(labelKey)}</option>
            {/each}
          </select>

          {#if config.action !== "disabled"}
            <!-- Modifier key selector -->
            <label class="block text-xs opacity-60 mt-3 mb-1">
              {t("settings.hotCorner.modifier")}
            </label>
            <select
              value={config.modifier || ""}
              onchange={(e) => {
                const val = e.currentTarget.value;
                updateCorner(corner as Corner, {
                  modifier: val ? (val as any) : undefined,
                });
              }}
              class="w-full rounded-lg bg-white/50 px-3 py-1.5 text-xs dark:bg-white/10 border border-black/10 dark:border-white/10"
            >
              {#each modifiers as { value, labelKey }}
                <option {value}>{t(labelKey)}</option>
              {/each}
            </select>

            <!-- Delay slider -->
            <label class="block text-xs opacity-60 mt-3 mb-1">
              {t("settings.hotCorner.delay")}: {config.delay}ms
            </label>
            <input
              type="range"
              min="0"
              max="2000"
              step="100"
              value={config.delay}
              oninput={(e) =>
                updateCorner(corner as Corner, {
                  delay: parseInt(e.currentTarget.value),
                })}
              class="w-full"
            />
          {/if}
        </div>
      </div>
    {/each}
  </div>
</section>
