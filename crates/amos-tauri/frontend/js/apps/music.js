// Amos app: 音乐 (mock player)
window.Amos.register({
  id: "music",
  name: "音乐",
  icon: "🎵",
  gradient: ["#fa2d48", "#d90b32"],
  render() {
    const A = window.Amos;
    const tracks = [
      { title: "晨光", artist: "Amos Studio", len: 214 },
      { title: "城市夜行", artist: "Neo Wave", len: 187 },
      { title: "深空漫游", artist: "Orbital", len: 256 },
      { title: "雨声白噪音", artist: "Nature", len: 360 },
    ];
    let idx = 0;
    let playing = false;

    const cover = A.el("div", {
      style: {
        width: "150px", height: "150px", borderRadius: "16px", margin: "20px auto",
        background: "linear-gradient(145deg,#ff5e62,#ff9966)",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: "60px",
      },
    }, "🎧");
    const title = A.el("div", { style: { textAlign: "center", fontSize: "18px", fontWeight: "600" } }, tracks[0].title);
    const artist = A.el("div", { class: "muted", style: { textAlign: "center", marginBottom: "16px" } }, tracks[0].artist);
    const progress = A.el("div", { class: "muted", style: { textAlign: "center" } }, "0:00 / 3:34");
    const playBtn = A.el("button", {
      class: "btn", style: { display: "block", margin: "12px auto", width: "64px", height: "64px", borderRadius: "50%", fontSize: "26px" },
    }, "▶");

    const stopTick = () => { if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; } };

    const next = () => {
      idx = (idx + 1) % tracks.length;
      title.textContent = tracks[idx].title;
      artist.textContent = tracks[idx].artist;
      progress.textContent = `0:00 / ${Math.floor(tracks[idx].len / 60)}:${String(tracks[idx].len % 60).padStart(2, "0")}`;
    };

    playBtn.onclick = () => {
      playing = !playing;
      playBtn.textContent = playing ? "⏸" : "▶";
      const t = tracks[idx];
      stopTick();
      if (playing) {
        let s = 0;
        this._musicTimer = setInterval(() => {
          s++;
          progress.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} / ${Math.floor(t.len / 60)}:${String(t.len % 60).padStart(2, "0")}`;
          if (s >= t.len) { stopTick(); next(); playing = false; playBtn.textContent = "▶"; }
        }, 1000);
      }
    };

    const nextBtn = A.el("button", { class: "btn secondary", style: { display: "block", margin: "0 auto" }, onclick: next }, "下一首 ⏭");

    return A.appShell("音乐", A.el("div", { style: { paddingTop: "8px" } }, [cover, title, artist, playBtn, nextBtn, progress]));
  },
  onUnmount() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
  },
});
