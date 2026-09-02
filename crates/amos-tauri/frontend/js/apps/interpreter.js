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
  let meterEl = null; // the recording level-meter element (direct ref, no getElementById)

  const LANGS = [
    ["auto", "自动检测"],
    ["zh", "中文"],
    ["en", "English"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["fr", "Français"],
    ["es", "Español"],
  ];

  function langLabel(v) {
    const f = LANGS.find((x) => x[0] === v);
    return f ? f[1] : (v || "");
  }

  function el(id) { return document.getElementById(id); }

  // Remember the interpreter preferences (language pair + auto-speak) so
  // reopening the app feels continuous.
  function readPrefs() {
    try { return JSON.parse(A.safeGet("amos.interp", "{}")) || {}; } catch (_) { return {}; }
  }
  function persistPrefs() {
    try {
      A.storeWrite("amos.interp", JSON.stringify({
        source: el("interp-source") ? el("interp-source").value : "auto",
        target: el("interp-target") ? el("interp-target").value : "zh",
        autospeak: !!(el("interp-autospeak") && el("interp-autospeak").checked),
      }));
    } catch (_) {}
  }

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
    const src = A.el("div", {
      class: "interp-src",
      "data-lang": langLabel(seg.source_lang || "源"),
    }, seg.source_text);
    const tgt = A.el("div", {
      class: "interp-tgt",
      "data-lang": langLabel(seg.target_lang || "译"),
    }, seg.target_text);
    const speakBtn = A.el("button", {
      class: "btn secondary interp-act",
      onclick: () => speak(seg.target_text, seg.target_lang),
    }, "🔊 朗读");
    const copyBtn = A.el("button", {
      class: "btn secondary interp-act",
      onclick: () => copyText(seg.target_text),
    }, "📋 复制");
    const row = A.el("div", { class: "interp-seg" }, [src, tgt, speakBtn, copyBtn]);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function copyText(text) {
    if (!text) return;
    const nav = (typeof navigator !== "undefined") ? navigator : null;
    const done = () => status("已复制译文到剪贴板");
    if (nav && nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(text).then(done).catch(() => status("复制失败"));
    } else {
      status("当前环境不支持剪贴板");
    }
  }

  function clearLog() {
    const log = el("interp-log");
    if (!log) return;
    log.innerHTML = "";
    livePartial = null;
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

  // Lighting the level meter (0..1) while the mic is live.
  function setMeter(level) {
    if (!meterEl) return;
    const bars = (meterEl.children) ? Array.from(meterEl.children) : [];
    if (!bars.length) return;
    const on = Math.max(0, Math.min(bars.length, Math.round((level || 0) * bars.length)));
    bars.forEach((b, i) => b.classList && b.classList.toggle("on", i < on));
  }

  // Reflect the recording state across the mic button + level meter.
  function setRecUi(on) {
    const b = el("interp-mic");
    if (b) b.textContent = on ? "⏹ 停止录音" : "🎤 说话";
    if (b && b.classList) b.classList.toggle("rec", on);
    if (meterEl) meterEl.style.display = on ? "flex" : "none";
    if (!on) setMeter(0);
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
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = data.length ? Math.sqrt(sum / data.length) : 0;
      setMeter(Math.min(1, rms * 4));
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
      setRecUi(true);
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
    setRecUi(false);
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

      // Recording level meter (lit by setMeter while the mic is live).
      const meter = A.el("div", { id: "interp-meter", class: "interp-meter", style: { display: "none" } });
      for (let i = 0; i < 10; i++) meter.appendChild(A.el("span", { class: "meter-bar" }));
      meterEl = meter; // direct ref so setMeter/setRecUi work without getElementById

      const clearBtn = A.el("button", { id: "interp-clear", class: "btn secondary", onclick: () => clearLog() }, "🗑 清空");
      const inputRow = A.el("div", { class: "row", style: { marginTop: "8px" } }, [input, sendBtn]);

      const body = A.el("div", {
        style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0" },
      }, [
        A.el("div", { class: "interp-head row spread", style: { marginBottom: "8px" } }, [statusEl]),
        langs,
        controls,
        A.el("div", { class: "row", style: { gap: "10px", alignItems: "center", marginTop: "4px" } }, [meter, autoSpeak]),
        A.el("div", { class: "row spread", style: { marginTop: "8px", marginBottom: "2px" } }, [
          A.el("span", { class: "muted", style: { fontSize: "11px" } }, "译文记录"),
          clearBtn,
        ]),
        log,
        inputRow,
      ]);

      return A.appShell("同声传译", body);
    },
    onMount() {
      mounted = true;
      prevOnOutput = window.AmosInterp && window.AmosInterp.onOutput;
      // Restore saved preferences (language pair + auto-speak) and persist edits.
      const saved = readPrefs();
      const sSrc = el("interp-source"), sTgt = el("interp-target"), sAsp = el("interp-autospeak");
      if (sSrc) sSrc.value = (saved.source) || "auto";
      if (sTgt) sTgt.value = saved.target || "zh";
      if (sAsp && saved.autospeak) sAsp.checked = true;
      if (sSrc) sSrc.addEventListener("change", persistPrefs);
      if (sTgt) sTgt.addEventListener("change", persistPrefs);
      if (sAsp) sAsp.addEventListener("change", persistPrefs);
      if (window.AmosInterp) {
        window.AmosInterp.onOutput = (payload) => {
          if (!mounted) return;
          if (payload && payload.kind === "partial") showPartial(payload.text);
          else if (payload && payload.kind === "segment_final") {
            addSegment(payload);
            if (autoSpeakEnabled()) speak(payload.target_text, payload.target_lang);
          }
          else if (payload && payload.kind === "session_ended") { status("会话已结束"); setControls(false); setRecUi(false); }
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

