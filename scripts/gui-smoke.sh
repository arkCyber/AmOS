#!/usr/bin/env bash
# GUI smoke test for the 同传 (simultaneous-interpretation) app.
#
# Requires a display (X11 / Wayland / macOS). Usage:
#   scripts/gui-smoke.sh            # build + start daemon + launch the app
#   scripts/gui-smoke.sh --check    # only verify prerequisites + build
#
# It starts the amos-translate daemon in mock mode, then launches the Tauri
# System UI. In the UI, open the 「🌐 同传」 app and follow the on-screen flow.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOCKET="${AMOS_TRANSLATE_SOCKET:-/tmp/amos-translate.sock}"
DAEMON_PID=""
UI_PID=""

check_display() {
  if [ "${GUI_SMOKE_FORCE:-}" = "1" ]; then
    echo "  [gui-smoke] GUI_SMOKE_FORCE=1: skipping display check."
    return 0
  fi
  if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || [ "$(uname)" = "Darwin" ]; then
    echo "  [gui-smoke] display detected (${DISPLAY:-macOS/Wayland})."
    return 0
  fi
  echo "  [gui-smoke] ERROR: no display found (DISPLAY/WAYLAND_DISPLAY empty, not macOS)."
  echo "  This script launches a GUI window; run it on a machine with a display, or:"
  echo "  GUI_SMOKE_FORCE=1 scripts/gui-smoke.sh   # to skip the check anyway"
  return 1
}

build() {
  echo "  [gui-smoke] building amos-translate + amos-tauri …"
  (cd "$ROOT" && cargo build -p amos-translate -p amos-tauri)
}

start_daemon() {
  echo "  [gui-smoke] starting amos-translate daemon (mock) at $SOCKET …"
  rm -f "$SOCKET"
  AMOS_TRANSLATE_BACKEND=mock \
  AMOS_ASR_BACKEND=mock \
  AMOS_TRANSLATE_SOCKET="$SOCKET" \
    "$ROOT/target/debug/amos-translate" --socket "$SOCKET" >/tmp/amos-gui-daemon.log 2>&1 &
  DAEMON_PID=$!
  # wait for the socket to accept connections
  for _ in $(seq 1 50); do
    if [ -S "$SOCKET" ] && python3 - "$SOCKET" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    s.connect(sys.argv[1]); s.close(); raise SystemExit(0)
except Exception:
    raise SystemExit(1)
PY
    then
      echo "  [gui-smoke] daemon ready."
      return 0
    fi
    sleep 0.1
  done
  echo "  [gui-smoke] ERROR: daemon socket never became ready; see /tmp/amos-gui-daemon.log"
  kill "$DAEMON_PID" 2>/dev/null || true
  exit 1
}

launch_ui() {
  echo "  [gui-smoke] launching Tauri System UI (target/debug/amos-tauri) …"
  "$ROOT/target/debug/amos-tauri" &
  UI_PID=$!
}

cleanup() {
  [ -n "$UI_PID" ] && kill "$UI_PID" 2>/dev/null || true
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -f "$SOCKET"
}

main() {
  if [ "${1:-}" = "--check" ]; then
    check_display
    build
    echo "  [gui-smoke] prerequisites OK."
    exit 0
  fi
  check_display
  build
  start_daemon
  trap cleanup EXIT INT TERM
  launch_ui
  cat <<'EOF'

  ─────────────────────────────────────────────────────────────
  同传 GUI 冒烟 — 在窗口中操作：
    1. 在 Dock / 主屏找到 「🌐 同传」，点击打开
    2. 点 「▶ 开始」启动会话（状态显示 会话已启动）
    3. 🎤 按住「说话」录一段语音（或在下框输入文本回车）
    4. 观察：流式 partial（…你 / …你好 / …你好，Amos）→ 译文段落
    5. 点每段的「🔊 朗读」播放合成语音
    6. 点「⏹ 结束」结束会话
  ─────────────────────────────────────────────────────────────
  Press Ctrl-C to stop the app + daemon and clean up.
EOF
  wait "$UI_PID"
}

main "$@"
