<!--
  StageRail.svelte — Stage Manager 的常驻轨道栏（桌面形态）。

  ## 它画在哪里

  它是 `DesktopShell` 舞台矩形（`lib/desktopLayout.ts::stageRect`）左侧的一条竖直条带，
  宽由壳推下来的 `railWidth`（= `LayoutSnapshot.rail_width`）。**它不被应用窗口盖住**这件事由几何给出，而不是 z 序：
  宿主把每个窗口的落点都内缩了 `rail_width`（`LayoutPolicy::stage_work_area`），所以轨道
  条带里永远没有应用窗口，启动器在该像素就是最上层窗口。取舍与代价见 `docs/stage-manager.md`。

  ## 视图是派生的

  "谁在轨道上"不是本组件维护的列表：`snap.parked` 是宿主从窗口模型里读回来的
  （`state == "Hidden"` 且 `kind == "App"`）。关掉一个停着的窗口时，模型自己移除它，
  轨道**跟着**少一块 —— 没有人需要通知轨道。

  ## 刷新

  窗口列表变了就重读一边（`wm-changed` 推送，REQ-A717）。轨道**占多宽**不在这里读：
  那是 `LayoutSnapshot::rail_width`，随 `layout-changed` 推下来、由壳作为 `railWidth`
  传进来 —— 同一个数字只有一份读数，轨道与桌面图标网格的内缩才不会各说各话。
  本组件自己的动作（停 / 带回 / 整理）直接用命令**返回**的快照，不额外再读一次。
-->
<script lang="ts">
  import { getContext, onMount } from "svelte";
  import {
    stageSnapshot,
    stagePark,
    stageBring,
    stageArrange,
    stageFailure,
    type StageSnapshot,
  } from "../lib/stage";
  import { onWmChanged, onLayoutChanged } from "../lib/wm";
  import { getStoreTiles, type StoreTile } from "../lib/storeApps";
  import { SHELL_CHROME_API, type ShellChromeApi } from "../lib/shellModule";
  import { amosWarn } from "../lib/debugLog";
  import { t, windowName } from "./locale.svelte";
  import type { StageRect } from "../lib/desktopLayout";

  /**
   * `stage` —— 舞台矩形，由壳传下来：轨道的 y / 高度与舞台**同源**，不是这里再算一遍。
   *
   * `railWidth` —— 轨道条带的宽度（px），壳从 `LayoutSnapshot.rail_width` 推下来。
   *
   * `0` = 没有轨道：模式关着，或这个类别没有轨道，或屏幕窄到放不下"轨道 + 最小窗格"
   * （`LayoutPolicy::stage_work_area` 的让位规则）。因此画不画的判据是
   * `snap.enabled && railWidth > 0` —— `enabled` 单独说明不了轨道存在。
   */
  let { stage, railWidth = 0 }: { stage: StageRect; railWidth?: number } = $props();

  // 窗口名对已安装的商店应用要查商店注册表（REQ-A1185），瓷砖表由壳推下来
  // （getter ⇒ 保持活）；单独渲染本组件时回退到模块缓存。与 `SpacesPanel` 同一条。
  const api = getContext<ShellChromeApi | undefined>(SHELL_CHROME_API);
  const ext = $derived<readonly StoreTile[]>(api?.storeTiles ?? getStoreTiles());

  let snap = $state<StageSnapshot | null>(null);
  /** 正在等待宿主的那个标签（或 `arrange` / `toggle`），用来禁用重复点击。 */
  let busy = $state<string | null>(null);
  /** 最近一次被拒的句子与它来自哪条命令 —— 唯一措辞规则在 `lib/stage.ts::stageFailure`。 */
  let failure = $state<{ key: string; hostMessage?: string; command: string } | null>(null);

  async function refresh(): Promise<void> {
    const next = await stageSnapshot();
    // `null` = 宿主拒绝回答（非桌面形态 / 桥断了）。保持上一次的读数不动，并把原因记下来 ——
    // 把界面切成"没有轨道"会让"读不到"与"关掉了"同形。
    if (next === null) {
      amosWarn("stage", "the host did not answer stage_snapshot", {
        reason: stageFailure("stage_snapshot").key,
      });
      return;
    }
    snap = next;
  }

  /**
   * 跑一条 stage 命令，成功就用它**返回的**快照更新界面。
   *
   * 拒绝时写一行具名的话（`stageFailure`），而不是让它变成"点了没反应" —— 那与"坏了"
   * 同形，是本仓各面反复修掉的形状。命令名单独留在 `failure.command` 上，读诊断台账时
   * 才知道是哪一条被拒（`bridgeDiag` 按命令名保留读数）。
   */
  async function run(command: string, action: () => Promise<StageSnapshot | null>): Promise<void> {
    busy = command;
    failure = null;
    const next = await action();
    busy = null;
    if (next === null) {
      const f = stageFailure(command);
      failure = { ...f, command };
      amosWarn("stage", t(f.key, f.hostMessage ? { message: f.hostMessage } : undefined), {
        command,
        reason: f.key,
      });
      return;
    }
    snap = next;
  }

  onMount(() => {
    void refresh();
    // 窗口列表（谁在台上 / 谁停着）与屏幕尺寸（轨道可能让位成 0）都会改变这个视图。
    //
    // 两条推送的订阅是**异步**成立的（`onWmChanged` 走一次宿主 `listen` 往返），所以本组件
    // 可能在订阅存在**之前**就卸载了 —— 此时若把返回的退订函数丢在地上，宿主会一直朝着一
    // 条没人看的轨道推送，每次推送又经 `refresh()` 再问一遍 `stage_snapshot`。规则与守卫在
    // `lib/wmWindowsPoll.ts::startPush` 里逐字写着（「会被丢在地上 … 守卫原样交还」）：晚到
    // 的退订要**立刻交还**，而不是存进一个 teardown 已经读过、再也不会读的变量（REQ-A1682）。
    let disposed = false;
    let stopWm: () => void = () => {};
    let stopLayout: () => void = () => {};
    void onWmChanged(() => void refresh()).then((f) => {
      if (f === null) return;
      if (disposed) f();
      else stopWm = f;
    });
    void onLayoutChanged(() => void refresh()).then((f) => {
      if (f === null) return;
      if (disposed) f();
      else stopLayout = f;
    });
    return () => {
      disposed = true;
      stopWm();
      stopLayout();
    };
  });
</script>

{#if snap !== null && snap.enabled && railWidth > 0}
  <div
    class="absolute overflow-y-auto border-r border-black/10 bg-black/20 backdrop-blur-sm dark:border-white/10"
    style="left:{stage.x}px; top:{stage.y}px; width:{railWidth}px; height:{stage.height}px;"
    data-testid="stage-rail"
    data-rail-width={railWidth}
  >
    <div class="flex items-center justify-between gap-2 px-3 py-2">
      <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">
        {t("stage.title")}
      </span>
      <button
        type="button"
        class="rounded px-2 py-0.5 text-xs text-neutral-700 disabled:opacity-40 dark:text-neutral-300"
        disabled={busy !== null || snap.on_stage.length === 0}
        title={snap.on_stage.length === 0 ? t("stage.tidyEmpty") : t("stage.tidy")}
        onclick={() => void run("stage_arrange", stageArrange)}
        data-testid="stage-tidy"
      >
        {t("stage.tidy")}
      </button>
    </div>

    {#if failure}
      <p
        class="px-3 pb-2 text-xs text-red-600 dark:text-red-400"
        data-testid="stage-error"
        data-command={failure.command}
      >
        {t(failure.key, failure.hostMessage ? { message: failure.hostMessage } : undefined)}
      </p>
    {/if}

    {#if snap.parked.length > 0}
      <div class="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide text-neutral-500">
        {t("stage.parked")}
      </div>
      <ul class="space-y-1 px-2 pb-2">
        {#each snap.parked as w (w.label)}
          {@const shown = windowName(w.label, w.app, ext).text}
          <li>
            <button
              type="button"
              class="w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-800 hover:bg-black/10 disabled:opacity-50 dark:text-neutral-200 dark:hover:bg-white/10"
              disabled={busy !== null}
              aria-label={t("stage.bringWindow", { label: shown })}
              onclick={() => void run("stage_bring", () => stageBring(w.label))}
              data-testid="stage-tile"
              data-label={w.label}
            >
              {shown}
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if snap.on_stage.length > 0}
      <div class="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide text-neutral-500">
        {t("stage.onStage")}
      </div>
      <ul class="space-y-1 px-2 pb-2">
        {#each snap.on_stage as w (w.label)}
          {@const shown = windowName(w.label, w.app, ext).text}
          <li>
            <button
              type="button"
              class="w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-700 hover:bg-black/10 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-white/10"
              disabled={busy !== null}
              aria-label={t("stage.parkWindow", { label: shown })}
              onclick={() => void run("stage_park", () => stagePark(w.label))}
              data-testid="stage-stage-tile"
              data-label={w.label}
            >
              {shown}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
