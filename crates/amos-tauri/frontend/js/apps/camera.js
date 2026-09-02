// Amos app: 相机 — real viewfinder via getUserMedia; captures save into the
// shared `amos.photos` album. Falls back to a demo viewfinder when no camera is
// available (offline / headless tests).
window.Amos.register({
  id: "camera",
  name: "相机",
  icon: "📷",
  gradient: ["#333", "#111"],
  render() {
    const A = window.Amos;
    const PHOTO_KEY = "amos.photos";
    const palette = [["#f94144", "#f3722c"], ["#f8961e", "#f9c74f"], ["#90be6d", "#43aa8b"], ["#00bbf9", "#00f5d4"], ["#9b5de5", "#f15bb5"]];

    const readPhotos = () => { try { const p = JSON.parse(A.safeGet(PHOTO_KEY, "[]")); return Array.isArray(p) ? p : []; } catch (_) { return []; } };
    const writePhotos = (list) => A.storeWrite(PHOTO_KEY, JSON.stringify(list));

    const hint = A.el("div", { class: "muted", style: { textAlign: "center", padding: "8px 0" } }, "正在启动相机…");
    const view = A.el("div", {
      style: { flex: "1", margin: "0 -14px", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" },
    });
    const video = A.el("video", { autoplay: "true", muted: "true", playsinline: "true", style: { width: "100%", height: "100%", objectFit: "cover", display: "none" } });
    const fallback = A.el("div", {
      style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "60px", background: "linear-gradient(160deg,#0f2027,#203a43 40%,#2c5364)" },
    }, "🏔️");
    view.appendChild(video);
    view.appendChild(fallback);

    const flash = A.el("div", { style: { position: "absolute", inset: 0, background: "#fff", opacity: "0", transition: "opacity 0.3s", pointerEvents: "none" } });
    view.appendChild(flash);

    let stream = null;
    let live = false; // true when a real camera stream is displayed

    function startCamera() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        hint.textContent = "当前环境无摄像头 · 使用演示取景器";
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then((s) => {
          stream = s;
          live = true;
          try { video.srcObject = s; } catch (_) {}
          video.style.display = "block";
          fallback.style.display = "none";
          hint.textContent = "摄像头已就绪 · 点击快门拍照";
        })
        .catch(() => { hint.textContent = "无法访问摄像头 · 使用演示取景器"; });
    }

    function capture() {
      // Real frame: draw video → canvas → data URL, store as a photo.
      if (live && typeof document !== "undefined" && document.createElement) {
        try {
          const cv = document.createElement("canvas");
          cv.width = 640; cv.height = 480;
          const ctx = cv.getContext && cv.getContext("2d");
          if (ctx && video) {
            ctx.drawImage(video, 0, 0, 640, 480);
            const data = cv.toDataURL("image/jpeg", 0.8);
            writePhotos([{ id: "c" + Date.now(), data, ts: Date.now() }, ...readPhotos()]);
            doFlash();
            return;
          }
        } catch (_) { /* fall through to demo photo */ }
      }
      // Demo path: gradient placeholder photo (also works headless).
      const p = palette[Math.floor(Math.random() * palette.length)];
      writePhotos([{ id: "c" + Date.now(), a: p[0], b: p[1], emoji: "📸", ts: Date.now() }, ...readPhotos()]);
      doFlash();
    }

    function doFlash() {
      flash.style.opacity = "1";
      setTimeout(() => { flash.style.opacity = "0"; }, 140);
      hint.textContent = "已保存到相册 📸";
      setTimeout(() => { hint.textContent = live ? "摄像头已就绪 · 点击快门拍照" : "当前环境无摄像头 · 使用演示取景器"; }, 1200);
    }

    const shutter = A.el("button", {
      class: "shutter",
      style: { display: "block", margin: "16px auto", width: "66px", height: "66px", borderRadius: "50%", border: "4px solid #fff", background: "rgba(255,255,255,0.15)", cursor: "pointer" },
      onclick: capture,
    });

    const body = A.el("div", { style: { display: "flex", flexDirection: "column", height: "100%", padding: 0 } }, [view, hint, shutter]);

    startCamera();
    return A.appShell("相机", body);
  },
});

