import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assistantVoiceEnd,
  assistantVoiceFeed,
  assistantVoiceStart,
  assistantVoiceStop,
  bridged,
  bridgeDiag,
  cancelAiSession,
  conversationId,
  getAiStatus,
  listSessions,
  clearSessions,
  removeSession,
  getSessionHistory,
  getAndroidAppIcon,
  getAndroidApps,
  interpretAudio,
  interpretPause,
  interpretResume,
  interpretStart,
  interpretStop,
  interpretText,
  invoke,
  launchAndroidApp,
  mailDelete,
  mailInbox,
  mailList,
  mailMailboxes,
  mailMove,
  mailRead,
  mailSearch,
  mailSend,
  mailSetFlagged,
  mailSetSeen,
  cancelNativeAlarm,
  exportTxtFile,
  pollNativeAlarms,
  registerNativeAlarm,
  sendChat,
  storeBundleResource,
  storeBundleUri,
  storeCatalog,
  storeFind,
  storeInstall,
  storeInstalled,
  storeSearch,
  storeStatus,
  storeUninstall,
  storeUpdatable,
  storeUpgrade,
  subscribe,
  systemStoreSnapshot,
  flashlightSet,
  flashlightStatus,
  radioSet,
  radioStatus,
  realDial,
  telephonyAnswer,
  telephonyDial,
  telephonyEnd,
  telephonySimulateIncoming,
  telephonyStartRecording,
  telephonyStatus,
  telephonyStopRecording,
  termKill,
  termRead,
  termResize,
  termSpawn,
  termWrite,
  transcribeAudio,
  translateText,
  ttsSynthesize,
} from "../lib/backend";

let realWindow: unknown;

function setWindow(obj: Record<string, unknown>) {
  (globalThis as { window?: unknown }).window = obj;
}

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("backend bridge", () => {
  test("degrades gracefully outside Tauri", async () => {
    setWindow({ localStorage: new Map() as unknown as Storage });
    expect(bridged()).toBe(false);
    expect(await invoke("get_status")).toBeNull();
    expect(await sendChat("hi", "s")).toBeNull();
    expect(await getAiStatus()).toBeNull();
    const un = await subscribe("x", () => {});
    un();
    expect(conversationId().length).toBeGreaterThan(0);
  });

  test("calls Tauri commands when bridged", async () => {
    const calls: string[] = [];
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    const fake = {
      invoke: async (c: string) => {
        calls.push(c);
        if (c === "get_status") return { model: "ggml", active_sessions: 1 };
        return { ok: true };
      },
      listen: async (ch: string, h: (e: { payload: unknown }) => void) => {
        handlers[ch] = h;
        return async () => {};
      },
    };
    const store = new Map<string, string>();
    setWindow({ __TAURI_INTERNALS__: fake, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    expect(bridged()).toBe(true);
    const status = await getAiStatus();
    expect(status?.model).toBe("ggml");
    await sendChat("hello", "conv-1");
    expect(calls).toContain("chat_agent");
    const un = await subscribe("ai-token-received", () => {});
    un();
    expect(typeof handlers["ai-token-received"]).toBe("function");
  });

  test("records structured diagnostics instead of losing failure root cause", async () => {
    // Not bridged → classified as such.
    setWindow({ localStorage: new Map() as unknown as Storage });
    expect(await invoke("get_status")).toBeNull();
    expect(bridgeDiag()).toEqual({ ok: false, kind: "not-bridged", command: "get_status" });

    // Bridged command that rejects → classified, root cause kept; still returns null.
    const store = new Map<string, string>();
    const failing = {
      invoke: async () => {
        throw new Error("daemon: model load failed");
      },
      listen: async () => async () => {},
    };
    setWindow({
      __TAURI_INTERNALS__: failing,
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    expect(bridged()).toBe(true);
    expect(await invoke("chat_agent", { prompt: "hi", sessionId: "s", targetWindow: "ai" })).toBeNull();
    const diag = bridgeDiag();
    expect(diag.ok).toBe(false);
    if (!diag.ok) {
      expect(diag.kind).toBe("command-failed");
      expect(diag.command).toBe("chat_agent");
    }

    // A later success resets the diagnostic to ok.
    setWindow({
      __TAURI_INTERNALS__: { invoke: async () => ({ model: "ggml", active_sessions: 1 }), listen: async () => async () => {} },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    const status = await getAiStatus();
    expect(status?.model).toBe("ggml");
    expect(bridgeDiag()).toEqual({ ok: true });
  });

  test("interpret RPC sends start/audio/stop with correct args", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const fake = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        return cmd === "interpret_start" ? "sess-9" : { ok: true };
      },
      listen: async () => async () => {},
    };
    setWindow({ __TAURI_INTERNALS__: fake, localStorage: new Map() as unknown as Storage });
    const sid = await interpretStart({ source: "auto", target: "zh" });
    expect(sid).toBe("sess-9");
    await interpretAudio("sess-9", [1, 2, 3]);
    await interpretStop("sess-9");
    expect(calls.map((c) => c.cmd)).toEqual(["interpret_start", "interpret_audio", "interpret_stop"]);
    expect(calls[0]!.args.source_lang).toBe("auto");
    expect(calls[1]!.args.sessionId).toBe("sess-9");
    expect(calls[1]!.args.chunk).toEqual([1, 2, 3]);
  });

  test("thin wrappers route to the expected daemon commands", async () => {
    const calls: string[] = [];
    const fake = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
      listen: async () => async () => {},
    };
    const store = new Map<string, string>();
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    expect(bridged()).toBe(true);

    await cancelAiSession();
    await listSessions();
    await clearSessions();
    await removeSession("s1");
    await getSessionHistory("s1");
    await interpretText("s1", "hi");
    await interpretPause("s1");
    await interpretResume("s1");
    await ttsSynthesize("你好", "zh");
    await transcribeAudio([0, 1, 2], { language: "zh" });
    await translateText("hi", { sourceLang: "en", targetLang: "zh" });
    await getAndroidApps();
    await launchAndroidApp("com.tencent.mm");
    await getAndroidAppIcon("com.tencent.mm");

    for (const cmd of [
      "cancel_ai_session",
      "get_ai_sessions",
      "clear_ai_sessions",
      "remove_ai_session",
      "get_ai_session_history",
      "interpret_text",
      "interpret_pause",
      "interpret_resume",
      "tts_synthesize",
      "transcribe_audio",
      "translate_text",
      "get_android_apps",
      "launch_android_app",
      "get_android_app_icon",
    ]) {
      expect(calls, `expected ${cmd} to be routed`).toContain(cmd);
    }
  });

  test("mail / appstore / native-alarm thin wrappers route to their daemon commands", async () => {
    const calls: string[] = [];
    const fake = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
      listen: async () => async () => {},
    };
    const store = new Map<string, string>();
    setWindow({
      __TAURI_INTERNALS__: fake,
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    expect(bridged()).toBe(true);

    // Mail RPC wrappers (both cc-present and cc-absent shapes of mailSend).
    await mailMailboxes();
    await mailList("INBOX", 10);
    await mailSearch("INBOX", "hello");
    await mailInbox();
    await mailRead("INBOX", "m1");
    await mailSend({ to: ["a@x.com"], subject: "s", body: "b" });
    await mailSend({ to: ["a@x.com"], subject: "s", body: "b", cc: ["c@x.com"] });
    await mailSetFlagged("INBOX", "m1", true);
    await mailSetSeen("INBOX", "m1", false);
    await mailDelete("INBOX", "m1");
    await mailMove("INBOX", "m1", "Archive");

    // App Store wrappers.
    await storeCatalog();
    await storeSearch("notes");
    await storeFind("app.amos.notes");
    await storeInstalled();
    await storeUpdatable();
    await storeStatus("app.amos.notes");
    await storeInstall("app.amos.notes");
    await storeUpgrade("app.amos.notes");
    await storeUninstall("app.amos.notes");
    await storeBundleResource("app.amos.notes", "index.html");
    await storeBundleUri("amos-app://app.amos.notes/index.html");

    // System store hydration + notes export + native-alarm bridge.
    await systemStoreSnapshot();
    await exportTxtFile("note", "hi");
    await registerNativeAlarm("a1", 1_000_000);
    await cancelNativeAlarm("a1");
    await pollNativeAlarms();

    // Telephony / radio / flashlight / terminal RPC wrappers.
    await telephonyDial("10086");
    await telephonyDial("110", true); // emergency path
    await realDial("10086"); // returns bool: invoke->null => false
    await telephonyEnd("c1");
    await telephonyAnswer("c1");
    await telephonySimulateIncoming("18812345678");
    await telephonyStatus();
    await telephonyStartRecording("c1");
    await telephonyStopRecording("c1");
    await radioStatus();
    await radioSet("airplane", true);
    await radioSet("wifi", false);
    await flashlightStatus();
    await flashlightSet(true);
    await termSpawn("/tmp", ["ls"]);
    await termWrite(1, "echo hi\n");
    await termRead(1);
    await termKill(1);
    await termResize(1, 120, 24);

    for (const cmd of [
      "mail_mailboxes", "mail_list", "mail_search", "mail_inbox", "mail_read",
      "mail_send", "mail_set_flagged", "mail_set_seen", "mail_delete", "mail_move",
      "appstore_catalog", "appstore_search", "appstore_find", "appstore_installed",
      "appstore_updatable", "appstore_status", "appstore_install", "appstore_upgrade",
      "appstore_uninstall", "appstore_bundle_resource", "appstore_bundle_uri",
      "store_snapshot", "notes_export_txt",
      "scheduler_alarm_register", "scheduler_alarm_cancel", "scheduler_alarm_poll",
      "telephony_dial", "real_dial", "telephony_end", "telephony_answer",
      "telephony_simulate_incoming", "telephony_status", "telephony_start_recording",
      "telephony_stop_recording",
      "radio_status", "radio_set", "flashlight_status", "flashlight_set",
      "term_spawn", "term_write", "term_read", "term_kill", "term_resize",
    ]) {
      expect(calls, `expected ${cmd} to be routed`).toContain(cmd);
    }
  });

  test("assistant voice wrappers route to start/feed/end/stop with correct args", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const fake = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args: args ?? {} });
        return { ok: true };
      },
      listen: async () => async () => {},
    };
    setWindow({ __TAURI_INTERNALS__: fake, localStorage: new Map() as unknown as Storage });

    await assistantVoiceStart("conv-v");
    await assistantVoiceFeed([1, 2, 3]);
    await assistantVoiceEnd();
    await assistantVoiceStop();

    expect(calls.map((c) => c.cmd)).toEqual([
      "assistant_voice_start",
      "assistant_voice_feed",
      "assistant_voice_end",
      "assistant_voice_stop",
    ]);
    expect(calls[0]!.args.sessionId).toBe("conv-v");
    expect(calls[1]!.args.frame).toEqual([1, 2, 3]);
  });
});
