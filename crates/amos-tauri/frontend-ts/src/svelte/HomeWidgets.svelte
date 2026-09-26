<script lang="ts">
  // HomeWidgets.svelte — the home screen's widget stack, rendered from the user's list.
  //
  // Before this, `HomeDock.svelte` drew a clock tile and a weather tile as **hard-coded
  // markup**: no way to add, remove or reorder. The list now comes from
  // `lib/homeWidgets` (store key `amos.home.widgets`, edited in the Edit-Home screen) and
  // this component turns it into rows: `small` widgets pair two per row (so the default
  // `["clock", "weather"]` is the same one-row, clock-stretched header the screen has
  // always drawn), `large` widgets own their row.
  //
  // Two tiles read live host state (battery, calendar) and therefore live in their own
  // child components: a `{#if}` around a child means the reading is only *subscribed* while
  // the widget is actually placed. Creating those sources here would poll the host battery
  // every 5 s on a home screen with no battery widget — the same "a capability nothing
  // consumes" shape this repo keeps removing.
  //
  // The clock's 1 Hz tick is gated the same way: it runs only while a clock widget is on
  // the home screen (it used to run unconditionally).
  import { t, locale } from "./locale.svelte";
  import { fmtClock } from "../lib/time";
  import { forecast } from "../lib/weather";
  import { widgetAppId, widgetRows, type WidgetKind } from "../lib/homeWidgets";
  import WidgetBattery from "./widgets/WidgetBattery.svelte";
  import WidgetCalendar from "./widgets/WidgetCalendar.svelte";

  let {
    kinds,
    onopen,
  }: {
    /** The placed widgets, in order (already decoded by `lib/homeWidgets`). */
    kinds: WidgetKind[];
    /** Open the app a widget taps through to. */
    onopen: (id: string) => void;
  } = $props();

  const rows = $derived(widgetRows(kinds));
  const has = (kind: WidgetKind): boolean => kinds.includes(kind);

  // Live clock — only while the clock widget is placed. `now` starts at mount so a host
  // with no clock widget still renders the date-less tiles it has.
  let now = $state(new Date());
  $effect(() => {
    if (!has("clock")) return;
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
  const today = $derived(forecast()[0]);
  const dateStr = $derived(
    new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(now),
  );

  /** The tile chrome shared by every widget body (glass card, same as the header it
   *  replaced). Kept as one constant so a new widget cannot get a different surface. */
  const CARD =
    "flex flex-col justify-center rounded-3xl bg-white/40 p-4 text-left shadow-sm ring-1 ring-black/5 backdrop-blur-md transition active:scale-95 dark:bg-white/10 dark:ring-white/10";
</script>

{#if rows.length > 0}
  <div
    data-testid="home-widgets"
    role="group"
    aria-label={t("widget.title")}
    class="flex flex-col gap-3"
  >
    {#each rows as row, i (i)}
      <!-- `small` pairs keep the historical `[1fr_auto]` template (first tile stretches,
           second hugs its content) so the default clock+weather row is byte-identical.
           Literal class strings, not interpolated ones: Tailwind purges what it cannot see. -->
      <div
        class={row.length === 2 ? "grid grid-cols-[1fr_auto] gap-3" : "grid grid-cols-1 gap-3"}
        data-row={row.length}
      >
        {#each row as kind (kind)}
          <!-- Every tap opens `widgetAppId(kind)` — the catalog's `appId`, the value
               `homeWidgets.test.ts` validates against `APP_META`. A literal here would be a
               second copy of the destination that the catalog test cannot see (REQ-A1562). -->
          {#if kind === "clock"}
            <button
              class={CARD}
              onclick={() => onopen(widgetAppId("clock"))}
              aria-label={`${t("a11y.currentTime")} · ${fmtClock(now)}`}
            >
              <div
                class="text-4xl font-medium leading-none tabular-nums text-neutral-900 dark:text-white"
                aria-hidden="true"
              >{fmtClock(now)}</div>
              <div
                class="mt-2 text-xs text-neutral-600/90 dark:text-neutral-300/90"
                aria-hidden="true"
              >{dateStr}</div>
            </button>
          {:else if kind === "weather"}
            {#if today}
              <button
                class="{CARD} items-center px-5"
                aria-label={`${t("app.weather")} · ${today.temp}°`}
                onclick={() => onopen(widgetAppId("weather"))}
              >
                <div class="text-2xl" aria-hidden="true">{today.icon}</div>
                <div
                  class="text-xl font-medium tabular-nums text-neutral-900 dark:text-white"
                  aria-hidden="true"
                >{today.temp}°</div>
                <div class="text-[10px] text-neutral-500 dark:text-neutral-300" aria-hidden="true"
                >{t("weather.today")}</div>
              </button>
            {/if}
          {:else if kind === "battery"}
            <WidgetBattery onopen={() => onopen(widgetAppId("battery"))} />
          {:else if kind === "calendar"}
            <WidgetCalendar onopen={() => onopen(widgetAppId("calendar"))} />
          {/if}
        {/each}
      </div>
    {/each}
  </div>
{/if}
