#!/bin/bash
# diagnose-android-usb.sh — AmOS Android 真机 USB 诊断（macOS）
# 不改任何状态，全部只读 + 半自动给建议。
#
# 用法：
#   bash scripts/diagnose-android-usb.sh           # 完整诊断
#   bash scripts/diagnose-android-usb.sh --fix    # 在合适处自动修复（如 adb restart）
#                                                 # （仍然不会触碰 USB 硬件）

set -u
SCRIPT_NAME="diagnose-android-usb"
VERBOSE=0
FIX=0

for arg in "$@"; do
    case "$arg" in
        -v|--verbose) VERBOSE=1 ;;
        --fix) FIX=1 ;;
        -h|--help)
            sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "[$SCRIPT_NAME] unknown arg: $arg" >&2; exit 2 ;;
    esac
done

log()  { printf "\033[1;34m[%s]\033[0m %s\n" "$SCRIPT_NAME" "$*"; }
warn() { printf "\033[1;33m[%s][!]\033[0m %s\n" "$SCRIPT_NAME" "$*" >&2; }
err()  { printf "\033[1;31m[%s][X]\033[0m %s\n" "$SCRIPT_NAME" "$*" >&2; }
ok()   { printf "\033[1;32m[%s][OK]\033[0m %s\n" "$SCRIPT_NAME" "$*"; }

section() { echo; printf "\033[1;36m━━ %s ━━\033[0m\n" "$*"; }

# ---- 1. adb 本体 ----------------------------------------------------------
section "Step 1/7  adb 本体"

if ! command -v adb >/dev/null 2>&1; then
    err "adb 命令找不到 — 请安装：brew install android-commandlinetools"
    exit 1
fi
adb_ver="$(adb version | head -1)"
log "$adb_ver"

adb_path="$(command -v adb)"
case "$adb_path" in
    */Android*/adb|*android*/platform-tools/adb)
        ok "adb 来自 Android SDK path: $adb_path" ;;
    *) warn "adb 来自非 SDK 路径 (brew): $adb_path — 大概率 OK，但要确认 SDK 平台工具是最新版" ;;
esac

# ---- 2. adb 服务器状态 ------------------------------------------------------
section "Step 2/7  adb server"

server_running="$(pgrep -x adb | head -1 || true)"
if [ -z "$server_running" ]; then
    warn "adb server 没在跑"
    if [ "$FIX" = 1 ]; then
        log "(fix) starting adb server"
        adb start-server >/dev/null 2>&1
    else
        log "建议手动执行： adb start-server"
    fi
else
    ok "adb server PID $server_running"
fi

adb_devices_raw="$(adb devices -l 2>&1)"
echo "$adb_devices_raw"

# ---- 3. USB 物理层 ---------------------------------------------------------
section "Step 3/7  macOS USB 物理层"

if ! command -v system_profiler >/dev/null 2>&1; then
    warn "system_profiler 不可用，跳过 USB 枚举"
else
    usb_dump="$(system_profiler SPUSBDataType 2>/dev/null)"
    # Android / Fastboot / Recovery 设备通常会带这些关键字
    if echo "$usb_dump" | grep -qiE 'android|samsung|huawei|xiaomi|vivo|oppo|oneplus|pixel|adb|fastboot|qualcomm'; then
        ok "macOS 能看到一台疑似 Android 设备："
        echo "$usb_dump" | grep -iE 'android|samsung|huawei|xiaomi|vivo|oppo|oneplus|pixel|adb|fastboot|qualcomm|product id|vendor id' | head -20
    else
        err "macOS 看不到任何 Android 设备 — 问题在 USB 物理层，不在 adb"
    fi
fi

# ---- 4. 系统级诊断：是不是已经过 USB 接入 -----------------------------------
section "Step 4/7  系统级诊断"

# 设备在 macOS 里的 IORegistry 节点名（脱敏后）
if command -v ioreg >/dev/null 2>&1; then
    android_ioreg="$(ioreg -p IOUSB -l 2>/dev/null | grep -iE 'android|samsung|huawei|xiaomi|vivo|oppo|oneplus|pixel|fastboot|adb' | head -20)"
    if [ -n "$android_ioreg" ]; then
        ok "ioreg 看到了疑似 Android 节点："
        echo "$android_ioreg"
    else
        err "ioreg 也没看到 Android 设备"
    fi
fi

# ---- 5. 主机端常见坑 --------------------------------------------------------
section "Step 5/7  macOS 常见坑自检"

# a) 之前装过 HoRNDIS / 第三方 Android USB 驱动吗
if [ -d "/System/Library/Extensions/ HoRNDIS.kext" ] || kextstat 2>/dev/null | grep -q HoRNDIS; then
    warn "检测到 HoRNDIS（旧 kernel 扩展）。Mac M-series 上应该用免驱的 libusb，无需 HoRNDIS。"
    warn "如不需要请先：sudo kextunload -b com.joshuawise.kexts.HoRNDIS"
fi
# b) 是否在做首次配对的「允许 USB 调试」键点 - 这一步在手机端
log "真机上必须做的：在手机屏幕上点击 \"Allow USB debugging from this computer\" 弹窗"
log "若手机连上没弹窗，请重新插拔数据线 或 关闭再打开 USB 调试"
# c) 数据线问题（充电 vs 数据）
log "请确认使用的是 *数据* 线（不是纯充电线），换一根试试"
# d) USB 端口
log "换一个 USB 端口试试（特别是直连 vs 集线器）"

# ---- 6. 当 adb 看不到设备时的极限自救 ---------------------------------------
section "Step 6/7  adb 看设备的极限自救"

echo
log "如果按上述自查后 macOS 物理层能看到设备但 adb 看不到："
echo

if echo "$adb_devices_raw" | grep -qE 'offline|unauthorized'; then
    warn "adb 报告 device offline / unauthorized"
    if [ "$FIX" = 1 ]; then
        log "(fix) adb kill-server 然后重启"
        adb kill-server >/dev/null 2>&1
        sleep 1
        adb start-server >/dev/null 2>&1
        sleep 2
        log "(fix) 重新插拔手机后请再跑此脚本"
    else
        log "建议手动执行："
        cat <<EOF
    adb kill-server
    sleep 1
    adb start-server
    # 然后拔掉 USB，等 5 秒，重新插
EOF
    fi
fi

# 没有设备
if [ -z "$(echo "$adb_devices_raw" | tail -n +2 | grep -v '^$' | grep -E 'device$')" ]; then
    warn "adb devices 没有任何 device 行 — USB 链路未建立"
    echo
    log "尝试过的 / 没尝试过的几条命令："
    cat <<EOF
    adb kill-server && sleep 1 && adb start-server
    adb devices -l                              # 不接就直接离线？
    # 如果上面看不到：换根线、换端口、关闭手机 USB 调试再开
    # 重启 Android（adb reboot 需要先连上）
    # 若 adb 在反复 un-authorize：删除 ~/.android/adbkey.pub 然后再插
EOF
fi

# ---- 7. 给 AmOS 的下一步建议 ------------------------------------------------
section "Step 7/7  接上之后给 AmOS 的命令"

cat <<EOF
当 adb devices 能看到真机后，AmOS 的标准上线流程：

# 1) 装 APK（已签名、26 MB）
adb install -r /Users/arksong/AmOS/crates/amos-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug-stripped.apk

# 2) 一次性预授两条权限 → 实现"零对话框"启动
adb shell pm grant com.amos.ai android.permission.CAMERA
adb shell pm grant com.amos.ai android.permission.RECORD_AUDIO

# 3) 启动 System UI
adb shell am start -n com.amos.ai/.MainActivity

# 4) 看 logcat 实时输出
adb logcat -s AmosRust:* amos::jni:* AndroidRuntime:E

EOF
echo
ok "诊断结束"
