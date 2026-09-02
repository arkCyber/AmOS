// Amos app: 音乐 — store-backed playlist + Web Audio synthesis player.
// Plays a short synthesized melody per track (no external audio files); falls
// back to a silent progress simulation when no AudioContext is available.
window.Amos.register({
  id: "music",
  name: "音乐",
  icon: "🎵",
  gradient: ["#fa2d48", "#d90b32"],
  render() {
    const A = window.Amos;
    const self = this; // app object, so onUnmount can clear the progress timer
    const KEY = "amos.music";
    const SEEDS = [
      { id: "m1", title: "晨光", artist: "Amos 合成器" },
      { id: "m2", title: "星河", artist: "Amos 合成器" },
      { id: "m3", title: "晚风", artist: "Amos 合成器" },
    ];
    const read = () => { try { const m = JSON.parse(A.safeGet(KEY, "[]")); return Array.isArray(m) ? m : []; } catch (_) { return []; } };
    const write = (list) => A.storeWrite(KEY, JSON.stringify(list));
    if (!read().length) write(SEEDS);

    const DURATION = 24; // demo seconds per track
    let index = 0;
    let playing = false;
    let timer = null;
    let progress = 0;

    // ---- Now-playing header ----
    const cover = A.el("div", { style: { width: "140px", height: "140px", borderRadius: "16px", margin: "16px auto", background: "linear-gradient(145deg,#ff5e62,#ff9966)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "54px" } }, "🎧");
    const titleEl = A.el("div", { style: { textAlign: "center", fontSize: "18px", fontWeight: "600" } }, "");
    const artistEl = A.el("div", { class: "muted", style: { textAlign: "center", marginBottom: "8px" } }, "");
    const status = A.el("div", { class: "muted", style: { textAlign: "center", fontSize: "11px", minHeight: "14px" } }, "");

    const progressBar = A.el("div", { style: { height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.15)", overflow: "hidden", margin: "6px 12px 2px" } });
    const progressFill = A.el("div", { style: { height: "100%", width: "0%", background: "var(--accent)" } });
    progressBar.appendChild(progressFill);

    const list = A.el("div", { style: { marginTop: "10px" } });

    // ---- Web Audio synthesis (C major pentatonic arpeggio per track) ----
    let ctx = null;
    function ensureCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      return ctx;
    }
    const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
    function seedFromTitle(t) {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 997;
      return SCALE[h % SCALE.length];
    }
    function note(freq, t, dur) {
      const ac = ensureCtx();
      if (!ac) return;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t);
      o.stop(t + dur);
    }
    function playMelody(base) {
      const ac = ensureCtx();
      if (!ac) { status.textContent = "当前环境无音频引擎 · 模拟播放"; return; }
      const seq = [0, 3, 4, 7, 5, 4, 2, 0];
      const t0 = ac.currentTime + 0.05;
      seq.forEach((s, i) => note(base * Math.pow(2, s / 12), t0 + i * 0.28, 0.24));
    }

    function renderNow(track) {
      titleEl.textContent = track.title;
      artistEl.textContent = track.artist;
    }
    function renderList() {
      list.innerHTML = "";
      read().forEach((tr, i) => list.appendChild(A.el("div", {
        class: "card row",
        style: { cursor: "pointer", border: i === index ? "1px solid var(--accent)" : undefined },
        onclick: () => select(i),
      }, [
        A.el("span", { style: { fontSize: "20px" } }, i === index ? "▶️" : "🎵"),
        A.el("div", { style: { flex: "1" } }, [A.el("div", null, tr.title), A.el("div", { class: "muted" }, tr.artist)]),
      ])));
    }

    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
    function startTimer() {
      stopTimer();
      progress = 0;
      timer = setInterval(() => {
        progress += 0.25;
        progressFill.style.width = Math.min(100, (progress / DURATION) * 100) + "%";
        status.textContent = `${Math.floor(progress)}s / ${DURATION}s`;
        if (progress >= DURATION) next();
      }, 250);
      self._timer = timer;
    }

    function select(i) {
      const tracks = read();
      if (!tracks.length) return;
      index = ((i % tracks.length) + tracks.length) % tracks.length;
      const tr = tracks[index];
      renderNow(tr);
      renderList();
      playMelody(seedFromTitle(tr.title));
      playing = true;
      startTimer();
      playBtn.textContent = "⏸";
      if (status.textContent.indexOf("s /") < 0) status.textContent = "正在播放…";
    }
    function toggle() {
      if (playing) { playing = false; stopTimer(); playBtn.textContent = "▶"; status.textContent = "已暂停"; }
      else select(index);
    }
    function next() { select(index + 1); }
    function prev() { select(index - 1); }

    const tracks0 = read();
    renderNow(tracks0[0] || { title: "无曲目", artist: "" });
    renderList();
    const playBtn = A.el("button", {
      class: "ctl-play",
      style: { display: "block", margin: "10px auto", width: "64px", height: "64px", borderRadius: "50%", border: "0", fontSize: "24px", cursor: "pointer", background: "var(--accent)", color: "#fff" },
      onclick: toggle,
    }, "▶");

    const prevBtn = A.el("button", { class: "btn secondary ctl-prev", onclick: prev }, "⏮");
    const nextBtn = A.el("button", { class: "btn secondary ctl-next", onclick: next }, "⏭");

    const controls = A.el("div", { class: "row", style: { justifyContent: "center", gap: "12px", margin: "8px 0" } }, [prevBtn, playBtn, nextBtn]);

    return A.appShell("音乐", A.el("div", { style: { paddingTop: "4px" } }, [cover, titleEl, artistEl, progressBar, status, controls, list]));
  },
  onUnmount() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },
});


