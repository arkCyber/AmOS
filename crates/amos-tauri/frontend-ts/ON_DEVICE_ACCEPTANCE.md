# 真机集成验收清单（可直接勾选填写）

> 在已连手机的设备上打开对应屏，逐项执行并填结果。设备/日期：
> build 版本（commit/hash）：______   设备：______   daemon：☐ 已拉起 ☐ 未
> 结论（每项填：✅ 通过 / ❌ 失败 / ⚠️ 异常，附 `[注]`）。

## 0. 环境自检
- [ ] App 能启动到主屏，无白屏/JS 报错（可开 chrome://inspect 看 console）
- [ ] 深/浅色切换生效；中/英切换后**已打开屏内文案原地更新**（不重开）
- [ ] 打开屏→关闭→重开，数据仍在（store 持久化）

## 1. 已迁 10 屏（Svelte）逐屏
对每屏都执行：能打开/交互/返回、无报错；并做下方标✅项。

**Calculator**
- [ ] 按键 9+3= → 12；除零显示"错误"；AC 可清
- [ ] 打开历史面板、加一条、重开仍在（store）
- [ ] 物理键盘 Enter/Backspace 有效（若有键盘）

**Weather**
- [ ] 默认 4 城（北京等）；℉ 切换显示 79°F；加/删城市、换语言原地更新

**Contacts**
- [ ] 新增联系人落盘；收藏星标；删除需两次；重复号码被拦；搜索

**Permissions（隐私）**
- [ ] 授权/撤销 camera 能力即时生效并落盘；离线无"最近访问"段

**Clock**
- [ ] 世界钟显示本机/他城时间；秒表跑动+计圈；计时器预设；闹钟到时响铃/贪睡/关闭

**Messages**
- [ ] 会话种子显示；发送出现且未读转通知（dock 徽标）；左滑删除

**Music**
- [ ] 播放→进度走动→自动切曲（repeat all/one/off）；歌词高亮；下一曲

**Notes**
- [ ] 新增→展开编辑（富文本加粗/高亮/链接正确渲染）；归档/垃圾桶/恢复；任务勾选；剪贴板复制/粘贴/历史

**Files**
- [ ] 根目录种子（文档/说明.txt）；进文件夹/返回；新建文件夹/文件；重命名/删除/剪切移动；收藏；搜索

**Photos**
- [ ] 种子网格；点开查看器翻页；收藏/分享/设为壁纸；删除；多选批量删除
- [ ] 视频（若设备上有 camera capture）显示 🎬 瓦片、可播放

## 2. 硬件/后端类（需 daemon/真机）— 迁移后在此验收
**Camera** / **AI** / **Interpreter** / **Android(LMK/系统)** / **Magnifier** / **VoiceMemos** / **Maps(定位)** / **Store(应用商店)** / **Phone(dock 拨号)** / **Mail(dock 收件)**：
对每个尚未迁的 dock 屏记录：迁移状态 ☐未迁 ☐WIP ☐已迁；若已迁，做 ☐ 真机功能走通 ☐ 离线错误提示正确。

**Phone（拨号，dock）— 当前迁移目标**
- [ ] 键盘输入/退格/清空；recent/frequent 列表显示
- [ ] 拨号真通（`ACTION_CALL`）或经 daemon；**未接 daemon 时应显示本地化错误、不出现假"通话中"**
- [ ] 通话中：计时走动；静音/录音状态正确；DTMF 键盘；挂断返回
- [ ] 紧急号码页特权拨号

## 3. 帧率 / 体积 A-B（各 ≥5 次取中位）
- [ ] Svelte 包：`npm run build`；React 基线：把 `svelteEnabled()` 临时改 `()=>false` 再 build
- [ ] `adb shell dumpsys gfxinfo <pkg> framestats`（或 chrome://inspect）采 Calculator/Photos/Clock 首开与交互帧
- [ ] `npm run bundle:report` 记体积
- 填结果：首开 load/compile____ 交互帧____ 掉帧____ 主线程长任务____

## 4. 覆盖门禁口径建议（勾选你的决定）
- [ ] 保持 P2-1 90%：需真机集成覆盖补 privacyBackend/cameraCapture/lmk/sensors/backend 等
- [ ] 把桥/设备库移出纯单元门禁（改 `scripts/lib-coverage-gate.mjs` 白名单），单列集成覆盖
- [ ] 其它：______
