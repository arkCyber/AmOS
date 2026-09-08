# AmOS 相机 × iOS 相机 — 对齐差距清单

> 状态语义与 Photos 一致：`✅` 已实现且有测试 / `🟡` 部分(占位/仅 UI) / `❌` 缺口 / `📱` 设备级(须真机/系统相机能力)。
> 纯控制数学集中在 `lib/camera.ts`，录像在 `lib/cameraCapture.ts`；`camera.svelte.test.ts` + `camera-lib.test.ts` 全绿。

## 取景与捕获
| iOS | AmOS | 状态 | 验收 |
|---|---|---|---|
| 前后镜头翻转 + 预览镜像 | `facing`/`facingMode`/`mirrorPreview` + 翻转重新 `getUserMedia` | ✅ | svelte「翻转镜头→重新请求+镜像 -scale-x-100」 |
| 实时取景 | `getUserMedia` 流 → `<video>`（无流→演示取景） | ✅ | svelte no-camera / live 两路 |
| 拍照(快门)→存 Photos | canvas 帧 → `amos.photos`(base64) | ✅ | svelte live 拍照 1 例 |
| 画面比例 4:3/方/16:9 | `RATIO_ORDER`+`captureDims`+`fitCrop` 中心裁 | ✅ | camera-lib 几何/不变量 |
| 数码变焦(点/滑) | `zoomCrop` + 1×/2×/3× 芯片 + 1–5 滑杆 | ✅ | camera-lib zoom 用例 |
| 网格(三分) | `grid` 叠层 | ✅ | — |
| 闪光 auto/开/关(前摄照明确闪禁) | `FLASH_ORDER` + `torch` 尽力(开) | 🟡 | 真机手电 `📱` |
| 连拍(长按/可调 N) | 长按 + `BURST_OPTS` 计数 | ✅ | svelte 连拍 chip |
| 自拍计时 3s/10s、再按取消 | `TIMER_PRESETS` + countdown + 取消 | ✅ | — |
| 画质档(SD/HD/FHD) | `RESOLUTIONS`/`nextRes` + 重取流 | ✅ | svelte 画质循环 |

## 照片/视频模式
| iOS | AmOS | 状态 | 验收 |
|---|---|---|---|
| 拍照/录像 滑切 | `mode` photo/video | ✅ | — |
| 录像→app 内媒体库回放/删除 | `MediaRecorder` + `amos.captures` + overlay | ✅ | svelte 录像→library 1 例 |
| 真实感 HDR 开关 + 诚实降级说明 | `hdr` 占位 + `camera.hdrNote` | 🟡(占位) | svelte HDR note 1 例 |

## 系统/高级（多数需真机）
| iOS | AmOS | 状态 |
|---|---|---|
| 点按对焦 / AE-AF 锁定(黄框+AE/AF LOCK) | — | `❌` 📱(需 `applyConstraints` focus/pointsOfInterest) |
| 夜景模式 / 人像景深 / ProRAW / 实况照片 | — | `❌` 📱 |
| 光学镜头群(0.5×/1×/2×/3× 原生) | 仅数码变焦 | `🟡` 📱 |
| 拍摄中拍照(录像时抓帧) | — | `🟡` 📱 |
| 照片方向 EXIF 自动旋转 | base64 无 EXIF | `🟡` 📱 |

## 原则（与 Photos 相同）
1. 每项改进有可运行测试（纯 bun / DOM vitest）或标 `📱` 进 device-bringup。
2. 控制数学单源 `lib/camera.ts`；UI 只接线。
3. i18n 增改保 en/zh 奇偶（`i18n.test.ts` 守护）。

## 进度
- **Phase-1（本轮）**：审计矩阵；将 UI 依赖的 iOS 控制环（闪光/镜头/比例/定时/变焦）**不变量纯测钉死**（防将来误改顺序）。
- **Phase-2 候选**：点按对焦 + AE/AF 锁定指示（纯坐标映射 + 真机 `pointsOfInterest`）；录像时拍照抓帧。
- **Phase-3（真机）**：光学变焦档、夜景/人像/ProRAW 需系统能力。
