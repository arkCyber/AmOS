// Amos app: 时钟 (live clock + world clocks)
window.Amos.register({
  id: "clock",
  name: "时钟",
  icon: "🕐",
  gradient: ["#111", "#333"],
  render() {
    const A = window.Amos;
    const clock = A.el("div", {
      style: { textAlign: "center", fontSize: "64px", fontWeight: "200", padding: "24px 0 4px" },
    }, "00:00:00");
    const date = A.el("div", { style: { textAlign: "center", color: "rgba(255,255,255,0.7)", marginBottom: "18px" } }, "");
    const list = A.el("div", null);

    const zones = [
      { city: "北京", tz: "Asia/Shanghai" },
      { city: "纽约", tz: "America/New_York" },
      { city: "伦敦", tz: "Europe/London" },
      { city: "东京", tz: "Asia/Tokyo" },
      { city: "悉尼", tz: "Australia/Sydney" },
    ];
    const fmt = (t) => {
      const p = (n) => String(n).padStart(2, "0");
      return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    };
    const fmtDate = (t) =>
      `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${"日一二三四五六"[t.getDay()]}`;

    const tick = () => {
      const now = new Date();
      clock.textContent = fmt(now);
      date.textContent = fmtDate(now);
      list.innerHTML = "";
      zones.forEach((z) => {
        const s = new Date(now.toLocaleString("en-US", { timeZone: z.tz }));
        list.appendChild(A.el("div", { class: "card row spread" }, [
          A.el("span", null, z.city),
          A.el("span", { style: { fontSize: "22px", fontWeight: "600" } }, fmt(s)),
        ]));
      });
    };

    // Store the ticking logic so onMount can drive it against the live DOM.
    this._clockTick = tick;

    // ---- 秒表 (Stopwatch) — aligns iPhone Clock ▶⏸ 复位 / 记圈 ----
    const swDisp = A.el("div", {
      class: "sw-disp",
      style: { textAlign: "center", fontSize: "46px", fontWeight: "200", fontVariantNumeric: "tabular-nums", padding: "6px 0 2px" },
    }, "00:00.00");
    const swLaps = A.el("div", { style: { marginTop: "6px" } });
    const swStartBtn = A.el("button", { class: "btn sw-start", onclick: () => swStartStop() }, "开始");
    const swResetBtn = A.el("button", { class: "btn secondary", onclick: () => swReset() }, "复位");
    const swLapBtn = A.el("button", { class: "btn secondary", onclick: () => swAddLap() }, "记圈");
    swResetBtn.disabled = true; // disabled until a session stops
    swLapBtn.disabled = true;   // laps only while running
    let swRunning = false, swBase = 0, swT0 = null;

    const p2 = (n) => String(n).padStart(2, "0");
    const swFmt = (ms) => {
      const c = Math.floor(ms / 10) % 100, s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000);
      return `${p2(m)}:${p2(s)}.${p2(c)}`;
    };
    // Elapsed = wall-clock difference since start, added to the paused baseline.
    const swAcc = () => (swRunning && swT0 != null ? swBase + (Date.now() - swT0) : swBase);
    const swRender = () => { swDisp.textContent = swFmt(swAcc()); };

    let swTimer = null;
    const ensureSw = () => { if (!swTimer) { swTimer = setInterval(() => swRender(), 33); this._swTimer = swTimer; } };
    const stopSw = () => { if (swTimer) { clearInterval(swTimer); swTimer = null; this._swTimer = null; } };

    const swStartStop = () => {
      if (swRunning) {
        swBase = swAcc(); swRunning = false; swT0 = null;
        swStartBtn.textContent = "开始"; stopSw();
      } else {
        swBase = swAcc(); swT0 = Date.now(); swRunning = true;
        swStartBtn.textContent = "暂停"; ensureSw();
      }
      swResetBtn.disabled = swRunning; swLapBtn.disabled = !swRunning;
      swRender();
    };
    const swReset = () => {
      if (swRunning) return; // Apple keeps 复位 disabled while running
      swBase = 0; swRunning = false; swT0 = null;
      swStartBtn.textContent = "开始"; swResetBtn.disabled = true; swLapBtn.disabled = true;
      swLaps.innerHTML = ""; swRender();
    };
    const swAddLap = () => {
      if (!swRunning) return;
      const v = swAcc();
      swLaps.appendChild(A.el("div", { class: "card row spread" }, [
        A.el("span", { class: "muted" }, `圈 ${swLaps.children.length + 1}`),
        A.el("span", { style: { fontVariantNumeric: "tabular-nums" } }, swFmt(v)),
      ]));
      swRender();
    };

    const swCard = A.el("div", { class: "card" }, [
      A.el("div", { class: "row spread" }, [
        A.el("span", { style: { fontWeight: "600" } }, "秒表"),
        A.el("span", { class: "muted", style: { fontSize: "11px" } }, "iPhone 时钟风格"),
      ]),
      swDisp,
      A.el("div", { class: "row", style: { justifyContent: "center", gap: "10px", marginTop: "2px" } }, [swLapBtn, swStartBtn, swResetBtn]),
      swLaps,
    ]);

    return A.appShell("时钟", A.el("div", null, [clock, date, list, swCard]));
  },
  onMount() {
    this._clockTick();
    this._clockTimer = setInterval(this._clockTick, 1000);
  },
  onUnmount() {
    if (this._clockTimer) {
      clearInterval(this._clockTimer);
      this._clockTimer = null;
    }
    if (this._swTimer) {
      clearInterval(this._swTimer);
      this._swTimer = null;
    }
  },
});
