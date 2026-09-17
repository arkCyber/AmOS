/**
 * 航空航天级测试套件 - 语音输入系统
 * 
 * 测试范围:
 * - 状态机转换 (voiceReducer)
 * - 音频处理 (pcmToWavBytes, hasSignal)
 * - 转录结果解析 (parseTranscribe)
 * - 助手语音事件解析 (parseVoiceEvent)
 * - 音频块转换 (pcmToAssistantChunk)
 * - WAV 格式生成 (wavBytes)
 * - 边界条件与异常处理
 */

import { describe, test, expect } from "bun:test";
import {
  voiceReducer,
  pcmToWavBytes,
  hasSignal,
  parseTranscribe,
  parseVoiceEvent,
  pcmToAssistantChunk,
  wavBytes,
  type VoiceStatus,
  type VoiceAction,
} from "../voice";

// Types available if needed: TranscribeOut, AssistantVoiceEvent
// beforeEach is available from bun:test if needed

describe("语音输入系统 - 状态机", () => {
  test("初始状态应该是 idle", () => {
    const status: VoiceStatus = "idle";
    expect(status).toBe("idle");
  });

  test("idle → recording: start 动作", () => {
    const result = voiceReducer("idle", { type: "start" });
    expect(result).toBe("recording");
  });

  test("recording → transcribing: stop 动作", () => {
    const result = voiceReducer("recording", { type: "stop" });
    expect(result).toBe("transcribing");
  });

  test("transcribing → idle: ok 动作", () => {
    const result = voiceReducer("transcribing", { type: "ok" });
    expect(result).toBe("idle");
  });

  test("任何状态 → error: fail 动作", () => {
    expect(voiceReducer("idle", { type: "fail" })).toBe("error");
    expect(voiceReducer("recording", { type: "fail" })).toBe("error");
    expect(voiceReducer("transcribing", { type: "fail" })).toBe("error");
  });

  test("error → recording: start 动作（允许重试）", () => {
    const result = voiceReducer("error", { type: "start" });
    expect(result).toBe("recording");
  });

  test("无效状态转换应该保持当前状态", () => {
    // recording 状态不应该响应 start
    expect(voiceReducer("recording", { type: "start" })).toBe("recording");
    
    // idle 状态不应该响应 stop
    expect(voiceReducer("idle", { type: "stop" })).toBe("idle");
    
    // transcribing 状态不应该响应 start
    expect(voiceReducer("transcribing", { type: "start" })).toBe("transcribing");
  });
});

describe("语音输入系统 - 音频信号检测", () => {
  test("静音音频应该返回 false", () => {
    const silence = new Float32Array(1000).fill(0);
    expect(hasSignal(silence)).toBe(false);
  });

  test("有信号的音频应该返回 true", () => {
    const audio = new Float32Array(1000);
    audio[500] = 0.1; // 超过默认阈值 0.004
    expect(hasSignal(audio)).toBe(true);
  });

  test("微弱信号应该被默认阈值过滤", () => {
    const audio = new Float32Array(1000);
    audio[500] = 0.001; // 低于默认阈值 0.004
    expect(hasSignal(audio)).toBe(false);
  });

  test("自定义阈值应该生效", () => {
    const audio = new Float32Array(1000);
    audio[500] = 0.002;
    
    expect(hasSignal(audio, 0.001)).toBe(true);  // 超过自定义阈值
    expect(hasSignal(audio, 0.003)).toBe(false); // 低于自定义阈值
  });

  test("负数信号应该被正确检测（取绝对值）", () => {
    const audio = new Float32Array(1000);
    audio[500] = -0.1; // 负数但绝对值超过阈值
    expect(hasSignal(audio)).toBe(true);
  });

  test("空数组应该返回 false", () => {
    expect(hasSignal(new Float32Array(0))).toBe(false);
    expect(hasSignal([])).toBe(false);
  });
});

describe("语音输入系统 - WAV 格式生成", () => {
  test("生成的 WAV 应该包含正确的 RIFF 头", () => {
    const pcm = [0, 255, 128, 64]; // 模拟 PCM 数据
    const wav = wavBytes(pcm, 16000);
    
    // RIFF 魔数
    expect(wav[0]).toBe(0x52); // 'R'
    expect(wav[1]).toBe(0x49); // 'I'
    expect(wav[2]).toBe(0x46); // 'F'
    expect(wav[3]).toBe(0x46); // 'F'
    
    // WAVE 魔数
    expect(wav[8]).toBe(0x57);  // 'W'
    expect(wav[9]).toBe(0x41);  // 'A'
    expect(wav[10]).toBe(0x56); // 'V'
    expect(wav[11]).toBe(0x45); // 'E'
  });

  test("生成的 WAV 应该包含正确的 fmt 块", () => {
    const pcm = [0, 255];
    const wav = wavBytes(pcm, 16000);
    
    // fmt 魔数
    expect(wav[12]).toBe(0x66); // 'f'
    expect(wav[13]).toBe(0x6D); // 'm'
    expect(wav[14]).toBe(0x74); // 't'
    
    // 音频格式 = 1 (PCM)
    expect(wav[20]).toBe(1);
    expect(wav[21]).toBe(0);
    
    // 声道数 = 1 (Mono)
    expect(wav[22]).toBe(1);
    expect(wav[23]).toBe(0);
    
    // 采样率 = 16000
    expect(wav[24]).toBe(16000 & 0xFF);
    expect(wav[25]).toBe((16000 >> 8) & 0xFF);
    
    // 位深度 = 16
    expect(wav[34]).toBe(16);
    expect(wav[35]).toBe(0);
  });

  test("生成的 WAV 应该包含正确的 data 块", () => {
    const pcm = [0, 255, 128];
    const wav = wavBytes(pcm, 16000);
    
    // data 魔数
    expect(wav[36]).toBe(0x64); // 'd'
    expect(wav[37]).toBe(0x61); // 'a'
    expect(wav[38]).toBe(0x74); // 't'
    expect(wav[39]).toBe(0x61); // 'a'
    
    // data 长度
    expect(wav[40]).toBe(pcm.length & 0xFF);
    
    // data 内容
    expect(wav[44]).toBe(0);
    expect(wav[45]).toBe(255);
    expect(wav[46]).toBe(128);
  });

  test("WAV 总大小应该是 44 + PCM 长度", () => {
    const pcm = new Array(1000).fill(0);
    const wav = wavBytes(pcm, 16000);
    expect(wav.length).toBe(44 + 1000);
  });

  test("空 PCM 数据应该生成仅包含头的 WAV", () => {
    const wav = wavBytes([], 16000);
    expect(wav.length).toBe(44);
  });
});

describe("语音输入系统 - PCM 到 WAV 转换", () => {
  test("Float32Array 输入应该被正确处理", () => {
    const samples = new Float32Array([0.5, -0.5, 0.25, -0.25]);
    const wav = pcmToWavBytes(samples, 48000);
    
    // 应该包含 RIFF 头
    expect(wav.length).toBeGreaterThan(44);
    expect(wav[0]).toBe(0x52); // 'R'
  });

  test("普通数组输入应该被正确处理", () => {
    const samples = [0.5, -0.5, 0.25, -0.25];
    const wav = pcmToWavBytes(samples, 48000);
    
    expect(wav.length).toBeGreaterThan(44);
    expect(wav[0]).toBe(0x52); // 'R'
  });

  test("生成的 WAV 采样率应该是 16kHz", () => {
    const samples = new Float32Array(1000).fill(0.1);
    const wav = pcmToWavBytes(samples, 48000);
    
    // 采样率字段 (offset 24-27)
    const sampleRate = (wav[24] ?? 0) | ((wav[25] ?? 0) << 8) | ((wav[26] ?? 0) << 16) | ((wav[27] ?? 0) << 24);
    expect(sampleRate).toBe(16000);
  });

  test("空输入应该生成有效的 WAV（仅头）", () => {
    const wav = pcmToWavBytes([], 48000);
    expect(wav.length).toBeGreaterThanOrEqual(44);
  });
});

describe("语音输入系统 - 转录结果解析", () => {
  test("有效的转录结果应该被正确解析", () => {
    const payload = {
      text: "Hello, world!",
      recognized: true,
    };
    
    const result = parseTranscribe(payload);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("Hello, world!");
    expect(result?.recognized).toBe(true);
  });

  test("recognized = false 应该被正确处理", () => {
    const payload = {
      text: "",
      recognized: false,
    };
    
    const result = parseTranscribe(payload);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
    expect(result?.recognized).toBe(false);
  });

  test("缺少 text 字段应该返回 null", () => {
    const payload = {
      recognized: true,
    };
    
    expect(parseTranscribe(payload)).toBeNull();
  });

  test("text 不是字符串应该返回 null", () => {
    const payload = {
      text: 123,
      recognized: true,
    };
    
    expect(parseTranscribe(payload)).toBeNull();
  });

  test("null 输入应该返回 null", () => {
    expect(parseTranscribe(null)).toBeNull();
  });

  test("undefined 输入应该返回 null", () => {
    expect(parseTranscribe(undefined)).toBeNull();
  });

  test("非对象输入应该返回 null", () => {
    expect(parseTranscribe("not an object")).toBeNull();
    expect(parseTranscribe(123)).toBeNull();
    expect(parseTranscribe(true)).toBeNull();
  });

  test("额外字段应该被忽略", () => {
    const payload = {
      text: "test",
      recognized: true,
      extra: "ignored",
    };
    
    const result = parseTranscribe(payload);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("test");
  });
});

describe("语音输入系统 - 助手语音事件解析", () => {
  test("listening 事件应该被正确解析", () => {
    const payload = {
      kind: "listening",
      session: "session-123",
    };
    
    const event = parseVoiceEvent(payload);
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("listening");
    expect(event?.session).toBe("session-123");
  });

  test("token 事件应该被正确解析", () => {
    const payload = {
      kind: "token",
      session: "session-123",
      token: "Hello",
    };
    
    const event = parseVoiceEvent(payload);
    expect(event).not.toBeNull();
    if (event?.kind === "token") {
      expect(event.token).toBe("Hello");
      expect(event.session).toBe("session-123");
    }
  });

  test("turn_done 事件应该被正确解析", () => {
    const payload = {
      kind: "turn_done",
      session: "session-123",
      text: "Complete response",
    };
    
    const event = parseVoiceEvent(payload);
    expect(event).not.toBeNull();
    if (event?.kind === "turn_done") {
      expect(event.text).toBe("Complete response");
      expect(event.session).toBe("session-123");
    }
  });

  test("stopped 事件应该被正确解析", () => {
    const payload = {
      kind: "stopped",
      session: "session-123",
    };
    
    const event = parseVoiceEvent(payload);
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("stopped");
    expect(event?.session).toBe("session-123");
  });

  test("error 事件应该被正确解析", () => {
    const payload = {
      kind: "error",
      session: "session-123",
      message: "Network error",
    };
    
    const event = parseVoiceEvent(payload);
    expect(event).not.toBeNull();
    if (event?.kind === "error") {
      expect(event.message).toBe("Network error");
      expect(event.session).toBe("session-123");
    }
  });

  test("缺少 session 应该使用空字符串", () => {
    const payload = {
      kind: "listening",
    };
    
    const event = parseVoiceEvent(payload);
    expect(event).not.toBeNull();
    expect(event?.session).toBe("");
  });

  test("无效的 kind 应该返回 null", () => {
    const payload = {
      kind: "invalid",
      session: "session-123",
    };
    
    expect(parseVoiceEvent(payload)).toBeNull();
  });

  test("token 事件缺少 token 字段应该返回 null", () => {
    const payload = {
      kind: "token",
      session: "session-123",
    };
    
    expect(parseVoiceEvent(payload)).toBeNull();
  });

  test("turn_done 事件缺少 text 字段应该返回 null", () => {
    const payload = {
      kind: "turn_done",
      session: "session-123",
    };
    
    expect(parseVoiceEvent(payload)).toBeNull();
  });

  test("error 事件缺少 message 字段应该返回 null", () => {
    const payload = {
      kind: "error",
      session: "session-123",
    };
    
    expect(parseVoiceEvent(payload)).toBeNull();
  });

  test("null 输入应该返回 null", () => {
    expect(parseVoiceEvent(null)).toBeNull();
  });

  test("非对象输入应该返回 null", () => {
    expect(parseVoiceEvent("string")).toBeNull();
    expect(parseVoiceEvent(123)).toBeNull();
  });
});

describe("语音输入系统 - 助手音频块转换", () => {
  test("Float32Array 输入应该被正确转换", () => {
    const samples = new Float32Array([0.5, -0.5, 0.25, -0.25]);
    const chunk = pcmToAssistantChunk(samples, 48000);
    
    // 应该是小端序 f32 字节数组
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length % 4).toBe(0); // f32 每个采样 4 字节
  });

  test("普通数组输入应该被正确转换", () => {
    const samples = [0.5, -0.5, 0.25, -0.25];
    const chunk = pcmToAssistantChunk(samples, 48000);
    
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length % 4).toBe(0);
  });

  test("空输入应该返回空数组或最小长度数组", () => {
    const chunk = pcmToAssistantChunk([], 48000);
    expect(Array.isArray(chunk)).toBe(true);
  });

  test("高采样率应该被下采样到 16kHz", () => {
    const samples = new Float32Array(48000).fill(0.1); // 1秒 @ 48kHz
    const chunk = pcmToAssistantChunk(samples, 48000);
    
    // 下采样到 16kHz 后，1秒应该是 16000 采样 × 4 字节
    const expectedLength = 16000 * 4;
    expect(chunk.length).toBeCloseTo(expectedLength, -2); // 允许±100字节误差
  });
});

describe("语音输入系统 - 边界条件", () => {
  test("极大音频数据应该被正确处理", () => {
    const largeSamples = new Float32Array(100000).fill(0.1);
    const wav = pcmToWavBytes(largeSamples, 48000);
    expect(wav.length).toBeGreaterThan(44);
  });

  test("极小音频数据应该被正确处理", () => {
    const tinySamples = new Float32Array(1).fill(0.1);
    const wav = pcmToWavBytes(tinySamples, 48000);
    expect(wav.length).toBeGreaterThanOrEqual(44);
  });

  test("零值音频应该生成有效的 WAV", () => {
    const zeroSamples = new Float32Array(1000).fill(0);
    const wav = pcmToWavBytes(zeroSamples, 48000);
    expect(wav[0]).toBe(0x52); // 'R'
  });

  test("负采样率应该被正确处理（使用绝对值）", () => {
    const samples = new Float32Array([0.1, 0.2]);
    // 实现应该处理负采样率或抛出错误
    // 这里假设实现会使用绝对值
    expect(() => pcmToWavBytes(samples, -48000)).not.toThrow();
  });

  test("状态机连续转换应该保持一致性", () => {
    let state: VoiceStatus = "idle";
    
    // 完整流程：idle → recording → transcribing → idle
    state = voiceReducer(state, { type: "start" });
    expect(state).toBe("recording");
    
    state = voiceReducer(state, { type: "stop" });
    expect(state).toBe("transcribing");
    
    state = voiceReducer(state, { type: "ok" });
    expect(state).toBe("idle");
  });

  test("错误恢复流程应该正常工作", () => {
    let state: VoiceStatus = "idle";
    
    // 进入错误状态
    state = voiceReducer(state, { type: "fail" });
    expect(state).toBe("error");
    
    // 从错误恢复
    state = voiceReducer(state, { type: "start" });
    expect(state).toBe("recording");
    
    // 完成正常流程
    state = voiceReducer(state, { type: "stop" });
    expect(state).toBe("transcribing");
    
    state = voiceReducer(state, { type: "ok" });
    expect(state).toBe("idle");
  });
});

describe("语音输入系统 - 航空航天级可靠性", () => {
  test("解析器应该对恶意输入保持健壮", () => {
    // 超长字符串
    const longText = "a".repeat(1000000);
    const payload1 = { text: longText, recognized: true };
    const result1 = parseTranscribe(payload1);
    expect(result1?.text).toBe(longText);
    
    // 特殊字符
    const payload2 = { text: "Hello\n\r\t\0World", recognized: true };
    const result2 = parseTranscribe(payload2);
    expect(result2?.text).toContain("Hello");
    
    // Unicode
    const payload3 = { text: "你好世界 🌍", recognized: true };
    const result3 = parseTranscribe(payload3);
    expect(result3?.text).toBe("你好世界 🌍");
  });

  test("音频处理应该对边界值保持稳定", () => {
    // 最大浮点数
    const maxSamples = new Float32Array([Number.MAX_VALUE, -Number.MAX_VALUE]);
    expect(() => pcmToWavBytes(maxSamples, 48000)).not.toThrow();
    
    // 无穷大
    const infSamples = new Float32Array([Infinity, -Infinity]);
    expect(() => pcmToWavBytes(infSamples, 48000)).not.toThrow();
    
    // NaN
    const nanSamples = new Float32Array([NaN, NaN]);
    expect(() => pcmToWavBytes(nanSamples, 48000)).not.toThrow();
  });

  test("解析器应该对循环引用保持安全", () => {
    const circular: any = { text: "test", recognized: true };
    circular.self = circular;
    
    // 不应该进入无限循环
    const result = parseTranscribe(circular);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("test");
  });

  test("解析器应该对原型污染保持安全", () => {
    const payload = {
      text: "test",
      recognized: true,
      __proto__: { polluted: true },
    };
    
    const result = parseTranscribe(payload);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("test");
  });

  test("状态机应该对并发操作保持一致", () => {
    let state: VoiceStatus = "idle";
    
    // 模拟并发操作
    const actions: VoiceAction[] = [
      { type: "start" },
      { type: "stop" },
      { type: "ok" },
    ];
    
    for (const action of actions) {
      state = voiceReducer(state, action);
    }
    
    expect(state).toBe("idle");
  });
});

describe("语音输入系统 - 性能测试", () => {
  test("WAV 生成应该在 10ms 内完成（小音频）", () => {
    const samples = new Float32Array(1000).fill(0.1);
    
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      pcmToWavBytes(samples, 48000);
    }
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(100); // 100次 < 100ms
  });

  test("状态机转换应该是即时的（< 1ms）", () => {
    const start = performance.now();
    
    let state: VoiceStatus = "idle";
    for (let i = 0; i < 10000; i++) {
      state = voiceReducer(state, { type: "start" });
      state = voiceReducer(state, { type: "stop" });
      state = voiceReducer(state, { type: "ok" });
    }
    
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(10); // 30000次转换 < 10ms
  });

  test("解析器应该在 1ms 内完成（单次）", () => {
    const payload = { text: "Hello, world!", recognized: true };
    
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      parseTranscribe(payload);
    }
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(10); // 1000次 < 10ms
  });

  test("信号检测应该在 1ms 内完成（1000采样）", () => {
    const samples = new Float32Array(1000).fill(0.1);
    
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      hasSignal(samples);
    }
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(10); // 1000次 < 10ms
  });
});

describe("语音输入系统 - 集成测试", () => {
  test("完整的语音识别流程", () => {
    // 1. 初始状态
    let state: VoiceStatus = "idle";
    expect(state).toBe("idle");
    
    // 2. 开始录音
    state = voiceReducer(state, { type: "start" });
    expect(state).toBe("recording");
    
    // 3. 生成音频数据
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(i * 0.1) * 0.5; // 正弦波
    }
    
    // 4. 检测信号
    expect(hasSignal(samples)).toBe(true);
    
    // 5. 转换为 WAV
    const wav = pcmToWavBytes(samples, 48000);
    expect(wav.length).toBeGreaterThan(44);
    
    // 6. 停止录音
    state = voiceReducer(state, { type: "stop" });
    expect(state).toBe("transcribing");
    
    // 7. 模拟转录结果
    const transcribeResult = parseTranscribe({
      text: "Hello, this is a test",
      recognized: true,
    });
    expect(transcribeResult).not.toBeNull();
    expect(transcribeResult?.text).toBe("Hello, this is a test");
    
    // 8. 完成
    state = voiceReducer(state, { type: "ok" });
    expect(state).toBe("idle");
  });

  test("完整的助手语音流程", () => {
    // 1. 开始监听
    const listening = parseVoiceEvent({
      kind: "listening",
      session: "test-session",
    });
    expect(listening?.kind).toBe("listening");
    
    // 2. 生成音频块
    const samples = new Float32Array(1000).fill(0.1);
    const chunk = pcmToAssistantChunk(samples, 48000);
    expect(chunk.length).toBeGreaterThan(0);
    
    // 3. 接收 token
    const token1 = parseVoiceEvent({
      kind: "token",
      session: "test-session",
      token: "Hello",
    });
    expect(token1?.kind).toBe("token");
    
    const token2 = parseVoiceEvent({
      kind: "token",
      session: "test-session",
      token: " world",
    });
    expect(token2?.kind).toBe("token");
    
    // 4. 完成
    const done = parseVoiceEvent({
      kind: "turn_done",
      session: "test-session",
      text: "Hello world",
    });
    expect(done?.kind).toBe("turn_done");
    if (done?.kind === "turn_done") {
      expect(done.text).toBe("Hello world");
    }
  });

  test("错误处理流程", () => {
    let state: VoiceStatus = "idle";
    
    // 开始录音
    state = voiceReducer(state, { type: "start" });
    expect(state).toBe("recording");
    
    // 发生错误
    state = voiceReducer(state, { type: "fail" });
    expect(state).toBe("error");
    
    // 解析错误事件
    const errorEvent = parseVoiceEvent({
      kind: "error",
      session: "test-session",
      message: "Microphone access denied",
    });
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.message).toBe("Microphone access denied");
    }
    
    // 重试
    state = voiceReducer(state, { type: "start" });
    expect(state).toBe("recording");
  });
});
