# AmOS Photos × iOS Photos — 对齐差距清单

> 目标：把 AmOS 相册逐步对齐 iOS「照片」。每条按**航空航天级**对待——有明确验收语义、可离线纯测或需真机、不被「看起来对」糊弄。状态：`✅` 已实现且有测试 / `🟡` 部分 / `❌` 缺口 / `📱` 设备级（须真机）。

## 库（Library）— 主页
| iOS | AmOS | 状态 | 验收 |
|---|---|---|---|
| 网格按 **Days** 分组，相对日期头（今天/昨天/日期） | `PhotosApp.svelte` + `lib/photos.ts: groupDays/dayKey/dayIndex/dayLabel` | ✅ | `photoSections.test.ts` 3 例 + photos.svelte 1 例（含 i18n 热切） |
| 图库按拍摄时间**新→旧**排序 | gallery 派生按 `ts` 降序 | ✅ | gallery 逻辑存在 |
| 收藏智能过滤（♥） | `favsOf` + All/♥ 过滤 | ✅ | photos.ts + UI |
| 视频与照片**混排** | `gallery` 合并 photo+video | ✅ | 离线无视频源；真机待验 📱 |
| 今日/昨日头 + 段计数 | header 带 `· {n}`（>1 时） | ✅ | UI |
| 图库缩放（**年/月/日** scrubber） | — | ❌（设备手势） | 真机 📱 |
| 记忆「For You」/ 精选时刻 | — | ❌ | 需后端素材归类；待排期 |
| 竖排时间轴侧栏跳转 | — | ❌ | 📱 |

## 查看器（全屏）
| iOS | AmOS | 状态 | 验收 |
|---|---|---|---|
| 左右翻页 + 键盘/箭头 | viewer + `neighborOf` + ArrowLeft/Right | ✅ | svelte 测试 / 手动 |
| 收藏、删除、分享 | fav/share(剪贴板)/delete | ✅ | — |
| 分享**系统分享单** | 剪贴板文本（离线占位） | 🟡 | 真机需分享面板 📱 |
| 缩放（捏合/双击）、滑动关闭过渡 | — | ❌ | 📱 |
| 「设为壁纸」 | `amos.settings.wallpaper` | ✅ | — |
| 幻灯片 | 自动轮播 2.5s | ✅ | — |

## 选择 / 多选（Select）
| iOS | AmOS | 状态 | 验收 |
|---|---|---|---|
| 点选、计数、批量删除 | `selecting` + `removePhotos` + 计数按钮 | ✅ | photos.svelte 1 例 |
| 批量**收藏** | — | 🟡 | 待加 `selected`→fav |
| 「全选」+ 反选 | — | ❌ | 待加 |

## 媒体源
| iOS | AmOS | 状态 | 验收 |
|---|---|---|---|
| 相册（Recents/Favourites/Videos/自建） | 收藏过滤 + 视频视图；原生条只读 | 🟡 | 原生只读；真机写/删 📱 |
| 实况照片 / 原图 EXIF / 位置 | — | ❌ | 需元数据管线 |

## 原则
1. 每条改进必须有**可运行的测试**（纯逻辑层用 bun，DOM 用 vitest），或标注 `📱` 真机验收项并进 device-bringup。
2. 纯逻辑集中在 `lib/*.ts` 单源；UI 只接线不重实现。
3. i18n 增改保持 en/zh 奇偶一致（`i18n.test.ts` 守护）。

## 当前进度
- **Phase-1（本轮）**：Days 分组 + 相对头 + i18n 热切（纯 3 + DOM 1）。
- **Phase-2 候选**：选择态批量收藏/全选；智能「视频」页；段头随滚动吸顶。
- **Phase-3（真机）**：图库年/月/日缩放、全屏手势、系统分享、相册写删。
