/**
 * AirPlayPanel.svelte — **the refusal has to reach the user** (REQ-A467).
 *
 * The host refuses operations it has no implementation for (`not_implemented`) and reports the
 * platform's own failures (`failed` / `device_not_found` / `permission_denied`). The panel used to
 * log those to the console and render nothing at all, so tapping a device looked like a no-op; and
 * because the backend also *faked* success, it used to draw "已连接" for a receiver nothing had
 * contacted. These tests pin the visible sentence (read out of the dictionaries, so the assertion
 * does not freeze the language) and that a refused discovery does not leave the spinner pinned.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import AirPlayPanel from "../src/svelte/AirPlayPanel.svelte";
import * as airplay from "../src/lib/airplay";
import { zh } from "../src/i18n/locales/zh";
import { en } from "../src/i18n/locales/en";

vi.mock("../src/lib/airplay");

/** The sentence the user should read, in whichever locale the panel is running (zh by default). */
const controlUnavailable = new Set([
  zh["airplay.controlUnavailable"],
  en["airplay.controlUnavailable"],
]);
const failed = new Set([zh["airplay.failed"], en["airplay.failed"]]);

const device: airplay.AirPlayDevice = {
  id: "demo-appletv",
  name: "Living Room Apple TV",
  kind: "appletv",
  supports_video: true,
  supports_audio: true,
  supports_mirroring: true,
  signal_strength: 85,
  connected: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(airplay.isAirPlayAvailable).mockResolvedValue(true);
  vi.mocked(airplay.getDevices).mockResolvedValue([device]);
  vi.mocked(airplay.getStatus).mockResolvedValue({
    active: false,
    device: null,
    stream_kind: null,
    playing: false,
    volume: 0.7,
  });
  vi.mocked(airplay.discoverDevices).mockResolvedValue({ kind: "ok" });
  vi.mocked(airplay.disconnect).mockResolvedValue({ kind: "ok" });
  vi.mocked(airplay.stopDiscovery).mockResolvedValue(undefined);
});

describe("AirPlayPanel.svelte", () => {
  test("a refused connect is shown to the user, and nothing is drawn as connected", async () => {
    vi.mocked(airplay.connect).mockResolvedValue({
      kind: "not_implemented",
      reason: "AirPlay receiver control is not implemented",
    });

    render(AirPlayPanel);
    const name = await screen.findByText("Living Room Apple TV");
    const tile = name.closest("button");
    expect(tile).toBeTruthy();
    await fireEvent.click(tile as HTMLButtonElement);

    const banner = await screen.findByTestId("airplay-error");
    await waitFor(() =>
      expect(controlUnavailable.has(banner.textContent?.trim() ?? "")).toBe(true),
    );
    // The old pair (fake-success backend + console-only panel) rendered “已连接” here.
    expect(screen.queryByText(zh["airplay.connected"])).toBeNull();
    expect(screen.queryByText(en["airplay.connected"])).toBeNull();
  });

  test("a refused discovery explains itself and does not pin the searching spinner", async () => {
    vi.mocked(airplay.discoverDevices).mockResolvedValue({
      kind: "failed",
      reason: "AVRouteDetector requires main thread",
    });
    vi.mocked(airplay.getDevices).mockResolvedValue([]);

    render(AirPlayPanel);
    const banner = await screen.findByTestId("airplay-error");
    await waitFor(() => expect(failed.has(banner.textContent?.trim() ?? "")).toBe(true));

    expect(screen.queryByText(zh["airplay.searching"])).toBeNull();
    expect(screen.queryByText(en["airplay.searching"])).toBeNull();
  });

  test("卸载时必须把宿主的发现停掉——守卫不许读 `discovering`（REQ-A845）", async () => {
    // REQ-A845 / F-SH-272: `discovering` 的意思是「这一次性请求还在飞」——回复一到就被清掉
    // （上面那条 467 的修复正是为此），所以卸载时它**一定是 false**，`onDestroy` 里
    // `if (discovering) stopDiscovery()` 里的那句从未执行过：宿主那边的平台发现对象
    // （macOS/iOS 是 AVRouteDetector/NetServiceBrowser）面板关了还在跑。
    //
    // 判据只能从外部看：卸载之后，宿主要收到那条命令。
    const view = render(AirPlayPanel);
    await screen.findByText("Living Room Apple TV");
    await waitFor(() => expect(airplay.discoverDevices).toHaveBeenCalled());
    expect(airplay.stopDiscovery).not.toHaveBeenCalled();

    view.unmount();
    expect(airplay.stopDiscovery).toHaveBeenCalledTimes(1);
  });

  test("后端答不可用 ⇒ 从没让宿主发现过，卸载也就不发这条命令（REQ-A845）", async () => {
    // 同一条守卫的另一侧：没发过 `airplay_discover` 就不该发 `airplay_stop_discovery`。
    // 没有这条，"卸载总是发 stop"这种把守卫写死的实现也会绿。
    vi.mocked(airplay.isAirPlayAvailable).mockResolvedValue(false);
    const view = render(AirPlayPanel);
    await waitFor(() => expect(airplay.isAirPlayAvailable).toHaveBeenCalled());
    expect(airplay.discoverDevices).not.toHaveBeenCalled();

    view.unmount();
    expect(airplay.stopDiscovery).not.toHaveBeenCalled();
  });
});

/**
 * 「宿主没作答」不是「此平台不支持 AirPlay」（REQ-A1336 / F-SH-602）。
 *
 * `invoke` 从不 reject，被拒 ∕ 无回包一律答 `null`；而 `isAirPlayAvailable()` 曾把它
 * `?? false` 掉，于是 `available === false` 这条早退分支既把「我没问到」画成了对**平台
 * 能力**的断言（`airplay.unavailable`），又让整个面板在这一整个会话里没有重试。同一个折叠
 * 在 `getDevices()` 上是 `?? []`：「列表读不出来」被画成「未找到 AirPlay 设备」。
 */
describe("AirPlayPanel.svelte — 宿主没作答（REQ-A1336 / F-SH-602）", () => {
  const unanswered = new Set([zh["airplay.unavailableUnanswered"], en["airplay.unavailableUnanswered"]]);
  const devicesUnanswered = new Set([zh["airplay.devicesUnanswered"], en["airplay.devicesUnanswered"]]);
  const unsupported = new Set([zh["airplay.unavailable"], en["airplay.unavailable"]]);

  const bodyText = (view: { container: HTMLElement }) => view.container.textContent ?? "";

  test("宿主可达但没作答 ⇒ 说「宿主未作答」并给重试，绝不说「此平台不支持 AirPlay」", async () => {
    vi.mocked(airplay.isAirPlayAvailable).mockResolvedValue(null);

    const view = render(AirPlayPanel);
    await waitFor(() => expect(airplay.isAirPlayAvailable).toHaveBeenCalled());

    await waitFor(() =>
      expect([...unanswered].some((s) => bodyText(view).includes(s))).toBe(true),
    );
    // 设备能力那句是**断言**，从没人回答过的问题里推不出来。
    expect([...unsupported].some((s) => bodyText(view).includes(s))).toBe(false);
    // 没有可重试的入口 = 这一整个会话都被判死。
    expect(screen.getByText(zh["airplay.retry"])).toBeTruthy();
    // 没问出"有 AirPlay"，就不该去让宿主发现设备。
    expect(airplay.discoverDevices).not.toHaveBeenCalled();
  });

  test("「宿主未作答」上点重试会再问一次，答了就照常渲染", async () => {
    vi.mocked(airplay.isAirPlayAvailable).mockResolvedValueOnce(null).mockResolvedValueOnce(true);

    const view = render(AirPlayPanel);
    await waitFor(() =>
      expect([...unanswered].some((s) => bodyText(view).includes(s))).toBe(true),
    );

    await fireEvent.click(screen.getByText(zh["airplay.retry"]));

    expect(await screen.findByText("Living Room Apple TV")).toBeTruthy();
    expect(airplay.isAirPlayAvailable).toHaveBeenCalledTimes(2);
  });

  test("设备列表读不出来 ⇒ 说「无法读取设备列表」，不画「未找到 AirPlay 设备」", async () => {
    vi.mocked(airplay.getDevices).mockResolvedValue(null);

    const view = render(AirPlayPanel);
    await waitFor(() => expect(airplay.getDevices).toHaveBeenCalled());

    await waitFor(() =>
      expect([...devicesUnanswered].some((s) => bodyText(view).includes(s))).toBe(true),
    );
    // 「未找到 AirPlay 设备」是宿主**答了**且列表为空时的那句话。
    expect(bodyText(view)).not.toContain(zh["airplay.noDevices"]);
    expect(bodyText(view)).not.toContain(en["airplay.noDevices"]);
  });

  test("被拒的动作（宿主没答）⇒ 说「宿主未作答」，不是「操作失败」", async () => {
    vi.mocked(airplay.connect).mockResolvedValue(null);

    render(AirPlayPanel);
    const name = await screen.findByText("Living Room Apple TV");
    await fireEvent.click(name.closest("button") as HTMLButtonElement);

    const banner = await screen.findByTestId("airplay-error");
    await waitFor(() =>
      expect(banner.textContent?.trim()).toBe(zh["airplay.actionUnanswered"]),
    );
    expect(banner.textContent?.trim()).not.toBe(zh["airplay.failed"]);
    // 没答成"已连接"，就不许画成已连接。
    expect(screen.queryByText(zh["airplay.connected"])).toBeNull();
  });
});

/**
 * REQ-A1336 的**第三个兄弟**：`getStatus()` 也是 `AirPlayStatus | null`，`null` 同样是
 * 「宿主没作答」。前两个（`isAirPlayAvailable` ∕ `getDevices`）都改了，只有 `status` 漏了
 * ——面板用 `status?.active` 把「我问不到状态」画成「没有在投屏」，于是连**正在投的**
 * 会话和设备卡（连同断开、音量）一起消失，屏幕上没有任何一句话说这是没问到。
 */
describe("AirPlayPanel.svelte — 投屏状态读不出来（REQ-A1497 / F-SH-737）", () => {
  const statusUnanswered = new Set([
    zh["airplay.streamStatusUnanswered"],
    en["airplay.streamStatusUnanswered"],
  ]);
  const bodyText = (view: { container: HTMLElement }) => view.container.textContent ?? "";
  const activeStatus: airplay.AirPlayStatus = {
    active: true,
    device: { ...device, connected: true },
    stream_kind: "audio",
    playing: true,
    volume: 0.5,
  };

  test("状态读不出来 ⇒ 说「投屏状态未作答」，不画成「没有在投屏」", async () => {
    vi.mocked(airplay.getStatus).mockResolvedValue(null);

    const view = render(AirPlayPanel);
    // 设备列表好好的：被拒的是 status 这一次读，不是整个宿主。
    expect(await screen.findByText("Living Room Apple TV")).toBeTruthy();

    await waitFor(() =>
      expect([...statusUnanswered].some((s) => bodyText(view).includes(s))).toBe(true),
    );
    // 修前这里一个字都没有：静默的"没有在投屏"。
    expect(screen.getByTestId("airplay-status-unanswered")).toBeTruthy();
  });

  test("宿主答了「没在投屏」⇒ 没有那句未作答（那句话专属「没问到」）", async () => {
    // 反向臂：一个「不问就always画」的实现靠这条判死。
    vi.mocked(airplay.getStatus).mockResolvedValue({
      active: false,
      device: null,
      stream_kind: null,
      playing: false,
      volume: 0.7,
    });

    const view = render(AirPlayPanel);
    await waitFor(() => expect(airplay.getStatus).toHaveBeenCalled());
    await waitFor(() => expect(airplay.getDevices).toHaveBeenCalled());

    expect(screen.queryByTestId("airplay-status-unanswered")).toBeNull();
    expect(bodyText(view)).not.toContain(zh["airplay.streamStatusUnanswered"]);
    expect(bodyText(view)).not.toContain(en["airplay.streamStatusUnanswered"]);
  });

  test("这一读被拒、下一次答了 ⇒ 那句话自己消失，投屏卡片照常画出来", async () => {
    vi.mocked(airplay.getStatus)
      .mockResolvedValueOnce(null) // probe() 的第一次读
      .mockResolvedValue(activeStatus); // 点连接后的读
    vi.mocked(airplay.connect).mockResolvedValue({ kind: "ok" });

    render(AirPlayPanel);
    await waitFor(() => expect(screen.getByTestId("airplay-status-unanswered")).toBeTruthy());

    const name = await screen.findByText("Living Room Apple TV");
    await fireEvent.click(name.closest("button") as HTMLButtonElement);

    await waitFor(() => expect(screen.queryByTestId("airplay-status-unanswered")).toBeNull());
    expect(await screen.findByText(zh["airplay.streaming"])).toBeTruthy();
  });
});
