<script lang="ts">
  /**
   * StageClock.svelte — the big clock in the stage's top-right corner.
   *
   * Moved out of `DesktopStage.svelte` **verbatim**: same markup, same position, same
   * one-second ticker. What changed is who owns the ticker — the stage used to re-render
   * its whole template (wallpaper, icon grid, context menu) once a second for a clock
   * that is nobody else's business. `DesktopStage` is now a container for the `stage`
   * slot and this is the one widget in it.
   *
   * The date string comes from `toLocaleDateString` with no explicit locale: it follows
   * the OS/browser locale, which is the macOS behaviour (the menu bar's clock is
   * localised by the system, not by the app).
   */
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });

  const dayLabel = $derived(
    now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  );
  const clockLabel = $derived(
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
  );
</script>

<div
  class="pointer-events-none absolute right-6 top-6 text-right"
  style="text-shadow: 0 2px 12px rgba(0,0,0,0.5);"
  data-testid="stage-clock"
>
  <div class="text-[64px] font-thin leading-none text-white" style="font-variant-numeric: tabular-nums;">
    {clockLabel}
  </div>
  <div class="mt-1 text-[14px] font-medium text-white/85">
    {dayLabel}
  </div>
</div>