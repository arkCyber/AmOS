/**
 * rotation.test.ts — REQ-A677 · 旋转锁定 / 强制方向的前端真源 + 跨语言负控。
 *
 * Why this file exists:
 *   * `lib/rotation.ts` 是 rotation 的前端真源。`NotificationCenter.svelte` 的
 *     快速设置 tile **必须** import 它，不许内联 `"amos.rotation"` 或模式 key 字面量。
 *   * 真正做决策的是 Rust 纯内核 `crates/amos-display/src/orientation.rs`
 *     （4 个模式 key、Android requested-orientation 码、哪个模式「冻结」显示）。
 *     **两端词表必须逐字一致** —— 一条结构性负控直接读 Rust 源码，把
 *     `RotationMode::key()` 的字符串与这里 `ROTATION_MODES` 比对；任何一端漂移立即红。
 *   * 诚实边界：桌面 / CI 的 `rotation_set` 答 `hostOnly`（意图已存，宿主无方向可转），
 *     设备拒绝时答 `denied` 等 —— `classifyRotationOutcome` 绝不把非 `applied`
 *     读成成功（避免「假装转了」的静默缺陷）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_ROTATION_MODE,
  ROTATION_KEY,
  ROTATION_MODES,
  classifyRotationOutcome,
  isRotationMode,
  normalizeRotation,
  orientationOf,
  rotationFreezes,
  rotationLabelKey,
} from "../rotation";

describe("rotation · 常量与词表", () => {
  test("ROTATION_KEY = 'amos.rotation'（与 Rust rotation::ROTATION_KEY 同源）", () => {
    expect(ROTATION_KEY).toBe("amos.rotation");
  });

  test("ROTATION_MODES 是四个 key，顺序与 Rust 一份列表一致", () => {
    expect([...ROTATION_MODES]).toEqual(["auto", "locked", "portrait", "landscape"]);
  });

  test("默认模式是 auto（未锁定 —— 损坏的 store 不能让显示永久冻住）", () => {
    expect(DEFAULT_ROTATION_MODE).toBe("auto");
  });

  test("isRotationMode 只认这四个 key", () => {
    for (const m of ROTATION_MODES) expect(isRotationMode(m)).toBe(true);
    expect(isRotationMode("sideways")).toBe(false);
    expect(isRotationMode("")).toBe(false);
    expect(isRotationMode(1)).toBe(false);
    expect(isRotationMode(null)).toBe(false);
  });
});

describe("rotation · normalizeRotation", () => {
  test("已知 key 原样返回", () => {
    expect(normalizeRotation("locked")).toBe("locked");
    expect(normalizeRotation("portrait")).toBe("portrait");
  });

  test("接受宿主存的 `{ mode }` 对象形状（与 Rust RotationStore 同形）", () => {
    expect(normalizeRotation({ mode: "landscape" })).toBe("landscape");
  });

  test("absent / corrupt / 未知 key / 错误形状 → auto", () => {
    expect(normalizeRotation(undefined)).toBe("auto");
    expect(normalizeRotation(null)).toBe("auto");
    expect(normalizeRotation("bogus")).toBe("auto");
    expect(normalizeRotation({ mode: "sideways" })).toBe("auto");
    expect(normalizeRotation({ other: "locked" })).toBe("auto");
    expect(normalizeRotation([1, 2, 3])).toBe("auto");
  });
});

describe("rotation · 语义", () => {
  test("只有 auto 不冻结显示（= 旋转锁关）", () => {
    expect(rotationFreezes("auto")).toBe(false);
    expect(rotationFreezes("locked")).toBe(true);
    expect(rotationFreezes("portrait")).toBe(true);
    expect(rotationFreezes("landscape")).toBe(true);
  });

  test("标签 key 逐模式唯一", () => {
    const keys = ROTATION_MODES.map(rotationLabelKey);
    expect(keys).toEqual([
      "rotation.auto",
      "rotation.locked",
      "rotation.portrait",
      "rotation.landscape",
    ]);
    expect(new Set(keys).size).toBe(4);
  });

  test("orientationOf：宽 > 高为横屏，正方形算竖屏（与 Rust 一致）", () => {
    expect(orientationOf(1200, 800)).toBe("landscape");
    expect(orientationOf(800, 1200)).toBe("portrait");
    expect(orientationOf(1000, 1000)).toBe("portrait");
  });
});

describe("rotation · classifyRotationOutcome（诚实结果，绝不四舍五入）", () => {
  test("applied → applied；host_only → host_only", () => {
    expect(classifyRotationOutcome({ mode: "locked", available: true, outcome: { state: "applied" } })).toEqual({
      kind: "applied",
    });
    expect(
      classifyRotationOutcome({ mode: "locked", available: false, outcome: { state: "host_only" } }),
    ).toEqual({ kind: "host_only" });
  });

  test("未落地状态归入 unapplied，并带上宿主原话", () => {
    for (const state of ["unattached", "unavailable", "denied", "unknown"]) {
      const out = classifyRotationOutcome({
        mode: "landscape",
        available: true,
        outcome: { state, detail: "boom" },
      });
      expect(out.kind).toBe("unapplied");
      if (out.kind === "unapplied") {
        expect(out.state).toBe(state);
        expect(out.detail).toBe("boom");
      }
    }
  });

  test("一个没见过的 state 也不能读成成功", () => {
    const out = classifyRotationOutcome({
      mode: "locked",
      available: true,
      outcome: { state: "who_knows" },
    });
    expect(out.kind).not.toBe("applied");
  });
});

// ─── §结构性负控：唯一真源 + 跨语言镜像 ────────────────────────────────────

describe("rotation · 结构性负控（唯一真源）", () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  test("`amos.rotation` 字面量只在 lib/rotation.ts（不许别处内联）", () => {
    // 真源：恰好一处。
    expect((src("../rotation.ts").match(/"amos\.rotation"/g) ?? []).length).toBe(1);
    // 消费者：不许内联（必须 import ROTATION_KEY）。
    expect(src("../../svelte/NotificationCenter.svelte")).not.toContain('"amos.rotation"');
  });

  test("NotificationCenter 从 ../lib/rotation import（不许自己写第二份词表）", () => {
    const nc = src("../../svelte/NotificationCenter.svelte");
    expect(nc).toContain('from "../lib/rotation"');
    // 模式 key 字面量不能内联在组件里 —— 必须来自 ROTATION_MODES。
    expect(nc).not.toContain('"portrait"');
    expect(nc).not.toContain('"landscape"');
  });

  test("ROTATION_MODES 逐字等于 Rust `RotationMode::key()` 的字符串（跨语言镜像）", () => {
    const rust = src("../../../../../amos-display/src/orientation.rs");
    // `RotationMode::X => "str",` 只在 key() 里出现（from_key 是 `"str" => Some(...)`）。
    const found = [...rust.matchAll(/RotationMode::\w+\s*=>\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(found).toEqual([...ROTATION_MODES]);
  });
});
