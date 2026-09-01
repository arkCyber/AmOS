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

    return A.appShell("时钟", A.el("div", null, [clock, date, list]));
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
  },
});
