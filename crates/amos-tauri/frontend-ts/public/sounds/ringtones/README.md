# Ringtones 缺省目录

AmOS 时钟闹钟铃音的**缺省存储目录**（`frontend-ts/public/sounds/ringtones/`）。
运行时相对根路径：`/sounds/ringtones/<file>`。

## 播放策略
`ringtonePlayer` 在真实浏览器/WebView 里**优先用这里的 MP3 文件**经 `<audio>` 循环播放；
无文件/无音频时回退 Web Audio 合成（`lib/ringtone.makeToneSamples`），因此本目录有文件与否都不影响出声。

文件名由 `RINGTONE_BY_TOKEN` / `RINGTONE_FILE_BY_ID` 决定（**MP3** 为播放格式）：

| emoji token | 音色 id | 播放文件 | 源（可再编辑） |
|---|---|---|---|
| `🔔` | `bell` | `bell.mp3` | `bell.wav` |
| `⏰` | `alarm` | `alarm.mp3` | `alarm.wav` |
| `📯` | `bugle` | `bugle.mp3` | `bugle.wav` |
| `🎶` | `melody` | `melody.mp3` | `melody.wav` |

## 重新生成
1. `node scripts/gen-ringtones.mjs`      → 从音色定义重写 4 个 `.wav`（确定性，无需外部工具）。
2. `node scripts/gen-ringtones-mp3.mjs`  → 用 `ffmpeg` 把 `.wav` 转成 `.mp3`（需 `ffmpeg` 在 PATH）。
