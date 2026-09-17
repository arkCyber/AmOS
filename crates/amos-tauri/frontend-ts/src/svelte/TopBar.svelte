<script lang="ts">
  // TopBar.svelte — the macOS-style top bar, as a **container**.
  //
  // The bar used to own its widgets *and their state*: five right-hand indicators with a
  // per-second ticker, a `amos.settings` subscription and `online` listeners, plus the
  // left group inline (Apple menu, the focused app's name and the five menu titles, with
  // its own store subscription). "Which widgets exist, in what order" lived in this
  // template, so every new indicator was an edit here and every widget's test had to
  // mount the whole bar.
  //
  // Round 2 (REQ-A262) finished the split: **both slots come from the registry**, and
  // the left group is three widgets now — including the store subscription, which moved
  // into the widget that renders it. What is left here is what a container is for: the
  // glass surface, the two slots, and nothing else.
  //
  // The widgets ask the *shell* for things through the chrome handle
  // (`SHELL_CHROME_API`), which `DesktopShell` provides once at its root. The bar no
  // longer takes `onlaunchpad`/`onspotlight` props: a container that had to forward
  // intents for widgets it does not own was the last piece of the old shape.
  //
  // Order on screen is unchanged (left: 🍎, app name, menus; right: Launchpad, Spotlight,
  // control centre, radios, clock, battery); this is a restructuring, not a redesign.
  import { t } from "./locale.svelte";
  import { modulesFor } from "../lib/shellModule";
  import { SHELL_MODULES } from "./shellModules";
  import { GLASS_TOPBAR_STYLE, GLASS_BORDER_SUBTLE } from "../lib/shellChrome";

  /** Both slots, in registry order (`lib/shellModule.ts` sorts them). */
  const leftModules = modulesFor("topbar-left", SHELL_MODULES);
  const rightModules = modulesFor("topbar-right", SHELL_MODULES);
</script>

<!--
  macOS 顶栏：
  - 高度 24px（macOS 标准，无刘海设备）
  - 毛玻璃背景（backdrop-filter: blur）
  - 字体：SF Pro（-apple-system fallback）
-->
<div
  aria-label={t("desktop.topbar")}
  class="relative flex h-6 w-full select-none items-center justify-between px-4"
  style="{GLASS_TOPBAR_STYLE} {GLASS_BORDER_SUBTLE} border-bottom: 1px solid rgba(255,255,255,0.08);"
>
  <!-- 左侧槽位：Apple 菜单 / 当前 app 名 / 主菜单（注册表里的三个挂件） -->
  <div class="flex items-center gap-4" data-testid="topbar-left-slot">
    {#each leftModules as mod (mod.id)}
      {@const Widget = mod.component}
      <Widget />
    {/each}
  </div>

  <!-- 右侧槽位：注册表里的挂件（顺序见 shellModules.ts；此处只是槽位） -->
  <div class="flex items-center gap-3" data-testid="topbar-right-slot">
    {#each rightModules as mod (mod.id)}
      {@const Widget = mod.component}
      <Widget />
    {/each}
  </div>
</div>
