// Amos app: 地图 — OpenStreetMap tile map with geolocation, city search, zoom,
// and an offline placeholder fallback (no external JS lib needed).
window.Amos.register({
  id: "maps",
  name: "地图",
  icon: "🗺️",
  gradient: ["#34c759", "#1f9d4a"],
  render() {
    const A = window.Amos;
    const PLACES = {
      "北京": [39.9042, 116.4074], "上海": [31.2304, 121.4737], "广州": [23.1291, 113.2644],
      "深圳": [22.5431, 114.0579], "成都": [30.5728, 104.0668], "杭州": [30.2741, 120.1551],
    };
    let center = [39.9042, 116.4074];
    let zoom = 12;
    const online = typeof navigator === "undefined" || navigator.onLine !== false;

    const status = A.el("div", { class: "muted", style: { textAlign: "center", padding: "8px 0" } }, "在线地图（OpenStreetMap）· 北京");
    const mapBox = A.el("div", { style: { height: "260px", borderRadius: "14px", overflow: "hidden", position: "relative", background: "#dfe6e9" } });
    const search = A.el("input", { class: "field", placeholder: "搜索城市：北京/上海/广州/深圳/成都/杭州", style: { margin: "12px 0" } });

    // Slippy-map tile math (no external lib).
    function latLonToTile(lat, lon, z) {
      const n = Math.pow(2, z);
      const x = ((lon + 180) / 360) * n;
      const latRad = (lat * Math.PI) / 180;
      const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
      return { x, y };
    }

    function markerAtCenter() {
      return A.el("div", { style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-100%)", fontSize: "26px" } }, "📍");
    }

    function renderMap() {
      mapBox.innerHTML = "";
      const z = zoom;
      const px = 256;
      const span = 3;
      const { x, y } = latLonToTile(center[0], center[1], z);
      const tx = Math.floor(x), ty = Math.floor(y);
      const offX = Math.round((x - tx) * px);
      const offY = Math.round((y - ty) * px);

      if (!online) {
        mapBox.appendChild(A.el("div", { style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "40px", background: "linear-gradient(180deg,#a8e063,#56ab2f)" } }, "🗺️ 离线地图"));
        mapBox.appendChild(markerAtCenter());
        return;
      }

      const wrap = A.el("div", {
        style: {
          position: "absolute", width: `${span * px}px`, height: `${span * px}px`,
          left: `-${Math.floor(span / 2) * px - offX}px`, top: `-${Math.floor(span / 2) * px - offY}px`,
        },
      });
      for (let dy = 0; dy < span; dy++) {
        for (let dx = 0; dx < span; dx++) {
          const t = A.el("img", { alt: "", style: { position: "absolute", left: `${dx * px}px`, top: `${dy * px}px`, width: `${px}px`, height: `${px}px` } });
          t.setAttribute("src", `https://tile.openstreetmap.org/${z}/${tx + dx - 1}/${ty + dy - 1}.png`);
          wrap.appendChild(t);
        }
      }
      mapBox.appendChild(wrap);
      mapBox.appendChild(markerAtCenter());
    }

    function setCenter(c, label) {
      center = c;
      renderMap();
      if (label) status.textContent = `在线地图（OpenStreetMap）· ${label}`;
    }

    const locateBtn = A.el("button", { class: "btn secondary", onclick: () => {
      if (typeof navigator === "undefined" || !navigator.geolocation) { status.textContent = "定位不可用（当前环境无 GPS）"; return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        center = [pos.coords.latitude, pos.coords.longitude];
        zoom = 13;
        renderMap();
        status.textContent = `定位成功 · ${center[0].toFixed(4)}, ${center[1].toFixed(4)}`;
      }, () => { status.textContent = "无法获取定位"; });
    } }, "📍 定位");

    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const hit = PLACES[search.value.trim()];
        if (hit) setCenter(hit, search.value.trim());
        else status.textContent = "未找到该城市";
      }
    });

    const zoomIn = A.el("button", { class: "btn secondary", onclick: () => { zoom = Math.min(zoom + 1, 18); renderMap(); } }, "+");
    const zoomOut = A.el("button", { class: "btn secondary", onclick: () => { zoom = Math.max(zoom - 1, 3); renderMap(); } }, "−");

    renderMap();
    return A.appShell("地图", A.el("div", null, [
      status,
      A.el("div", { class: "row", style: { gap: "8px" } }, [locateBtn, zoomOut, zoomIn]),
      mapBox,
      search,
    ]));
  },
});

