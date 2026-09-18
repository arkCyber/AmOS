/**
 * ringtonePlayer.test.ts — 铃声播放器双引擎契约（src/lib/ringtonePlayer.ts，REQ-A396）。
 *
 * 播放器依赖宿主注入的 `window.AudioContext`（合成引擎）与 `window.Audio`
 * （文件引擎）。这里用最小假体替换两者，覆盖：
 * - 无音频宿主时的严格 no-op；
 * - 合成环铃：缓冲渲染 → gain 接线 → 启动；停止时 stop/disconnect/close 全走一遍；
 * - 文件环铃：`<audio loop>` 指向 ringtone 文件 URL，播放失败/出错时回退合成；
 * - 试听（previewAlarmTone）：文件一次性播放与合成一次性播放两条路径。
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import {
  setRingtoneFilesEnabled,
  activeRingtone,
  startAlarmRing,
  stopAlarmRing,
  previewAlarmTone,
} from "../ringtonePlayer";
import { ringtoneIdFor } from "../ringtone";

// ---------------------------------------------------------------------------
// 假音频栈
// ---------------------------------------------------------------------------

class FakeBufferSource {
  loop = false;
  buffer: unknown = null;
  started = 0;
  stopThrows = false;
  connectTargets: unknown[] = [];
  endedListeners: Array<() => void> = [];
  connect(n: unknown) {
    this.connectTargets.push(n);
    return n;
  }
  start() {
    this.started++;
  }
  stop() {
    if (this.stopThrows) throw new Error("already stopped");
  }
  disconnect() {
    /* ok */
  }
  addEventListener(type: string, fn: () => void) {
    if (type === "ended") this.endedListeners.push(fn);
  }
}

class FakeGain {
  gain = { value: 0 };
  connectTargets: unknown[] = [];
  connect(n: unknown) {
    this.connectTargets.push(n);
    return n;
  }
}

let lastContext: FakeAudioContext | null = null;

class FakeAudioContext {
  destination = { kind: "destination" };
  closed = 0;
  bufferSource = new FakeBufferSource();
  gain = new FakeGain();
  constructor() {
    lastContext = this;
  }
  createBuffer(_ch: number, len: number, rate: number) {
    return { channels: _ch, len, rate, copyToChannel: () => {} };
  }
  createBufferSource() {
    return this.bufferSource;
  }
  createGain() {
    return this.gain;
  }
  close() {
    this.closed++;
    return Promise.resolve();
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  static nextPlayError: Error | null = null;
  loop = false;
  volume = 0;
  preload = "";
  src = "";
  listeners = new Map<string, Array<() => void>>();
  constructThrows = false;
  played = 0;
  srcRemoved = false;
  constructor() {
    if (this.constructThrows) throw new Error("no audio device");
    FakeAudio.instances.push(this);
  }
  play() {
    this.played++;
    const err = FakeAudio.nextPlayError;
    if (err) return Promise.reject(err);
    return Promise.resolve();
  }
  pause() {
    /* ok */
  }
  removeAttribute(name: string) {
    if (name === "src") this.srcRemoved = true;
  }
  load() {
    /* ok */
  }
  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

function installAudioHost(opts: { audio?: boolean; context?: boolean } = {}) {
  const w: Record<string, unknown> = {};
  if (opts.context !== false) w.AudioContext = FakeAudioContext;
  if (opts.audio) w.Audio = FakeAudio;
  (globalThis as { window?: unknown }).window = w;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.nextPlayError = null;
  lastContext = null;
  stopAlarmRing();
  setRingtoneFilesEnabled(false);
  installAudioHost({ context: true });
});

afterEach(() => {
  stopAlarmRing();
  setRingtoneFilesEnabled(false);
  delete (globalThis as { window?: unknown }).window;
});

// ---------------------------------------------------------------------------
// 合成引擎
// ---------------------------------------------------------------------------

describe("ringtonePlayer 合成引擎", () => {
  it("无 window 时严格 no-op：启动/试听均不抛、无活动铃声", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(startAlarmRing()).toBeNull();
    expect(activeRingtone()).toBeNull();
    expect(() => previewAlarmTone()).not.toThrow();
  });

  it("有 AudioContext 无 Audio：合成环铃启动并记录活动 id", () => {
    const id = startAlarmRing();
    expect(id).not.toBeNull();
    expect(activeRingtone()).toBe(id);
    expect(lastContext).not.toBeNull();
    const src = lastContext!.bufferSource;
    expect(src.loop).toBe(true);
    expect(src.started).toBe(1);
    expect(src.buffer).not.toBeNull();
    expect(lastContext!.gain.gain.value).toBe(0.5);
    expect(src.connectTargets).toContain(lastContext!.gain);
    expect(lastContext!.gain.connectTargets).toContain(lastContext!.destination);
  });

  it("stopAlarmRing 幂等清理：stop/disconnect/close 并清空活动 id", async () => {
    startAlarmRing();
    const ctx = lastContext!;
    const src = ctx.bufferSource;
    stopAlarmRing();
    expect(activeRingtone()).toBeNull();
    await flush();
    expect(src.started).toBe(1);
    expect(ctx.closed).toBe(1);
    // 再停一次不抛
    expect(() => stopAlarmRing()).not.toThrow();
  });

  it("src.stop 抛错（已停止）也被吞掉", () => {
    startAlarmRing();
    lastContext!.bufferSource.stopThrows = true;
    expect(() => stopAlarmRing()).not.toThrow();
    expect(activeRingtone()).toBeNull();
  });

  it("AudioContext 构造失败时返回 null（合成不可用）", () => {
    installAudioHost({ context: false });
    (globalThis as { window?: unknown }).window = {
      AudioContext: class {
        constructor() {
          throw new Error("audio blocked");
        }
      },
    };
    expect(startAlarmRing()).toBeNull();
    expect(activeRingtone()).toBeNull();
  });

  it("重复 startAlarmRing 先停旧铃再启新铃", () => {
    const first = startAlarmRing();
    const ctx1 = lastContext!;
    const second = startAlarmRing();
    expect(second).not.toBeNull();
    expect(ctx1).not.toBe(lastContext!);
    expect(activeRingtone()).toBe(second);
    expect(first).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 文件引擎 + 试听
// ---------------------------------------------------------------------------

describe("ringtonePlayer 文件引擎", () => {
  it("开启文件模式且有 Audio：环铃走 <audio loop>，不创建合成上下文", () => {
    setRingtoneFilesEnabled(true);
    installAudioHost({ audio: true });
    const id = startAlarmRing("radial");
    expect(id).not.toBeNull();
    expect(activeRingtone()).toBe(id);
    const el = FakeAudio.instances[0]!;
    expect(el.loop).toBe(true);
    expect(el.volume).toBe(0.6);
    expect(el.preload).toBe("auto");
    expect(el.src).toContain("sounds/ringtones");
    expect(el.played).toBe(1);
    expect(lastContext).toBeNull(); // 未回退到合成
  });

  it("文件播放出错（error 事件）回退到合成环铃", () => {
    setRingtoneFilesEnabled(true);
    installAudioHost({ audio: true });
    const id = startAlarmRing();
    expect(lastContext).toBeNull();
    FakeAudio.instances[0]!.emit("error");
    expect(lastContext).not.toBeNull(); // 合成引擎接管
    expect(activeRingtone()).toBe(id);
  });

  it("play() Promise 拒绝同样回退合成", async () => {
    setRingtoneFilesEnabled(true);
    installAudioHost({ audio: true });
    FakeAudio.nextPlayError = new Error("autoplay blocked");
    const id = startAlarmRing();
    await flush();
    // 文件引擎先启动失败 → 合成引擎接管，铃声仍在响
    expect(id).not.toBeNull();
    expect(lastContext).not.toBeNull();
    expect(activeRingtone()).toBe(id);
  });

  it("Audio 构造抛错：异常向上传播（startFileRing 的 try 不覆盖构造）", () => {
    setRingtoneFilesEnabled(true);
    class BrokenAudio {
      constructor() {
        throw new Error("no device");
      }
    }
    (globalThis as { window?: unknown }).window = { Audio: BrokenAudio };
    expect(() => startAlarmRing()).toThrow("no device");
  });

  it("文件模式开启但宿主无 Audio 构造器：直接合成", () => {
    setRingtoneFilesEnabled(true);
    installAudioHost({ context: true });
    const id = startAlarmRing();
    expect(id).not.toBeNull();
    expect(lastContext).not.toBeNull();
    expect(FakeAudio.instances.length).toBe(0);
  });
});

describe("ringtonePlayer 试听（previewAlarmTone）", () => {
  it("文件模式：一次性播放并注册 ended 清理", () => {
    setRingtoneFilesEnabled(true);
    installAudioHost({ audio: true });
    previewAlarmTone("radial");
    const el = FakeAudio.instances[0]!;
    expect(el.volume).toBe(0.8);
    expect(el.src).toContain("sounds/ringtones");
    expect(el.played).toBe(1);
    expect(el.listeners.has("ended")).toBe(true);
    // 播放结束 → 清理 src
    el.emit("ended");
    expect(el.srcRemoved).toBe(true);
    expect(activeRingtone()).toBeNull();
  });

  it("合成模式：一次性播放，ended 后关闭上下文", async () => {
    installAudioHost({ context: true });
    previewAlarmTone();
    expect(lastContext).not.toBeNull();
    const src = lastContext!.bufferSource;
    expect(src.loop).toBe(false);
    expect(src.started).toBe(1);
    expect(src.endedListeners.length).toBe(1);
    src.endedListeners[0]!();
    await flush();
    expect(lastContext!.closed).toBe(1);
    expect(activeRingtone()).toBeNull();
  });

  it("无任何音频宿主：试听为 no-op", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => previewAlarmTone()).not.toThrow();
  });

  it("试听前有环铃在响：先停环铃再试听", () => {
    const id = startAlarmRing();
    expect(activeRingtone()).toBe(id);
    previewAlarmTone();
    expect(activeRingtone()).toBeNull();
  });
});


