/**
 * spaces-panel-stale-error.svelte.test.ts — 一次成功的切换必须撤掉上一次失败留下的横幅。
 *
 * 缺陷（对 HEAD 核实）：`SpacesPanel::applySwitch` 在宿主拒绝时写下 `error`（`spacesErrorLabel
 * ("spaces_switch")`），但**成功**那一支只更新 `currentIndex` 与 `warning`，从不撤掉 `error`。
 * 于是用户看到同一件事实的两种说法同时挂在屏幕上：卡片的蓝色高亮说"已经切过去了"，红色横幅说
 * "切换失败"。姊妹页 `MissionControl::onSwitchSpace` 对**同一个**宿主读数在成功支上写着
 * `switchError = null` —— 两个面，一件事，两种答案。
 *
 * 同目录既有的 "a clean re-apply says nothing" 用例无法发现它：那条用例从头到尾没让 `error`
 * 被设过，所以断言"没有错误横幅"是因为**从来没有**，而不是因为被撤掉 —— 一条恒真的断言。
 *
 * 本用例走真实入口：点卡片切一次（宿主拒绝 ⇒ 红横幅），再点一次（宿主接受 ⇒ 高亮移动），
 * 断言红横幅必须消失。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import SpacesPanel from "../src/svelte/SpacesPanel.svelte";
import * as backend from "../src/lib/backend";

vi.mock("../src/lib/backend");

const SPACES = [
  { id: "space-0", name: "桌面 1", windows: [] },
  { id: "space-1", name: "桌面 2", windows: [] },
];

const REFUSAL = "桌面索引超出范围"; // t("spaces.errorOutOfBounds"), from the diag code below

/** The first `spaces_switch` is refused; every later one is a clean switch. */
function mockBridgeRefuseThenAccept(): void {
  let switches = 0;
  vi.mocked(backend.invoke).mockImplementation((async (cmd: string) => {
    switch (cmd) {
      case "spaces_list":
        return SPACES;
      case "spaces_active":
        return 0;
      case "wm_windows":
        return { windows: [] };
      case "spaces_switch":
        switches += 1;
        return switches === 1 ? null : { index: 1, hide_failed: [], show_failed: [] };
      default:
        return null;
    }
  }) as never);

  vi.mocked(backend.bridgeDiag).mockImplementation((() => ({
    ok: false,
    kind: "command-failed",
    command: "spaces_switch",
    detail: { code: "amos.spaces.index_out_of_bounds" },
  })) as never);
}

const cards = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(".space-card"),
];

describe("SpacesPanel — a successful switch retracts the previous refusal", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  test("the refusal banner is gone once a later switch succeeds", async () => {
    mockBridgeRefuseThenAccept();
    const { container } = render(SpacesPanel);
    await waitFor(() => expect(cards(container)).toHaveLength(2));

    // First switch: the host refuses ⇒ the banner must appear.
    await fireEvent.click(cards(container)[1]!);
    await waitFor(() => expect(container.textContent).toContain(REFUSAL));

    // Second switch: the host accepts ⇒ the panel moved to desktop 2 …
    await fireEvent.click(cards(container)[1]!);
    await waitFor(() =>
      expect(container.querySelectorAll(".space-card")[1]!.className).toContain("border-blue-600"),
    );

    // … so the sentence about the *previous* refusal no longer holds and must be gone.
    expect(container.textContent).not.toContain(REFUSAL);
  });
});
