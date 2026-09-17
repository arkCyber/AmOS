# AmOS 手机 UI 优化清单

**日期**: 2026-09-17  
**状态**: 🚧 进行中

---

## 一、已完成的 UI 优化

### 1.1 铃声设置页面 ✅
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/settings/RingtonePage.svelte`

**功能**:
- ✅ 5 种预设铃声选择（classic/modern/piano/guitar/bell）
- ✅ 来电振动开关
- ✅ 铃声预览功能（点击播放）
- ✅ 持久化存储（amos.ringtone）
- ✅ 双语支持（中英文）
- ✅ iOS 风格卡片布局
- ✅ 选中项视觉反馈（✓）

**设计细节**:
```svelte
- 卡片分组：铃声列表 + 振动开关独立卡片
- 交互反馈：active:scale-95 微动效果
- 色彩系统：accent 色调（天蓝色）
- 布局间距：space-y-5 / py-3 / px-4
- 字体层级：text-[15px] 主文本 / text-xs 提示文本
```

**集成状态**:
- ✅ 添加到 SettingsApp 路由
- ✅ 添加到导航索引（通知与声音分组）
- ✅ 搜索关键词配置完成
- ✅ i18n 翻译完整覆盖

---

### 1.2 设置应用导航优化 ✅
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/SettingsApp.svelte`

**改进**:
- ✅ 新增"来电铃声"独立入口
- ✅ 优化分组结构（通知与声音 4 项）
- ✅ 搜索关键词扩充（ringtone/来电铃声/振动）
- ✅ 保持 iOS 风格的卡片间距

**导航结构**:
```
通知与声音分组:
├── 通知
├── 声音与触感
├── 来电铃声 ← 新增
└── 专注模式
```

---

### 1.3 国际化完善 ✅
**文件**: `crates/amos-tauri/frontend-ts/src/i18n/locales/zh.ts`

**新增翻译**:
```typescript
"settings.ringtone": "来电铃声",
"ringtone.classic": "经典铃声",
"ringtone.modern": "现代铃声",
"ringtone.piano": "钢琴",
"ringtone.guitar": "吉他",
"ringtone.bell": "铃铛",
"ringtone.selectTitle": "选择来电铃声",
"ringtone.selectHint": "来电时播放的铃声",
"ringtone.vibrateOnRing": "来电振动",
"ringtone.vibrateHint": "来电时同时振动",
"ringtone.preview": "预览",
"ringtone.previewDesc": "播放当前选择的铃声",
```

---

## 二、待优化的 UI 项目

### 2.1 P0 级（用户体验关键）

#### 1. 通话界面优化 🔴
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/PhoneApp.svelte`

**当前问题**:
- 通话界面按钮过大（占用空间）
- 录音按钮无权限提示
- 挂断按钮无确认（防误触）

**优化方案**:
```svelte
<!-- 录音权限提示 -->
{#if !recordingPermission}
  <div class="rounded-lg bg-yellow-500/10 p-3 text-sm">
    <p>{t("phone.recordingNeedsPerm")}</p>
    <button onclick={requestRecordingPerm}>
      {t("phone.grantPermission")}
    </button>
  </div>
{/if}

<!-- 通话控制优化 -->
<div class="grid grid-cols-3 gap-4">
  <CallButton icon="🔇" label={t("phone.mute")} />
  <CallButton icon="⏺" label={t("phone.record")} disabled={!hasPerm} />
  <CallButton icon="📞" label={t("phone.hangup")} danger />
</div>
```

#### 2. 拨号盘数字键反馈 🔴
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/PhoneApp.svelte`

**当前问题**:
- 按键无触觉反馈
- 按键无按下动画
- 按键大小在小屏幕上不够

**优化方案**:
```svelte
<button
  onclick={() => { appendDigit(digit); vibrate(10); }}
  class="active:scale-95 active:bg-neutral-200 dark:active:bg-neutral-700
         transition-transform duration-75 rounded-full
         h-16 w-16 text-2xl font-medium"
>
  {digit}
</button>
```

#### 3. 通话记录时间显示优化 🔴
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/PhoneApp.svelte`

**当前问题**:
- 时间戳格式单一
- 无相对时间（今天/昨天）
- 通话时长显示不直观

**优化方案**:
```typescript
function formatCallTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const hours = Math.floor(diff / 3600000);
  
  if (hours < 24) return t("phone.today");
  if (hours < 48) return t("phone.yesterday");
  return new Date(timestamp).toLocaleDateString();
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
```

---

### 2.2 P1 级（体验提升）

#### 4. 联系人头像优化 🟡
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/ContactsApp.svelte`

**当前状态**: 纯色背景 + 首字母  
**优化方案**: 渐变色 + 多样化

```svelte
<script>
const AVATAR_GRADIENTS = [
  "from-sky-400 to-indigo-500",
  "from-emerald-400 to-teal-500",
  "from-orange-400 to-rose-500",
  "from-violet-400 to-purple-500",
];

function getAvatarGradient(name: string): string {
  const hash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}
</script>

<div class="bg-gradient-to-br {getAvatarGradient(contact.name)}">
  {contact.name[0]}
</div>
```

#### 5. 短信气泡优化 🟡
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/MessagesApp.svelte`

**当前问题**:
- 发送/接收消息色彩对比不足
- 长消息无换行优化
- 时间戳显示冗余

**优化方案**:
```svelte
<!-- 发送消息（右侧，蓝色） -->
<div class="ml-auto max-w-[75%] rounded-2xl rounded-br-md
            bg-accent px-4 py-2.5 text-white">
  <p class="break-words">{msg.text}</p>
  <span class="text-xs opacity-70">{formatTime(msg.time)}</span>
</div>

<!-- 接收消息（左侧，灰色） -->
<div class="mr-auto max-w-[75%] rounded-2xl rounded-bl-md
            bg-neutral-200 dark:bg-neutral-800 px-4 py-2.5">
  <p class="break-words">{msg.text}</p>
  <span class="text-xs opacity-60">{formatTime(msg.time)}</span>
</div>
```

#### 6. 紧急拨号界面增强 🟡
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/LockScreen.svelte`

**当前问题**:
- 紧急拨号按钮不够明显
- 常用紧急号码未预设
- 无快速拨打功能

**优化方案**:
```svelte
<div class="space-y-2">
  <button onclick={() => dialEmergency("110")}
          class="w-full rounded-lg bg-red-500 px-4 py-3 text-white">
    🚨 110 · {t("emergency.police")}
  </button>
  <button onclick={() => dialEmergency("120")}
          class="w-full rounded-lg bg-red-500 px-4 py-3 text-white">
    🚑 120 · {t("emergency.medical")}
  </button>
  <button onclick={() => dialEmergency("119")}
          class="w-full rounded-lg bg-red-500 px-4 py-3 text-white">
    🚒 119 · {t("emergency.fire")}
  </button>
</div>
```

---

### 2.3 P2 级（锦上添花）

#### 7. 通话界面深色模式优化 🟢
**文件**: `crates/amos-tauri/frontend-ts/src/svelte/PhoneApp.svelte`

**优化**: 确保通话界面在深色模式下对比度足够

#### 8. 动画流畅度提升 🟢
**文件**: 所有 `*App.svelte`

**优化**: 添加 `transition-all duration-200` 统一过渡

#### 9. 无障碍增强 🟢
**文件**: 所有通话/短信相关组件

**优化**: 
- 添加 `aria-label` 完整描述
- 添加 `role="button"` 明确语义
- 键盘导航支持（Tab/Enter）

---

## 三、设计系统一致性

### 3.1 色彩规范

**品牌色（Accent）**: 
- Primary: `#38BDF8` (sky-400)
- Hover: `#0EA5E9` (sky-500)
- Active: `#0284C7` (sky-600)

**功能色**:
- Success: `#10B981` (emerald-500)
- Warning: `#F59E0B` (amber-500)
- Danger: `#EF4444` (red-500)
- Info: `#3B82F6` (blue-500)

**中性色（深色模式）**:
- Background: `#0F172A` (slate-900)
- Surface: `#1E293B` (slate-800)
- Border: `#334155` (slate-700)
- Text: `#F8FAFC` (slate-50)

### 3.2 间距规范

```css
/* 组件内边距 */
--spacing-xs: 0.5rem;  /* 8px */
--spacing-sm: 0.75rem; /* 12px */
--spacing-md: 1rem;    /* 16px */
--spacing-lg: 1.5rem;  /* 24px */
--spacing-xl: 2rem;    /* 32px */

/* 卡片间距 */
--card-gap: 1rem;      /* 16px */
--section-gap: 1.25rem; /* 20px */
```

### 3.3 圆角规范

```css
/* 按钮/卡片 */
--radius-sm: 0.5rem;   /* 8px */
--radius-md: 0.75rem;  /* 12px */
--radius-lg: 1rem;     /* 16px */
--radius-xl: 1.5rem;   /* 24px */

/* 圆形按钮 */
--radius-full: 9999px;
```

### 3.4 字体规范

```css
/* 标题 */
--text-h1: 2rem;       /* 32px, font-bold */
--text-h2: 1.5rem;     /* 24px, font-semibold */
--text-h3: 1.25rem;    /* 20px, font-medium */

/* 正文 */
--text-base: 1rem;     /* 16px */
--text-sm: 0.875rem;   /* 14px */
--text-xs: 0.75rem;    /* 12px */

/* 字重 */
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
```

---

## 四、实施计划

### Phase 1: 关键体验（2-3 天）
- [ ] 通话界面优化（录音权限提示）
- [ ] 拨号盘数字键反馈
- [ ] 通话记录时间显示优化

### Phase 2: 视觉提升（2 天）
- [ ] 联系人头像优化
- [ ] 短信气泡优化
- [ ] 紧急拨号界面增强

### Phase 3: 细节打磨（1-2 天）
- [ ] 深色模式优化
- [ ] 动画流畅度提升
- [ ] 无障碍增强

**总预估**: 5-7 个工作日

---

## 五、测试清单

### 5.1 功能测试
- [ ] 铃声选择后来电播放正确
- [ ] 振动开关生效
- [ ] 铃声预览播放正常
- [ ] 设置持久化保存成功

### 5.2 视觉测试
- [ ] 浅色模式正常显示
- [ ] 深色模式对比度足够
- [ ] 不同屏幕尺寸适配正常
- [ ] 动画流畅无卡顿

### 5.3 无障碍测试
- [ ] 屏幕阅读器正确朗读
- [ ] 键盘导航完整支持
- [ ] 颜色对比度符合 WCAG AA
- [ ] 按钮尺寸符合触控标准（>44px）

---

## 六、参考资料

- [iOS Human Interface Guidelines - Phone](https://developer.apple.com/design/human-interface-guidelines/phone)
- [Material Design - Calling](https://m3.material.io/components/calling/overview)
- [WCAG 2.1 - Color Contrast](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
- [Tailwind CSS - Design System](https://tailwindcss.com/docs)

---

**更新日志**:
- 2026-09-17 07:45: 完成铃声设置页面实施
- 2026-09-17 08:00: 创建 UI 优化清单
