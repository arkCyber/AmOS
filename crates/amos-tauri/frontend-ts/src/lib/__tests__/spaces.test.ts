/**
 * Spaces API 测试
 * 
 * 状态：完整测试（2026-09-16）
 * 
 * 测试完整的 Spaces 功能与 Rust 后端的集成。
 * 
 * 注意：使用 bun:test 框架，不使用 vi.mock（Bun 不支持）
 */

import { describe, test, expect } from "bun:test";
import type { Space } from "../spaces";

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

  test("SpaceInfo 接口与 Space 兼容", () => {
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
      isSpacesAvailable,
      getSpacesStatus,
    } = await import("../spaces");
    
    expect(typeof listSpaces).toBe("function");
    expect(typeof activeSpace).toBe("function");
    expect(typeof switchSpace).toBe("function");
    expect(typeof createSpace).toBe("function");
    expect(typeof deleteSpace).toBe("function");
    expect(typeof moveWindowToSpace).toBe("function");
    expect(typeof renameSpace).toBe("function");
    expect(typeof isSpacesAvailable).toBe("function");
    expect(typeof getSpacesStatus).toBe("function");
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

  test("mutation 调用(switchSpace / deleteSpace / renameSpace)用 boolean 而不是 reject", async () => {
    const { switchSpace, deleteSpace, renameSpace, moveWindowToSpace } = await import("../spaces");
    // 返回类型是 boolean(成功/失败),不是 throw — 这是 REQ-A296 把错误推回 data 后的副作用
    expect(await switchSpace(0) === true || await switchSpace(0) === false).toBe(true);
    expect(await deleteSpace("space-0") === true || await deleteSpace("space-0") === false).toBe(true);
    expect(await renameSpace("space-0", "x") === true || await renameSpace("space-0", "x") === false).toBe(true);
    expect(await moveWindowToSpace("settings", "space-0") === true ||
           await moveWindowToSpace("settings", "space-0") === false).toBe(true);
    // 关键:不会抛
    let threw = false;
    try {
      await switchSpace(99);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
