/**
 * radio-control-stale-reply.svelte.test.ts — 离开那一页之后才落地的 `radio_control` 答复，
 * 仍然被当成**屏幕上这一台无线电**的答复（REQ-A1216 / FMEA F-SH-502）。
 *
 * REQ-A1211 这一轮修的是「一次实例只问一次」：`RadioPage` 把读取闩在组件实例上（`ctlRead`），
 * 而 `SettingsApp` 用一个 `{#if page === "wifi" || page === "bluetooth"}` 分支渲染两种无线电，
 * 切页**不重挂**——于是蓝牙那一页顶着 Wi‑Fi 的答复，把 app 本来能拨的开关说成「平台所有」。
 * 修法是把 `which` 在 await **之前**捕获（`const key = which; ctl = …radioControl(key)…`），
 * 并在重跑时先清掉上一条答案。
 *
 * 但**捕获了问谁、没有检查答的是不是还是那一台**：`ctl = (await radioControl(key)) ?? null;`
 * 落地时无门。切页时前一次调用仍在路上，它比新的一次**晚**回来（宿主往返的真实延迟），就把
 * `ctl` 写回**离开的那一台**的答复——而 `radioManagedState(ctl, which)` 只读
 * `reply.app_controlled`、从不比对 `reply.radio`，`noteKey` 还取**当前**的 `which`：
 *
 *   - 蓝牙页上出现 `radio.managed.bluetooth`（说平台拥有蓝牙），
 *   - 而 `surface` 是 Wi‑Fi 答复里的 `"wifi_panel"`（点下去打开的是 Wi‑Fi 面板），
 *   - 开关被 `disabled={qs.airplane || ctlState.managed}` 灰掉。
 *
 * 这正是本轮声称修掉的那句话，只是换成了竞态这条路进来。**为什么全绿**：现有的 REQ-A1211
 * 用例里桥是「每次都立刻 resolve」的，先答的一方永远先到；没有一条把答复**悬在半空**再切页。
 * 孪生纪律在同一棵树的邻页就有（`MessagesApp.svelte` 的 `smsFolderSnapshot` 落地前
 * `if (reqFolder !== folder) return;`）。可达性：切页只是一次点击，而 `radio_control` 是一次
 * 平台往返（Android 上要问 D‑Bus / API）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import RadioPage from "../src/svelte/settings/RadioPage.svelte";
import type { QuickSettings } from "../src/lib/settings";
import { zh } from "../src/i18n/locales/zh";
import { controlByName } from "./a11y-name";

const qs = (over: Partial<QuickSettings> = {}): QuickSettings => ({
  wifi: true,
  bluetooth: true,
  airplane: false,
  dnd: false,
  sound: true,
  haptics: true,
  brightness: 1,
  ...over,
});

/** 无线局域网那一台：平台所有（`app_controlled: false`），可打开的界面是 Wi‑Fi 面板。 */
const WIFI_REPLY = {
  radio: "wifi",
  app_controlled: false,
  surface: "wifi_panel",
  reason: "switch_removed",
};
/** 蓝牙那一台：app 自己的开关。两份答复**互斥**，所以哪一份落地都能从屏幕上认出来。 */
const BT_REPLY = { radio: "bluetooth", app_controlled: true, surface: null, reason: null };

/**
 * 一个把 Wi‑Fi 那次 `radio_control` 扣住不放的宿主：`releaseWifi()` 之前它不 resolve。
 * 蓝牙那一次立刻回答——这正是「先问、后切、旧答晚到」的排布。
 */
function installSlowWifiHost() {
  let releaseWifi: (() => void) | null = null;
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "radio_control") return null;
      if (args?.key === "wifi") {
        await new Promise<void>((r) => {
          releaseWifi = r;
        });
        return WIFI_REPLY;
      }
      return BT_REPLY;
    },
    listen: async () => () => {},
  };
  return { release: () => releaseWifi?.() };
}

const settle = async () => {
  await tick();
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const switchByLabel = (h: { container: HTMLElement }, aria: string) =>
  controlByName<HTMLButtonElement>(h.container, '[role="switch"]', aria);

const managedNote = (h: { container: HTMLElement }) =>
  h.container.querySelector('[data-testid="radio-managed-note"]');

beforeEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("REQ-A1216: 离开那一页之后落地的 radio_control 答复不得描述现在这一台", () => {
  test("Wi‑Fi 的答复在切到蓝牙之后才落地 ⇒ 蓝牙页不得顶着它的 managed 判决", async () => {
    const host = installSlowWifiHost();
    const app = render(RadioPage, { props: { which: "wifi", qs: qs(), onToggle: () => {} } });
    await settle();

    // 用户切到蓝牙：同一个实例按新的 key 再问一次，蓝牙立刻回答（它是 app 自己的开关）。
    await app.rerender({ which: "bluetooth" });
    await settle();
    expect(managedNote(app)).toBeNull();

    // Wi‑Fi 那一次现在才回来 —— 它说的是**上一台**。
    host.release();
    await settle();

    // 修前：蓝牙页出现 `radio.managed.bluetooth`，开关被灰掉，而且那颗「打开设置」指向 Wi‑Fi 面板。
    expect(managedNote(app)).toBeNull();
    const sw = switchByLabel(app, zh["settings.bluetooth"]);
    expect(sw?.disabled).toBe(false);
  });

  test("答复落在它自己那一台还在屏幕上时，照旧生效（反向控制）", async () => {
    const host = installSlowWifiHost();
    const app = render(RadioPage, { props: { which: "wifi", qs: qs(), onToggle: () => {} } });
    await settle();

    host.release();
    await settle();

    // 没人切页：Wi‑Fi 的 managed 判决必须照常画出来（这条守卫的是「不要为了防迟到把合法答复
    // 一起丢掉」）。
    expect(managedNote(app)?.textContent ?? "").toContain(zh["radio.managed.wifi"]);
    expect((switchByLabel(app, zh["settings.wifi"]) as HTMLButtonElement).disabled).toBe(true);
  });
});
