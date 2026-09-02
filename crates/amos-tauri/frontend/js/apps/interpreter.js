// Amos app: 同传 (simultaneous interpretation).
// Drives the amos-int session over the Tauri bridge: capture mic (or type text),
// stream PCM via window.AmosInterp, render live partials + translated finals,
// and speak the translation via window.AmosTts.

(function () {
  const A = window.Amos;
  let mounted = false;
  let sessionId = null;
  let started = false;
  let paused = false;
  let mic = null; // { ctx, src, node, stream }
  let recording = false;
  let livePartial = null; // element showing the current partial
  let prevOnOutput = null;

  const LANGS = [
    ["auto", "自动检测"],
    ["zh", "中文"],
    ["en", "English"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["fr", "Français"],
    ["es", "Español"],
  ];

  function el(id) { return document.getElementById(id); }

  function status(text) {
    const s = el("interp-status");
    if (s) s.textContent = text;
  }

  // Reflect whether a session is running across all control buttons.
  function setControls(running) {
    const st = el("interp-start"), stop = el("interp-stop"),
      p = el("interp-pause"), m = el("interp-mic");
    if (st) st.disabled = running;
    if (stop) stop.disabled = !running;
    if (p) { p.disabled = !running; p.textContent = paused ? "▶ 继续" : "⏸ 暂停"; }
    if (m) m.disabled = !running;
  }

  // ---- transcript rendering ----
  function addSegment(seg) {
    const log = el("interp-log");
    if (!log) return;
    if (livePartial) { if (livePartial.remove) livePartial.remove(); livePartial = null; }
    const row = A.el("div", { class: "interp-seg", style: { marginBottom: "10px" } }, [
      A.el("div", { style: { color: "#ddd", fontSize: "14px" } }, seg.source_text),
      A.el("div", { style: { color: "#6aa9ff", fontSize: "15px", marginTop: "2px" } }, seg.target_text),
      A.el("button", {
        class: "btn secondary", style: { marginTop: "6px", padding: "2px 10px", fontSize: "12px" },
        onclick: () => speak(seg.target_text, seg.target_lang),
      }, "🔊 朗读"),
    ]);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function showPartial(text) {
    const log = el("interp-log");
    if (!log) return;
    if (!livePartial) {
      livePartial = A.el("div", {
        class: "interp-partial", style: { color: "#aaa", fontStyle: "italic", marginBottom: "4px" },
      });
      log.appendChild(livePartial);
    }
    livePartial.textContent = "… " + text;
    log.scrollTop = log.scrollHeight;
  }

  // ---- TTS playback ----
  function playPcm(payload) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !payload || !payload.samples) return;
    const ctx = new Ctx();
    const buf = ctx.createBuffer(1, payload.samples.length, payload.sample_rate || 16000);
    buf.copyToChannel(Float32Array.from(payload.samples), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
  }

  function speak(text, lang) {
    const I = window.__TAURI_INTERNALS__;
    if (!I || !window.AmosTts) return;
    window.AmosTts.synthesize(text, { lang: lang || "zh" })
      .then((p) => { if (p) playPcm(p); })
      .catch(() => {});
  }

  // Whether auto-read-aloud is enabled (reads the checkbox in the UI).
  function autoSpeakEnabled() {
    const c = el("interp-autospeak");
    return !!(c && c.checked);
  }

  // ---- session controls ----
  async function startSession() {
    const I = window.__TAURI_INTERNALS__;
    if (!I) { status("非 Tauri 环境 · 同传不可用"); return; }
    const src = el("interp-source").value;
    const tgt = el("interp-target").value;
    status("正在启动会话…");
    try {
      sessionId = await window.AmosInterp.start({ source: src, target: tgt });
      started = true;
      paused = false;
      status(`会话已启动 (${src || "auto"} → ${tgt})`);
      setControls(true);
    } catch (e) {
      status("启动失败：" + e);
    }
  }

  async function stopSession() {
    if (stopMic()) recording = false;
    try { if (sessionId != null) await window.AmosInterp.stop(); } catch (_) {}
    started = false;
    paused = false;
    sessionId = null;
    status("会话已结束");
    setControls(false);
  }

  async function togglePause() {
    try {
      if (paused) { await window.AmosInterp.resume(); paused = false; }
      else { await window.AmosInterp.pause(); paused = true; }
      const b = el("interp-pause");
      if (b) b.textContent = paused ? "▶ 继续" : "⏸ 暂停";
      status(paused ? "已暂停" : "已继续");
    } catch (_) {}
  }

  async function sendText() {
    const input = el("interp-input");
    const text = (input && input.value.trim()) || "";
    if (!text || !started) return;
    if (input) input.value = "";
    try { await window.AmosInterp.text(text); } catch (e) { status("发送失败：" + e); }
  }

  // ---- mic capture -> 16k mono f32 chunks -> AmosInterp.audio ----
  function startMic() {
    const I = window.__TAURI_INTERNALS__;
    if (!I || !started) return;
    const MD = navigator.mediaDevices;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!MD || !MD.getUserMedia || !Ctx) { status("此环境不支持麦克风采集"); return; }
    const ctx = new Ctx();
    const node = ctx.createScriptProcessor(4096, 1, 1);
    let pending = [];
    const targetRate = 16000;

    node.onaudioprocess = (ev) => {
      const data = ev.inputBuffer.getChannelData(0);
      const ratio = ctx.sampleRate / targetRate;
      const out = new Float32Array(Math.floor(data.length / ratio));
      for (let i = 0; i < out.length; i++) out[i] = data[Math.floor(i * ratio)];
      pending.push(out);
      // Feed ~10 ms chunks (160 samples) as they accumulate.
      while (pending.reduce((a, b) => a + b.length, 0) >= 160) {
        let chunk = [];
        while (chunk.length < 160 && pending.length) {
          const head = pending[0];
          const need = 160 - chunk.length;
          if (head.length <= need) { chunk.push(...head); pending.shift(); }
          else { chunk.push(...head.slice(0, need)); pending[0] = head.slice(need); }
        }
        window.AmosInterp.audio(Float32Array.from(chunk)).catch(() => {});
      }
    };

    MD.getUserMedia({ audio: true }).then((stream) => {
      const src = ctx.createMediaStreamSource(stream);
      src.connect(node);
      // NOTE: do NOT connect node → ctx.destination; that would route the mic
      // to the speakers (echo). The ScriptProcessor still runs unconnected.
      mic = { ctx, src, node, stream };
      recording = true;
      status("🎤 正在录音… 松开结束");
      const b = el("interp-mic");
      if (b) b.textContent = "⏹ 停止录音";
    }).catch((e) => { status("麦克风不可用：" + e); });
  }

  function stopMic() {
    if (!mic) return false;
    try { mic.node.disconnect(); mic.src.disconnect(); mic.stream.getTracks().forEach((t) => t.stop()); }
    catch (_) {}
    try { mic.ctx.close(); } catch (_) {}
    mic = null;
    recording = false;
    if (started && sessionId != null) window.AmosInterp.endOfSpeech().catch(() => {});
    const b = el("interp-mic");
    if (b) b.textContent = "🎤 说话";
    return true;
  }

  const api = {
    get mounted() { return mounted; },
    startSession, stopSession, togglePause, sendText, startMic, stopMic,
  };

  A.register({
    id: "interpreter",
    name: "同传",
    icon: "🌐",
    gradient: ["#0a84ff", "#5e5ce6"],
    render() {
      const statusEl = A.el("span", { id: "interp-status", class: "muted", style: { fontSize: "11px" } }, "同传未启动");
      const source = A.el("select", { id: "interp-source", class: "field" });
      const target = A.el("select", { id: "interp-target", class: "field" });
      LANGS.forEach(([v, label]) => source.appendChild(A.el("option", { value: v }, label)));
      LANGS.forEach(([v, label]) => target.appendChild(A.el("option", { value: v }, label)));
      target.value = "zh";

      const startBtn = A.el("button", { id: "interp-start", class: "btn", onclick: () => api.startSession() }, "▶ 开始");
      const stopBtn = A.el("button", { id: "interp-stop", class: "btn secondary", disabled: true, onclick: () => api.stopSession() }, "⏹ 结束");
      const pauseBtn = A.el("button", { id: "interp-pause", class: "btn secondary", disabled: true, onclick: () => api.togglePause() }, "⏸ 暂停");
      const micBtn = A.el("button", { id: "interp-mic", class: "btn secondary", disabled: true, onclick: () => (recording ? api.stopMic() : api.startMic()) }, "🎤 说话");

      const log = A.el("div", {
        id: "interp-log",
        style: { flex: "1", overflowY: "auto", minHeight: "0", padding: "4px 2px 12px" },
      });
      const input = A.el("input", { id: "interp-input", class: "field", placeholder: "输入要翻译的文本…" });
      const sendBtn = A.el("button", { id: "interp-send", class: "btn", onclick: () => api.sendText() }, "发送");
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") api.sendText(); });

      const langs = A.el("div", { class: "row", style: { gap: "8px", marginBottom: "8px" } }, [source, A.el("span", { style: { color: "#888" } }, "→"), target]);
      const controls = A.el("div", { class: "row", style: { gap: "8px", marginBottom: "8px" } }, [startBtn, pauseBtn, stopBtn, micBtn]);
      const autoSpeak = A.el("label", { class: "muted", style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" } }, [
        A.el("input", { id: "interp-autospeak", type: "checkbox" }),
        "🔊 自动朗读译文",
      ]);
      const inputRow = A.el("div", { class: "row", style: { marginTop: "8px" } }, [input, sendBtn]);

      const body = A.el("div", {
        style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0" },
      }, [
        A.el("div", { class: "row spread", style: { marginBottom: "6px" } }, [statusEl]),
        langs,
        controls,
        autoSpeak,
        log,
        inputRow,
      ]);

      return A.appShell("同声传译", body);
    },
    onMount() {
      mounted = true;
      prevOnOutput = window.AmosInterp && window.AmosInterp.onOutput;
      if (window.AmosInterp) {
        window.AmosInterp.onOutput = (payload) => {
          if (!mounted) return;
          if (payload && payload.kind === "partial") showPartial(payload.text);
          else if (payload && payload.kind === "segment_final") {
            addSegment(payload);
            if (autoSpeakEnabled()) speak(payload.target_text, payload.target_lang);
          }
          else if (payload && payload.kind === "session_ended") status("会话已结束");
          else if (payload && payload.kind === "error") status("错误：" + payload.message);
        };
      }
      const I = window.__TAURI_INTERNALS__;
      if (!I) { status("非 Tauri 环境 · 同传不可用"); return; }
      status("就绪 — 点击「开始」后即可说话/输入");
      // If a session is already running in the bridge (e.g. this app was
      // reopened), restore its state so the controls reflect it.
      window.AmosInterp.status().then((st) => {
        if (!mounted) return;
        if (st && st.session_id) {
          started = true;
          paused = st.state === "paused";
          sessionId = st.session_id;
          status(`会话运行中 (${st.source || "auto"} → ${st.target || "zh"}) · ${st.state}`);
          setControls(true);
        }
      }).catch(() => {});
    },
    onUnmount() {
      mounted = false;
      if (recording) stopMic();
      if (window.AmosInterp) window.AmosInterp.onOutput = prevOnOutput || (() => {});
    },
  });
})();

