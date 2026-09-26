/**
 * cellular-unanswered.svelte.test.ts — 「没有答案」不等于「没有调制解调器」。
 *
 * 缺陷形状（REQ-A1539 ∕ F-SH-780）：蜂窝这条缝上只有**两个**状态 ——
 * `{present:true}` 与 `{present:false}` —— 而「本机无 SIM / 调制解调器」这句话把
 * **两件不同的事**折成了同一个值：
 *
 *   • 宿主被问过，回答「本机没有调制解调器」（桌面 / 平板：Rust 答 `supported:false`）；
 *   • 宿主的回答**没拿到**（`invoke` 解析成 `null`：未桥接、命令抛错），我们**从没量过**。
 *
 * 于是从未问过宿主的页面上会印出一句**关于用户设备**的断言。同一份 store 值在通知
 * 中心那边是「不画」（诚实的沉默），在这两页却是「本机无 SIM」——同一个值两种读法，
 * 一种在陈述、一种在回避。
 *
 * 兄弟先例就在同一个 `NotificationCenter.svelte` 里、就在这次读取的上面几行：
 * `rotationAvailable` 是 `boolean | null`，`null` 有自己的那句话（`rotation.readFailed`），
 * 它的注释把这个形状说得再清楚不过 ——「折叠成一个布尔会让一次失败的读取印出
 * 「此宿主无法旋转」，一句没有任何东西建立过的、关于用户自己设备的断言」。
 * 蜂窝这条缝缺的正是这个第三态。
 *
 * 诚实边界：本文件**不**声称真机（Android）上会走到「未取得读数」——真机上
 * `cellular_signal` 是无条件注册的非 `Result` 命令，`null` 只可能是「拒绝回答」
 * （未桥接 / 命令不存在 / 抛错）。桌面也是一次**回答**（`supported:false`）。
 * 所以这里钉的是拒绝回答的那条路径，以及它现在的样子。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import CellularPage from "../src/svelte/settings/CellularPage.svelte";
import AboutPage from "../src/svelte/settings/AboutPage.svelte";
import NotificationCenter from "../src/svelte/NotificationCenter.svelte";
import { clearCellularRadio, setCellularRadio } from "../src/svelte/cellularRadio";
import { propsChannel, resetPropsChannels } from "../src/svelte/propsBus";
import { zh } from "../src/i18n/locales/zh";

const settle = () => new Promise((r) => setTimeout(r, 40));
const byTest = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);
const text = (c: HTMLElement, id: string) => byTest(c, id)?.textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
  resetPropsChannels();
  // 未回答：store 回到「没量过」那一态。
  clearCellularRadio();
});

afterEach(() => {
  cleanup();
  resetPropsChannels();
  clearCellularRadio();
});

async function renderNcOpen(container: HTMLElement | undefined = undefined) {
  propsChannel<{ open: boolean }>("nc").set({ open: true });
  const { container: c } = render(NotificationCenter);
  await tick();
  return c;
}

describe("蜂窝 · 未取得读数时不许陈说设备 (REQ-A1539 ∕ F-SH-780)", () => {
  test("「蜂窝网络」页：宿主没答过 → 说「未知」，不说「本机无 SIM」", async () => {
    // 负控：修复前这里印的是 `settings.cellularNone` —— 一句关于用户设备的断言，
    // 而这条路径上**任何东西都没问过宿主**。
    const { container } = render(CellularPage);
    await tick();
    const status = text(container, "cellular-status");
    expect(status).not.toContain(zh["settings.cellularNone"]);
    expect(status).toContain(zh["settings.cellularUnknown"]);
  });

  test("「关于本机」页：同一件事，同一句话", async () => {
    const { container } = render(AboutPage);
    await tick();
    await settle();
    const cell = text(container, "about-cellular");
    expect(cell).not.toContain(zh["settings.cellularNone"]);
    expect(cell).toContain(zh["settings.cellularUnknown"]);
  });

  test("通知中心：未取得读数 → 这一格不出现（原本的诚实沉默保持不变）", async () => {
    const c = await renderNcOpen();
    expect(byTest(c, "nc-cellular")).toBeNull();
  });

  test("正控：宿主**答过**「本机无调制解调器」时，「无 SIM」这句话必须还在", async () => {
    // 这一条是这次修复的另一半：不能靠**删掉**那句话来变诚实。真机（桌面 / 平板）
    // 答 `supported:false`，`radioSignalFrom` 把它收窄成 `{present:false, signal:null}`
    // —— 一个**有来源**的答案 —— 页面照旧说「未接入蜂窝网络」。
    setCellularRadio({ present: false, signal: null });
    const { container } = render(CellularPage);
    await tick();
    expect(text(container, "cellular-status")).toContain(zh["settings.cellularNone"]);
  });

  test("正控：答过且真有 radio → 照旧按数据位/信号说状态", async () => {
    setCellularRadio({ present: true, signal: 3 });
    const { container } = render(CellularPage);
    await tick();
    expect(text(container, "cellular-status")).toContain(zh["settings.cellularConnected"]);
  });
});
