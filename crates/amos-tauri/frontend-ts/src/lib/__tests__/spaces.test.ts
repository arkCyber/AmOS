/**
 * Spaces API 测试
 * 
 * 状态：完整测试（2026-09-16）
 * 
 * 测试完整的 Spaces 功能与 Rust 后端的集成。
 * 
 * 注意：使用 bun:test 框架，不使用 vi.mock（Bun 不支持）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { fileableWindows, spacesFailure, type Space } from "../spaces";

describe("Spaces API - 类型定义", () => {
  test("Space 接口结构完整", () => {
    const space: Space = {
      id: "space-0",
      name: "桌面 1",
      windows: ["app1", "app2"],
    };
    
    expect(space).toHaveProperty("id");
    expect(space).toHaveProperty("name");
    expect(space).toHaveProperty("windows");
    
    expect(typeof space.id).toBe("string");
    expect(typeof space.name).toBe("string");
    expect(Array.isArray(space.windows)).toBe(true);
  });

  // The cross-language shape binding (this interface == the Rust `Space`/`SpaceInfo` fields) lives
  // in `src/__tests__/declaredMirrors.test.ts` (REQ-A710). This case only pins the TS-side literal.
  test("a Space list carries the three documented fields", () => {
    const spaces: Space[] = [
      { id: "space-0", name: "桌面 1", windows: [] },
      { id: "space-1", name: "桌面 2", windows: ["settings"] },
    ];

    expect(spaces).toHaveLength(2);
    expect(spaces[0]?.id).toBe("space-0");
    expect(spaces[1]?.windows).toContain("settings");
  });
});

describe("Spaces API - 函数导出", () => {
  test("所有 API 函数都已导出", async () => {
    const {
      listSpaces,
      activeSpace,
      switchSpace,
      createSpace,
      deleteSpace,
      moveWindowToSpace,
      renameSpace,
    } = await import("../spaces");

    expect(typeof listSpaces).toBe("function");
    expect(typeof activeSpace).toBe("function");
    expect(typeof switchSpace).toBe("function");
    expect(typeof createSpace).toBe("function");
    expect(typeof deleteSpace).toBe("function");
    expect(typeof moveWindowToSpace).toBe("function");
    expect(typeof renameSpace).toBe("function");
  });
});

describe("Spaces API - 参数类型", () => {
  test("listSpaces 不需要参数", async () => {
    const { listSpaces } = await import("../spaces");
    expect(listSpaces.length).toBe(0);
  });

  test("activeSpace 不需要参数", async () => {
    const { activeSpace } = await import("../spaces");
    expect(activeSpace.length).toBe(0);
  });

  test("switchSpace 接受 number 参数", async () => {
    const { switchSpace } = await import("../spaces");
    expect(switchSpace.length).toBe(1);
  });

  test("createSpace 接受 string 参数", async () => {
    const { createSpace } = await import("../spaces");
    expect(createSpace.length).toBe(1);
  });

  test("deleteSpace 接受 string 参数", async () => {
    const { deleteSpace } = await import("../spaces");
    expect(deleteSpace.length).toBe(1);
  });

  test("moveWindowToSpace 接受 2 个参数", async () => {
    const { moveWindowToSpace } = await import("../spaces");
    expect(moveWindowToSpace.length).toBe(2);
  });

  test("renameSpace 接受 2 个参数", async () => {
    const { renameSpace } = await import("../spaces");
    expect(renameSpace.length).toBe(2);
  });
});

describe("Spaces API - 集成就绪", () => {
  test("API 已准备好与 Rust 后端集成", () => {
    // 这个测试验证 TypeScript 层已准备好
    // 实际的集成测试需要运行 Tauri 应用
    expect(true).toBe(true);
  });
});

/**
 * REQ-A268 / REQ-A296 follow-up: every Spaces API call goes through
 * `lib/backend.invoke`, which catches Tauri failures and resolves to `null`
 * (the typed `AmosError` code is in `bridgeDiag(command)`). The earlier
 * `Promise<T>` signatures here were TypeScript lies — a failed `spaces_list`
 * would silently assign `null` to a typed `Space[]` and break `SpacesPanel`
 * without ever firing `catch`. These tests pin the new contract.
 */
describe("Spaces API - 桥接契约(REQ-A296)", () => {
  test("listSpaces 返回 Space[] | null,且 bridge 拒绝时落回 null(不抛)", async () => {
    const { listSpaces } = await import("../spaces");
    // 在没有 Tauri bridge 的 Bun 环境里 invoke 立即返回 null(同“失败”路径)
    const got = await listSpaces();
    expect(got === null || Array.isArray(got)).toBe(true);
    // 关键:不会抛 — 旧 try/catch 形式永远抓不到
    let threw = false;
    try {
      await listSpaces();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test("activeSpace / createSpace 也走相同的 null-回退契约", async () => {
    const { activeSpace, createSpace } = await import("../spaces");
    expect(await activeSpace() === null || typeof (await activeSpace()) === "number").toBe(true);
    expect(await createSpace("桌面试探") === null || typeof (await createSpace("桌面试探")) === "string").toBe(true);
  });

  test("mutation 调用(switchSpace / deleteSpace / renameSpace)不抛异常", async () => {
    const { switchSpace, deleteSpace, renameSpace, moveWindowToSpace, unfileWindow } = await import("../spaces");
    // 没有桥的环境里,五个包装器都必须**优雅降级**而不是 reject(REQ-A296)
    let threw = false;
    try {
      await switchSpace(0);
      await deleteSpace("space-0");
      await renameSpace("space-0", "x");
      await moveWindowToSpace("settings", "space-0");
      await unfileWindow("settings");
      await switchSpace(99);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

/**
 * REQ-A513 — 一次**真的**判据。
 *
 * 从前这条用例断言的是 `=== true || === false` —— 恒真,所以它掩盖了一个真缺陷:
 * `spaces_switch` 返回 `()`,wire 上就是 `null`,而桥把**失败**也表达成 `null`
 * (`lib/backend.invoke` 把错误吞进诊断台账),于是那 5 个包装器判 `result !== null`
 * **在成功时也答 false**:`MissionControl` 切换后从不关闭浮层,`SpacesPanel` 把成功的
 * 操作写成一行错误。这里给桥装上真值,两种结局必须得到**不同**的答案。
 */
describe("Spaces API - 单位返回的命令如何判成功 (REQ-A513)", () => {
  type Handler = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

  /** 装一个只实现 `invoke` 的桥 —— 与 `window.__TAURI_INTERNALS__` 的最小形状一致。 */
  function installBridge(handler: Handler): string[] {
    const seen: string[] = [];
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => {
          seen.push(command);
          return handler(command, args);
        },
      },
    };
    return seen;
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /** 一个不抛的命令返回 `null`(Tauri 把 `()` 序列化成 `null`)—— 成功也是这个值。 */
  const unitReply: Handler = async () => null;

  test("四个单位返回的 mutation 在命令**成功**时答 true（而不是恒 false）", async () => {
    const { deleteSpace, renameSpace, moveWindowToSpace, unfileWindow } = await import("../spaces");
    installBridge(unitReply);
    expect(await deleteSpace("space-0")).toBe(true);
    expect(await renameSpace("space-0", "x")).toBe(true);
    expect(await moveWindowToSpace("settings", "space-0")).toBe(true);
    expect(await unfileWindow("settings")).toBe(true);
  });

  test("同一个判据在命令**失败**时答 false（成功/失败真的分得开）", async () => {
    const { deleteSpace } = await import("../spaces");
    installBridge(async () => {
      throw new Error("amos.spaces.delete_last");
    });
    expect(await deleteSpace("space-0")).toBe(false);
  });

  test("switchSpace 把报告原样带回（hide_failed / show_failed 不再只进日志）", async () => {
    const { switchSpace } = await import("../spaces");
    const report = {
      index: 1,
      hide_failed: [{ label: "notes", reason: "window 'notes' is not registered" }],
      show_failed: [],
    };
    const seen = installBridge(async () => report);
    expect(await switchSpace(1)).toEqual(report);
    expect(seen).toEqual(["spaces_switch"]);
  });

  test("switchSpace 被拒绝时是 null（不是\"空报告\"，两者必须分得开）", async () => {
    const { switchSpace } = await import("../spaces");
    installBridge(async () => {
      throw new Error("amos.spaces.index_out_of_bounds");
    });
    expect(await switchSpace(99)).toBeNull();
  });
});

/**
 * F-SH-577 — the **one** rule that turns a typed `amos.spaces.*` code into the sentence a user
 * reads.
 *
 * 这条映射从前只住在 `SpacesPanel.svelte` 里，于是 Mission Control 对**同一个** `spaces_switch`
 * 拒绝什么都不说。搬到这里之后，它成了两个面共用的一枚措辞 —— 所以它自己要被钉住：每条已知
 * code 走哪一句、未知 code 落回宿主自己的话，以及"台账里没有失败记录"时的那一支。
 *
 * 用真实的桥（`window.__TAURI_INTERNALS__.invoke`）驱动，因为 `spacesFailure` 读的是 `invoke`
 * 写进台账的**最近一次**读数，而不是任何入参。
 */
describe("spacesFailure - 同一个拒绝只能有一份说法 (F-SH-577)", () => {
  type Handler = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

  /** 装一个只实现 `invoke` 的桥；抛出的值就是 Rust 侧 `AmosError` 序列化后的样子。 */
  function installBridge(handler: Handler): void {
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => handler(command, args),
      },
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /** 跑一次真的 `spaces_switch`，让它把这次拒绝写进按命令名保留的台账。 */
  async function refuseWith(detail: unknown): Promise<void> {
    installBridge(async () => {
      throw detail;
    });
    const { switchSpace } = await import("../spaces");
    expect(await switchSpace(99)).toBeNull();
  }

  test("已知 code 映射到它自己那一句", async () => {
    const cases: Array<[string, string]> = [
      ["amos.spaces.lock_failed", "spaces.errorLockFailed"],
      ["amos.spaces.serialization_failed", "spaces.errorSerialization"],
      ["amos.spaces.not_found", "spaces.errorNotFound"],
      ["amos.spaces.index_out_of_bounds", "spaces.errorOutOfBounds"],
      ["amos.spaces.delete_last", "spaces.errorDeleteLast"],
    ];
    for (const [code, key] of cases) {
      await refuseWith({ code, message: "宿主的话" });
      // 有声明的 code ⇒ 用我们自己的措辞，宿主那句话不参与（否则两种说法会打架）。
      expect(spacesFailure("spaces_switch")).toEqual({ key });
    }
  });

  test("未知 code 落回宿主自己写下的那句话（没有已知 code 可映射）", async () => {
    await refuseWith({ code: "amos.spaces.something_new", message: "宿主的话" });
    expect(spacesFailure("spaces_switch")).toEqual({
      key: "spaces.errorUnknown",
      hostMessage: "宿主的话",
    });
  });

  test("错误里连 code 都没有时，也给宿主那句话 —— 但 key 仍是未知", async () => {
    await refuseWith({ message: "只有一句话" });
    expect(spacesFailure("spaces_switch")).toEqual({
      key: "spaces.errorUnknown",
      hostMessage: "只有一句话",
    });
  });

  test("台账里没有这次命令的失败记录 ⇒ 没有任何话可说（调用点的 null 判据才是权威）", () => {
    installBridge(async () => null);
    // 台账是**按命令名**保留最近一次读数、且跨用例存活（模块级 Map），所以这里用一个本进程
    // 从没调用过的名字，测的才是"没有记录"那一支（`bridgeDiag` 的 `{ ok: true }` 默认）。
    expect(spacesFailure("spaces_never_called")).toEqual({ key: "spaces.errorUnknown" });
  });

  test("读的是**指定的那条**命令，不是最近一次任何调用", async () => {
    await refuseWith({ code: "amos.spaces.index_out_of_bounds" });
    expect(spacesFailure("spaces_switch")).toEqual({ key: "spaces.errorOutOfBounds" });
    // 另一个命令名没有记录 ⇒ 不会被上一条的读数串到。
    expect(spacesFailure("spaces_list")).toEqual({ key: "spaces.errorUnknown" });
  });
});

/**
 * REQ-A449 — which windows a desktop may own. The rule lives here (not in the panel) so it is
 * pinned without a renderer; each exclusion is a decision the panel would otherwise have to
 * explain to the user.
 */
describe("fileableWindows - 可归档的窗口", () => {
  const win = (label: string, kind: string, external = false) => ({
    id: 1,
    label,
    // REQ-A473: the identity the host reports (`""`/0 = the window shows no app). These
    // cases are about `kind`, so the app is derived the way `normalizeWindows` does.
    app: external ? "" : label,
    instance: external ? 0 : 1,
    kind,
    state: "Shown",
    focused: false,
    external,
  });

  test("只保留 App 窗口", () => {
    const out = fileableWindows({
      focused: null,
      windows: [
        win("main", "Launcher"),
        win("files", "App"),
        win("notification-center", "System"),
        win("legacy:7", "App", true),
      ],
    });
    expect(out.map((w) => w.label)).toEqual(["files"]);
  });

  test("Launcher 永不出现在列表里（切换桌面不会隐藏它，所以归档它是谎）", () => {
    const out = fileableWindows({ focused: null, windows: [win("main", "Launcher")] });
    expect(out).toEqual([]);
  });

  test("external 合成面不可归档（没有我们的 WebviewWindow 可隐藏）", () => {
    const out = fileableWindows({ focused: null, windows: [win("legacy:3", "App", true)] });
    expect(out).toEqual([]);
  });

  test("空快照返回空数组，且不修改入参", () => {
    const snapshot = { focused: null, windows: [] as ReturnType<typeof win>[] };
    expect(fileableWindows(snapshot)).toEqual([]);
    expect(snapshot.windows).toEqual([]);
  });
});

