// a11y-scan.mjs — AmOS 前端可访问性扫描器(read-only)。
//
// 模式:
//   --selftest      自测(脚本自身的样例已能区分真假缺陷)
//   --json          输出 JSON 报告
//   --md            输出 markdown 报告(默认人类形态)
//
// 扫描目标: crates/amos-tauri/frontend-ts/src/svelte/**/*.svelte
//
// 它**只报告缺口**——不动代码。每条记录附"为什么这是缺口"以及"该补什么",
// 后续轮次按缺口文件逐个补。
//
// 输出纪律(与已有的 i18n-scan / store-scan / write-scan 一致):
//   - 每条扫描行后面附"evidence"(grep 命中的那一行) + "rule"(违反哪条 a11y 规则)
//   - 自测脚本至少 1 例失败用例证明这套规则能抓真问题
//   - 退出码 0 表示"报告已生成";不因为发现缺口就退 1 —— 缺口的存在是要写进
//     A11Y_AUDIT.md 让工程团队看见的事实,不是"先修再说"

import fs from "node:fs";
import path from "node:path";

// ROOT 是仓库根(脚本在 frontend-ts/scripts/ 下,故根是 ../..)。
// 注意: process.cwd() 不一定是仓库根——bun run / npm script 与 git 命令
// 可能在仓库根里跑(此时 cwd=根),也可能在 frontend-ts 里跑(pnpm filter)。
// 解析路径时优先用 import.meta.url 找仓库根(查 .git 向上),
// 失败再 fallback 到 cwd。
function findRepoRoot(startDir) {
  let d = startDir;
  while (true) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}
const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);
const ROOT = findRepoRoot(__dirname) || process.cwd();
const SRC = path.join(ROOT, "crates/amos-tauri/frontend-ts/src/svelte");
const MD_OUT = path.join(ROOT, "docs/A11Y_AUDIT.md");
const JSON_OUT = path.join(ROOT, "docs/A11Y_AUDIT.json");

// ─── 维度 ─────────────────────────────────────────────────────────────────────
// 每个维度都有"规则定义"和"命中方式",以便后续扩展。
const DIMENSIONS = {
  /** 维度 1: settings/app 页面用 <span> 当 label(屏幕阅读器看不见)。任何包含
   *  `<label>` 字符串或视觉 LABEL 的页面应同时有 `<label for=…>` / `aria-labelledby` /
   *  `aria-label` 关联到字段。维度是"label 文本与字段控件关联度"。 */
  LABEL_FIELD_ASSOC: "label-field-association",

  /** 维度 2: 自定义交互控件(<Switch>、<Segmented>、自建 div/span-as-button 等)
   *  应有 WAI-ARIA role + 状态属性。 */
  CUSTOM_CONTROL_ROLE: "custom-control-role",

  /** 维度 3: 键盘可达性 —— 文件内若声明 `tabindex` / 监听 `keydown` / 有
   *  ARIA `tabindex` 属性,应确保 tab 顺序符合"视觉顺序"。脚本只标记
   *  `tabindex="1+"`(显式提权,与 WAI-ARIA 推荐的"让 DOM 顺序 = tab 顺序"
   *  背道而驰)。 */
  TAB_ORDER: "tab-order",

  /** 维度 4: focus-visible —— `:focus-visible` CSS 应当与 `tabindex` 焦点配套;
   *  任何以 button 为主交互的组件应给一个 outline / ring 样式(集中放在
   *  `lib/shellChrome.ts`)。脚本检查"button 元素 + 无 `outline`/`ring`
   *  类"的粗略组合,留人工验证。 */
  FOCUS_VISIBLE: "focus-visible",

  /** 维度 5: live region —— 状态变化应当通过 `aria-live="polite"` 或
   *  `role="status"` 宣告。脚本标记"有 setInterval/setTimeout 的 `$effect` 但
   *  对应 DOM 节点没有 live 标记"的可疑模式。 */
  LIVE_REGION: "live-region",

  /** 维度 6: 语言 —— 任何渲染文本的 .svelte 文件如果包含英文字母串连续 ≥4 个
   *  且未走 `t(…)`,且不在 i18n whitelist 里,则报告"未走 i18n"(与 i18n-scan
   *  重叠但只标 svelte 文件,且不依赖 i18n-scan 的全局字典)。这条由 i18n-scan
   *  单独负责,这里不重复。 */
  I18N: "i18n", // 留作 placeholder
};

// ─── helpers ──────────────────────────────────────────────────────────────────
function listSvelte(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSvelte(p));
    else if (e.isFile() && e.name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

function readSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

/**
 * 去掉注释后的代码（R1 计数用）。
 *
 * 第一版 v3 把 `Field.svelte` 自己的**文档注释**里提到的 `<input>` 当成了控件，于是给一个
 * 刚刚修好关联的组件报了缺口 —— 计数必须数代码，不数散文。只去掉整行 `//` 注释（这样字符串里
 * 的 URL `https://…` 不会被误删）与 `/* … *​/`、`<!-- … -->` 块。
 */
function stripComments(content) {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// ─── 扫描规则 ────────────────────────────────────────────────────────────────
/**
 * 规则 R1 (v3, REQ-A283): settings 家族的**每个控件**都要有"名字的来源"。
 *
 * v1/v2 是文件级信号: 只要文件里出现 `LABEL` span + 任一控件、又没有 `<label for>` /
 * `aria-labelledby`，就报一次。那个形状有两个问题:
 *   (a) 一个文件里 8 行控件只报了 1 条 —— 补哪几行全靠人读;
 *   (b) 补完 7 行、还剩 1 行时**规则就绿了**（文件里已经有 `<label for>` 了）。
 *
 * v3 改成**计数对**：控件数 > 名字来源数 ⇒ 报告还差几个。
 * 名字来源（三条机制，与审计文档 §3.1.1 的修法一致）：
 *   1. 共享行原语 `<Field>` / `<ToggleRow>` / `<ChoiceRow>` —— 关联由原语自己生成
 *      （见 crates/amos-tauri/frontend-ts/src/svelte/settings/Field.svelte）;
 *   2. `aria-label=` / `aria-labelledby=`（无可见 label 文本的字段，例如只有 placeholder 的
 *      密码框）;
 *   3. `<label for=…>`（原生 input/textarea/select，以及可被 label 关联的 `<button>`）。
 *
 * 它仍然是**文本启发式**：只数个数、不验证配对（一个 label 可能和另一个控件配对）。精确的
 * 部分由 DOM 级测试 `svelte-tests/settings-a11y.svelte.test.ts` 负责（挂载每个页面，用
 * `getByRole(role, { name })` 断言控件真的被可见文案命名）——扫描器看"有没有",测试看"对不对"。
 */
function r1_labelFieldAssoc(file, content) {
  // Scope: the settings family (pages import the shared kit tokens). Other surfaces count
  // their own `<input>`s all over the app; the audit's scope is Settings.
  if (!/from\s+["'][^"']*\/kit["']/.test(content)) return null;
  const code = stripComments(content);
  const count = (re) => (code.match(re) || []).length;
  const controls = count(/<(?:Switch|Segmented|input|textarea|select)\b/g);
  if (controls === 0) return null;
  const mechanisms = count(
    /<(?:Field|ToggleRow|ChoiceRow)\b|aria-labelledby=|aria-label=|<label\b[^>]*\bfor=/g,
  );
  if (controls <= mechanisms) return null;
  return {
    rule: `label-field-association: ${controls} control(s) but only ${mechanisms} name source(s) — ${controls - mechanisms} control(s) would have no accessible name`,
    fix: "build the row from the shared primitives (<ToggleRow>/<ChoiceRow>/<Field> in src/svelte/settings/) so the visible label *is* the control's name; for a field with no visible label text pass aria-label (same string as its placeholder)",
    evidence: `${controls} control(s) / ${mechanisms} mechanism(s) in this file`,
  };
}

/**
 * 规则 R2: 自定义控件 = 非原生 button/input/select 节点但有 onclick,
 * 没有 ARIA role。常见形式: <div on:click={…}> / <div onclick={…}>。
 *
 * 启发式约束:
 *   - 必须有 onclick / on:click —— 即确实是"点了做事"
 *   - 必须**不是**关闭外部点击的覆盖层(`pointer-events-* absolute inset-0`
 *     + `role="presentation" aria-hidden="true"`)。这种是"click-outside-to-close"
 *     模板,屏幕阅读器不该看到(aria-hidden 已经告诉它别读)。
 *   - 必须**不是**键盘监听覆盖层(`onkeydown` 在 div 上是 WAI-ARIA
 *     允许的:例如 radiogroup / tablist,只要它有 role)。
 */
function r2_customControlRole(file, content) {
  const re = /<(div|span)\b[^>]*?\bon(?:click|:click)=/g;
  const findings = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    // Look at a wider window around the match — role= can be 100s of chars before onclick
    const start = Math.max(0, m.index - 400);
    const snippet = content.slice(start, m.index + 80).replace(/\s+/g, " ");
    if (/role=/.test(snippet)) continue;
    // Skip click-outside-to-close overlay: aria-hidden + pointer-events-auto absolute inset-0
    if (/aria-hidden|pointer-events-(none|auto)\s+(absolute|fixed)\s+inset-0/.test(snippet)) continue;
    findings.push(snippet.slice(-90));
  }
  if (findings.length === 0) return null;
  return {
    rule: "custom-control-role: clickable <div>/<span> without role=button / role=menuitem / etc.",
    fix: "add role='button' (and tabindex='0' + keydown handler) OR convert to <button>; document intent",
    evidence: findings[0] + (findings.length > 1 ? ` …(+${findings.length - 1} more)` : ""),
  };
}

/**
 * 规则 R3: tabindex ≥ 1(显式提权,与 WAI-ARIA 推荐背道而驰)。
 */
function r3_tabOrder(file, content) {
  const re = /\btabindex=["']([1-9]\d*)["']/g;
  const findings = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    findings.push(`tabindex=${m[1]}`);
  }
  if (findings.length === 0) return null;
  return {
    rule: "tab-order: explicit tabindex >= 1 breaks the visual-tab order; WAI-ARIA: DOM order should equal tab order",
    fix: "remove tabindex=1+; if focus order is wrong, fix the DOM, not the attribute",
    evidence: findings.join(", "),
  };
}

/**
 * 规则 R4 (REQ-A285): <button> 没有可见的 focus 指示。
 *
 * v1/v2 是**文件级**信号,误报率高: ①<button class="..."> 在模板字符串里拼接
 * 共享 token,扫描器看不到 token 内的 focus-visible:ring-*; ②全局 CSS
 * `button:focus-visible { outline: 2px solid ... }` 也能给所有 button 装上 ring,
 * 模板里依然看不到。
 *
 * v3 改成两路检查 + 信任:
 *   (a) **全局** `button:focus-visible { outline: ... }` 在 index.css 等里有 —
 *       信任它(REQ-A285)。整个扫描器里**只**这一项信任 CSS,其他 a11y 仍要求
 *       文件级的 ARIA 属性。
 *   (b) 文件**未** trust (a) 时 — 检查每个 <button> class 是否显式带 ring/outline/
 *       focus 关键字(共享 token 仍按 import shellChrome 排除)。
 *
 * 误报依然可能(全局 CSS 没生效、tailwind 升级覆盖了),但**比**逐文件加
 * focus-visible:ring-* 更诚实——前者是真的"用户能看见 ring",后者只是"代码
 * 里写了 ring"。
 */
let globalFocusRing = null; // memoised across the scan
function hasGlobalFocusRing() {
  if (globalFocusRing !== null) return globalFocusRing;
  // Walk the frontend-ts source tree for *.css and check for button:focus-visible + outline: solid
  const CSS_ROOTS = [
    path.join(ROOT, "crates/amos-tauri/frontend-ts/src"),
    path.join(ROOT, "crates/amos-tauri/frontend-ts/src/svelte"),
  ];
  let found = false;
  const walk = (dir) => {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".css")) {
        const css = readSafe(p);
        if (/button[^{]*:focus-visible[^{]*\{[^}]*outline:\s*[^;]*solid/.test(css)) {
          found = true;
          return;
        }
      }
    }
  };
  for (const root of CSS_ROOTS) walk(root);
  globalFocusRing = found;
  return found;
}

function r4_focusVisible(file, content) {
  if (/from\s+["'][^"']*shellChrome["']/.test(content)) return null;
  // Global CSS trust — REQ-A285 says a top-level `button:focus-visible { outline: ... }`
  // covers every <button> in the app. We do **not** trust non-button selectors here
  // (a <div role="button"> with outline-none is still a gap we want to see).
  if (hasGlobalFocusRing()) return null;
  const re = /<button\b[^>]*?\bclass="([^"]*)"/g;
  const missing = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const cls = m[1];
    if (/outline|ring|focus/.test(cls)) continue;
    if (cls.length < 4) continue;
    missing.push(cls.slice(0, 60));
  }
  if (missing.length === 0) return null;
  return {
    rule: "focus-visible: <button> class without outline / ring / focus-visible (keyboard users can't see focus)",
    fix: "add `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` (or import a shared token from lib/shellChrome.ts)",
    evidence: `${missing.length} button(s); first: ${missing[0]}`,
  };
}

/**
 * 规则 R5: 有 setInterval/setTimeout/异步状态更新 的 effect,对应 DOM 缺
 * aria-live / role=status / role=alert —— 即"状态变了屏幕阅读器听不到"。
 */
function r5_liveRegion(file, content) {
  // heuristic: presence of $effect + setInterval/setTimeout in <script>
  if (!/\$effect\s*\(/.test(content)) return null;
  if (!/setInterval|setTimeout/.test(content)) return null;
  // Already mitigated — one of these patterns means the developer wired an accessible
  // answer (polite/assertive live region, role=status/alert/timer). role="timer" is the
  // "screen reader asks on demand" answer for clocks and counters — it is the explicit
  // alternative to aria-live that we adopted for REQ-A284's clock files (ClockWidget /
  // StageClock / LockScreen / StatusBar / HomeDock).
  if (/aria-live=|role=["'](status|alert|timer)["']/.test(content)) return null;
  // Files where the setInterval/setTimeout is **not** carrying user-perceivable state —
  // it is a visual re-render trigger (Dock refreshes the running-dot set, MonitorApp polls
  // for the progressbar values, CalendarApp re-derives the agenda, …). Screen readers do
  // not need to be interrupted for these. Adding aria-live here would be noise. The list
  // is maintained manually — when a file joins it, the rule that put it there is named
  // alongside so reviewers can disagree.
  //
  // Paths are repo-relative (the scanner normalizes to that form before lookup).
  const KNOWN_FALSE_POSITIVES = new Set([
    "crates/amos-tauri/frontend-ts/src/svelte/CalendarApp.svelte",      // 60 s tick recomputes agenda view; no per-minute user-facing change
    "crates/amos-tauri/frontend-ts/src/svelte/DeviceMicButton.svelte",   // 1 s poll of mic level for the level meter; visual only
    "crates/amos-tauri/frontend-ts/src/svelte/Dock.svelte",              // 5 s poll of open windows for the "running" dot; visual only
    "crates/amos-tauri/frontend-ts/src/svelte/HomeDock.svelte",          // role=timer on the clock card mitigates; the weather/grid poll stays visual
    "crates/amos-tauri/frontend-ts/src/svelte/ImeOverlay.svelte",        // setTimeout for caret-restoration, not a value change
    "crates/amos-tauri/frontend-ts/src/svelte/MonitorApp.svelte",        // 2 s poll of CPU/mem/battery; exposed as role=progressbar, on-demand readable
    "crates/amos-tauri/frontend-ts/src/svelte/MusicApp.svelte",          // setInterval updates the playback position slider (role=slider); on-demand readable
    "crates/amos-tauri/frontend-ts/src/svelte/RemindersApp.svelte",      // 20 s tick re-evaluates overdue state; no announcement-worthy delta
    "crates/amos-tauri/frontend-ts/src/svelte/SystemPanel.svelte",       // 2.5 s poll; readings exposed as text, no critical-alert path
    "crates/amos-tauri/frontend-ts/src/svelte/TaskManager.svelte",       // same shape as SystemPanel
    "crates/amos-tauri/frontend-ts/src/svelte/TerminalApp.svelte",       // setInterval for ANSI cursor blink (visual only)
    "crates/amos-tauri/frontend-ts/src/svelte/VoiceMemosApp.svelte",     // 250 ms tick drives the recording pulse animation; the recording state itself is a toggle, not a polling value
  ]);
  if (KNOWN_FALSE_POSITIVES.has(file)) return null;
  // Allow repo-relative form too (when ROOT is set, file paths come absolute; the
  // whitelist above is repo-relative to make the table human-grepable).
  const repoRel = (() => {
    const idx = file.indexOf("crates/amos-tauri/frontend-ts/");
    if (idx >= 0) return file.slice(idx);
    const idx2 = file.indexOf("src/svelte/");
    if (idx2 >= 0) return `crates/amos-tauri/frontend-ts/${file.slice(idx2)}`;
    return file;
  })();
  if (KNOWN_FALSE_POSITIVES.has(repoRel)) return null;
  return {
    rule: "live-region: $effect with setInterval/setTimeout but no aria-live / role=status on the readout",
    fix: "add aria-live='polite' (or role='status') to the container that displays the changing value; screen readers announce changes asynchronously",
    evidence: "$effect + setInterval detected",
  };
}

/**
 * 规则 R8 (REQ-A291): 动画敏感性(WCAG SC 2.3.1 AAA / SC 2.3.2 AAA)。
 *
 * WCAG 2.1:
 *  - 2.3.1 (AAA): 动画可以安全地 turn off (≤ 3 flashes/sec 豁免)
 *  - 2.3.2 (AAA): 避免 ≥ 3 flashes/sec (光敏性癫痫)
 *
 * 我们的扫描策略(启发式):
 *  1. `index.css` 的全局 `@media (prefers-reduced-motion: reduce)` — 这是 source of truth，
 *     在根级别 kill 所有 *{} animation/transition。已有，不重复报告。
 *  2. Svelte scoped `<style>` 里的 `@keyframes` + `animation:` — 这些在 scoped class 下运行，
 *     可能绕过全局 reset。
 *  3. `animate-*` Tailwind 类(animate-pulse, animate-spin 等) — `index.css` 已 kill，
 *     但如果该文件从未 import index.css (应该所有页面都 import)，则 report。
 *  4. JS 驱动的 `requestAnimationFrame` / `setInterval` — 仅当 interval < 300ms 才可能
 *     是装饰动画，功能性轮询(polling)豁免。
 *
 * 本规则只报告：Svelte scoped `@keyframes` + `animation:` infinite 且 duration > 0.5s。
 * one-shot 或 duration ≤ 0.5s 的入场动画豁免(WCAG 2.3.1 注释: 重复少于 3 次)。
 */
function r8_motion(file, content) {
  // Check 1: does the file import index.css (or a global CSS that provides the reset)?
  // We can't reliably track imports in a static scan. Instead, check if scoped @keyframes
  // use 'infinite' + duration > 0.5s. The index.css reset covers everything else.
  const suspects = [];

  // Match scoped style blocks: <style>...</style> inside Svelte
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = styleRe.exec(content)) !== null) {
    const block = m[1];

    // Skip blocks that already contain the prefers-reduced-motion override
    if (/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(block)) continue;

    // Find all @keyframes definitions — closing `}` may be at end-of-line or followed by whitespace
    const keyframeRe = /@keyframes\s+(\w+)[\s\S]*?\{([\s\S]*?)\s*\}/g;
    let km;
    while ((km = keyframeRe.exec(block)) !== null) {
      const name = km[1];
      const body = km[2];

      // Find animation usage referencing this keyframe
      // Escape any - or _ in the name for safe regex
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const usageRe = new RegExp(
        `animation:\\s*([^;}\\n]+?)\\b${escaped}\\b([^;}\\n]*)`,
        "gi"
      );
      let um;
      while ((um = usageRe.exec(block)) !== null) {
        const animVal = ((um[1] || "") + (um[2] || "")).trim();
        const isInfinite = /\binfinite\b/i.test(animVal);
        if (!isInfinite) continue;

        // Extract duration (e.g. "1s", "0.7s", "1200ms")
        const durMatch = animVal.match(/(\d+(?:\.\d+)?)\s*(m?s)/i);
        if (durMatch) {
          const num = parseFloat(durMatch[1]);
          const ms = durMatch[2].toLowerCase() === "s" ? num * 1000 : num;
          if (ms <= 500) continue; // Short animation — WCAG 2.3.1 safe
        }

        suspects.push({
          name,
          animVal: animVal.slice(0, 80),
          block: block.slice(Math.max(0, um.index - 20), um.index + 50).trim().slice(0, 60),
        });
      }
    }
  }

  if (suspects.length === 0) return null;
  const list = suspects
    .slice(0, 3)
    .map((s) => `${s.name} [${s.animVal}]`)
    .join("; ");
  return {
    rule: `motion: scoped @keyframes uses infinite animation — add @media (prefers-reduced-motion: reduce) { .class { animation: none } } to disable`,
    fix: "Wrap the animation class in a scoped @media (prefers-reduced-motion: reduce) { ... } block inside <style>, or remove the 'infinite' keyword if the animation is not essential",
    evidence: list,
  };
}

/**
 * 规则 R7 (REQ-A290): 触摸目标尺寸(WCAG SC 2.5.5 AAA / SC 2.5.8 AA)。
 *
 * 阈值:
 *  - AA (WCAG 2.1 SC 2.5.8): 24×24 px
 *  - AAA (WCAG 2.1 SC 2.5.5): 44×44 px (HIG)
 *
 * 启发式:
 *  - 提取 h-N, w-N, min-h-[Npx], min-w-[Npx], size-N — 任何 Tailwind 数值 step 形式
 *  - Tailwind 默认 1 step = 0.25rem = 4px (root font 16px)
 *  - 如果 button 至少有一个 axis ≥ 24, 且**无** text-[Npx] < 12px 的可读 label → AA pass
 *  - 如果两个 axis 都 ≥ 44 → AAA pass
 *  - 否则: FAIL with severity AA/AAA
 *
 * 豁免(列出具体原因, 必须人工 review):
 *  - icon-only button: aria-label 存在 + visual 内容是 svg/glyph/icon → 走 WCAG 1.4.11
 *    路径(≥24px 通过), 但 AAA 44 仍适用。
 *  - inline-link: class="..." 里同时有 leading/tight + text-[12px] → 这是 list 内紧凑
 *    label(像"已读"/"回复"), 触摸是**整个 row** 而非 button 本身。
 */

// Tailwind numeric step → px (root font 16px)
const TW_STEP_PX = {
  0: 0, px: 1, "0.5": 2, 1: 4, "1.5": 6, 2: 8, "2.5": 10, 3: 12, "3.5": 14,
  4: 16, 5: 20, 6: 24, 7: 28, 8: 32, 9: 36, 10: 40, 11: 44, 12: 48, 14: 56,
  16: 64, 20: 80, 24: 96,
  28: 112, 32: 128, 36: 144, 40: 160, 44: 176, 48: 192, 52: 208, 56: 224,
  60: 240, 64: 256, 72: 288, 80: 320, 96: 384,
};

function twPx(s) {
  if (!s) return null;
  if (TW_STEP_PX[s] !== undefined) return TW_STEP_PX[s];
  // Bracket form: [44px], [2.25rem]
  const pxM = s.match(/^(\d+(?:\.\d+)?)px$/);
  if (pxM) return +pxM[1];
  const remM = s.match(/^(\d+(?:\.\d+)?)rem$/);
  if (remM) return Math.round(+remM[1] * 16);
  return null;
}

function readSize(cls) {
  const tokens = cls.split(/\s+/);
  const px = { h: null, w: null };
  for (const t of tokens) {
    // Skip tokens inside `tileClassName="..."`, `glyphClassName="..."`, etc. — those
    // are props of inner components, not the button's own size.
    if (/[A-Za-z]ClassName$/.test(t)) continue;
    let m;
    m = t.match(/^(?:min-)?h-(.+)$/);
    if (m) {
      const v = twPx(m[1]);
      if (v !== null) px.h = Math.max(px.h || 0, v);
    }
    m = t.match(/^(?:min-)?w-(.+)$/);
    if (m) {
      const v = twPx(m[1]);
      if (v !== null) px.w = Math.max(px.w || 0, v);
    }
    m = t.match(/^size-(.+)$/);
    if (m) {
      const v = twPx(m[1]);
      if (v !== null) {
        px.h = Math.max(px.h || 0, v);
        px.w = Math.max(px.w || 0, v);
      }
    }
  }
  return px;
}

function isIconOnly(cls, fullAttrs) {
  // Icon-only heuristic: has aria-label OR title, AND visual content is svg/glyph.
  // We can't see children from a class-only scan, so we also accept any class that
  // includes a recognised icon helper (`iconSvg(`, `data-icon="x"`, etc.).
  return /aria-label=/.test(fullAttrs) || /title=/.test(fullAttrs);
}

/**
 * WCAG 2.5.5/2.5.8 提供了几条豁免(essential / equivalent function in inline text /
 * user-controlled)。我们显式列出哪些 class 模式**已经在**更大 hit-zone 中, 不需要
 * 单独看 button size 本身。
 *
 * 注意: 这是个**补充**, 不是把全部 chrome button 静默——
 * chrome 之外的 button(应用内)仍要走 h/w ≥ 44 的标准。
 */
const R7_CHROME_HIT_ZONE = /(?:CHROME_ICON_BUTTON|CHROME_MENU_BUTTON)/;

/**
 * IME keyboard, on-screen QWERTY, etc.: keys are dense by design and match
 * platform keyboards (iOS Gboard keys are 30-36pt). WCAG 2.5.5 has the
 * "essential" exception for keyboard layouts.
 */
const R7_KEYBOARD_FILE = /(?:ImeKeyboard|OnScreenKeyboard|Qwerty)\.svelte$/;

function r7_targetSize(file, content) {
  // Match `<button ...attrs>...</button>` and `<button ...attrs/>`
  // We extract a small window to capture attrs for aria-label / title heuristics.
  const suspects = new Map();
  // Capture everything between `<button` and the next `>` for attributes.
  const re = /<button\b([^>]*)>/g;
  let m;
  // Skip entire IME / keyboard files (key size is dictated by layout, not by a11y).
  if (R7_KEYBOARD_FILE.test(file)) return null;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1];
    const classMatch = attrs.match(/\bclass="([^"]+)"/);
    if (!classMatch) continue;
    const cls = classMatch[1];
    // Chrome widget buttons live in the 44px top bar — their visible target is the
    // bar itself, not the glyph. Apple HIG allows 22pt in chrome; WCAG 2.5.5 has the
    // "essential" exception for system chrome. Skip them here.
    if (R7_CHROME_HIT_ZONE.test(cls)) continue;
    const px = readSize(cls);
    if (px.h === null && px.w === null) continue;
    const minD = Math.min(px.h || 999, px.w || 999);
    const icon = isIconOnly(cls, attrs);
    // Severity: AA requires ≥24, AAA requires ≥44.
    // icon-only buttons still need to satisfy AAA (44) per SC 2.5.5 — but WCAG
    // gives an **exception** for inline text in the target. We flag them differently
    // so reviewers can decide.
    const level = minD < 24 ? "AA-fail" : minD < 44 ? "AAA-fail" : null;
    if (level === null) continue;
    const key = `${level}|${minD}px|${icon ? "icon" : "text"}`;
    const prev = suspects.get(key);
    if (!prev || minD < prev.minD) {
      suspects.set(key, {
        key,
        level,
        minD,
        icon,
        cls: cls.slice(0, 80),
        example: attrs.slice(0, 100),
      });
    }
  }
  if (suspects.size === 0) return null;
  const arr = [...suspects.values()].sort((a, b) => a.minD - b.minD);
  const counts = { "AA-fail": 0, "AAA-fail": 0 };
  for (const s of arr) counts[s.level]++;
  const list = arr
    .slice(0, 4)
    .map((s) => `${s.minD}px ${s.icon ? "(icon)" : "(text)"} [${s.level}]`)
    .join("; ");
  return {
    rule: `target-size: <button> below WCAG target size — ${list}`,
    fix: "raise h-/w- to ≥11 (= 44px AAA), or set min-h-[44px] min-w-[44px], or wrap the icon button in a 44×44 px hit zone (HIG iOS minimum)",
    evidence: `${counts["AA-fail"]} <24px + ${counts["AAA-fail"]} 24-43px; first: ${arr[0]?.cls ?? ""}`,
  };
}

/**
 * 规则 R6 (REQ-A288): 对比度。
 *
 * 每个元素 class="..." 拿到第一个 text-* + bg-* 配对,
 * 用 WCAG 2.1 contrast ratio (sRGB→linear→Y) 算对比度, 阈值:
 *  - 大字体(>=18pt 加粗 OR >=24pt 普通): AA ≥ 3.0, AAA ≥ 4.5
 *  - 小字体: AA ≥ 4.5, AAA ≥ 7.0
 *
 * 颜色表:
 *  - Tailwind v3 neutral-* 调色板(11 阶)
 *  - white/black (含 alpha 组合)
 *  - AmOS token: accent/danger, light + dark 各一组(--accent 在 :root, --accent 在 .dark)
 *
 * 合成的两种:
 *  1. text 在 bg 之上(纯色): text 直接取色, 不合成(textAlpha < 1 时才参与)
 *  2. bg 在 root surface 之上: bg 透明度合成到 white/black 默认 surface
 *
 * 注意: 这个扫描器是**静态**的, 不可能知道:
 *  - 动态 class 拼接(状态 / dark mode override)
 *  - 元素后方的"实际"背景色(视频帧、照片、渐变、branded gradient)
 *  - 后面的 sibling/pseudo-element 撑起的背景
 * 因此 PhotosApp 的 `text-white on bg-white/15` 表面 FAIL, 实际是视频覆盖对比——
 * 落入 KNOWN_FALSE_POSITIVES 显式白名单。
 *
 * 单文件级别一次性输出(不像 R4 那样列所有 button), 数量极少且人工可枚举时
 * 比"列 17 个 button 各自配对"更有行动价值——一个修法能盖住整个文件。
 */

// 调色板 + AmOS tokens
// Values come from src/index.css :root / .dark variables (REQ-A288 WCAG SC 1.4.3).
// Light tokens are intentionally deeper than iOS HIG (see the comment in index.css) so
// filled buttons (text-white on bg-accent/danger) pass AA for small text. Dark tokens
// stay HIG-faithful and accept AA-Large only — Apple itself accepts this trade-off.
const PALETTE = {
  white: { light: "#ffffff", dark: "#ffffff" },
  black: { light: "#000000", dark: "#000000" },
  accent: { light: "#0066CC", dark: "#0A84FF" },
  danger: { light: "#D70015", dark: "#FF453A" },
  "neutral-50":  { light: "#fafafa", dark: "#fafafa" },
  "neutral-100": { light: "#f5f5f5", dark: "#f5f5f5" },
  "neutral-200": { light: "#e5e5e5", dark: "#e5e5e5" },
  "neutral-300": { light: "#d4d4d4", dark: "#d4d4d4" },
  "neutral-400": { light: "#a3a3a3", dark: "#a3a3a3" },
  "neutral-500": { light: "#737373", dark: "#737373" },
  "neutral-600": { light: "#525252", dark: "#525252" },
  "neutral-700": { light: "#404040", dark: "#404040" },
  "neutral-800": { light: "#262626", dark: "#262626" },
  "neutral-900": { light: "#171717", dark: "#171717" },
  "neutral-950": { light: "#0a0a0a", dark: "#0a0a0a" },
};

// Tailwind utility prefixes that introduce a color
const UTIL_PREFIX_RE = /^(?:text|bg|ring|border|placeholder|divide|outline|fill|stroke|caret|decoration|shadow|accent)-/;

function extractColorToken(token) {
  // Strip Tailwind responsive/state prefixes: dark:, group-hover:, ...
  const stripped = token.replace(/^(?:dark|group-hover|hover|focus|active|sm|md|lg|xl):/, "");
  // Strip the utility prefix: text- → neutral-700 / bg- → neutral-200
  return stripped.replace(UTIL_PREFIX_RE, "");
}

function tokenHex(token, isDark) {
  const color = extractColorToken(token);
  if (!color) return null;
  const [base, rest] = color.split("/");
  const alpha = rest ? parseFloat(rest) / 100 : 1;
  const entry = PALETTE[base];
  if (!entry) return null; // unknown color, e.g. custom hex like text-[#fff]
  return { hex: isDark ? entry.dark : entry.light, alpha: isNaN(alpha) ? 1 : alpha };
}

// sRGB → linear → relative luminance Y
function srgbLin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lum([r, g, b]) {
  return 0.2126 * srgbLin(r) + 0.7152 * srgbLin(g) + 0.0722 * srgbLin(b);
}
function hexRgb(h) {
  if (!h || h.length < 7) return [128, 128, 128];
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}
function cr(L1, L2) {
  const L_max = Math.max(L1, L2);
  const L_min = Math.min(L1, L2);
  return (L_max + 0.05) / (L_min + 0.05);
}
function wcagLevel(ratio, isLarge) {
  if (ratio >= 7.0) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3.0 && isLarge) return "AA-Large";
  return "FAIL";
}

// Alpha-composite fg (text) over bg
function composite(fg, fgA, bg) {
  if (fgA >= 1) return fg;
  const a = fgA;
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}

// Surface colors (the root backdrop assuming no bg-* wraps tighter)
const SURFACE = {
  light: hexRgb("#ffffff"),
  dark: hexRgb("#000000"),
};

// KNOWN DYNAMIC BACKDROP: 每个条目注明"为什么是 whitelist"和"撤销条件"。
// Paths match what scan() passes to r6_contrast() after path normalization:
//   `crates/amos-tauri/frontend-ts/src/svelte/HomeDock.svelte`
const R6_FALSE_POSITIVES = new Set([
  "crates/amos-tauri/frontend-ts/src/svelte/PhotosApp.svelte",
  "crates/amos-tauri/frontend-ts/src/svelte/SpotlightOverlay.svelte",
  "crates/amos-tauri/frontend-ts/src/svelte/Launchpad.svelte",
  "crates/amos-tauri/frontend-ts/src/svelte/PlayerApp.svelte",
  "crates/amos-tauri/frontend-ts/src/svelte/MusicApp.svelte",
  "crates/amos-tauri/frontend-ts/src/svelte/SettingsApp.svelte",
  "crates/amos-tauri/frontend-ts/src/svelte/IncomingCall.svelte",
  "crates/amos-tauri/frontend-ts/src/svelte/HomeDock.svelte",
]);

function r6_contrast(file, content) {
  // Whitelist by repo-relative path (the file path passed in may already be repo-relative
  // or absolute depending on caller).
  const rel = file.includes("crates/amos-tauri/frontend-ts/")
    ? file.slice(file.indexOf("crates/amos-tauri/frontend-ts/"))
    : file;
  if (R6_FALSE_POSITIVES.has(rel)) return null;

  const classRe = /class="([^"]+)"/g;
  let m;
  const suspects = new Map(); // key → { ratio, count, fgTok, bgTok, mode }
  while ((m = classRe.exec(content)) !== null) {
    const cls = m[1];
    const tokens = cls.split(/\s+/);
    // Pick the **first** color-bearing text-* and bg-*. dark:* and friends are picked
    // up later via `darkPrefixed` so a `dark:bg-white/10` overrides the default
    // `bg-black/5` when computing the dark-mode row.
    const textToks = tokens.filter(
      (t) =>
        t.startsWith("text-") &&
        !["text-transparent", "text-current", "text-inherit", "text-auto"].includes(t) &&
        !/^dark:/.test(t) &&
        t.match(/^text-\[(?:xs|sm|base|lg|xl|\d+px)\]/) === null, // font-size, not color
    );
    const bgToks = tokens.filter(
      (t) =>
        t.startsWith("bg-") &&
        !["bg-transparent", "bg-current", "bg-inherit"].includes(t) &&
        !/^dark:/.test(t) &&
        t.match(/^bg-\d+$/) === null && // spacing tokens
        t.match(/^bg-\[/) === null, // arbitrary value, e.g. bg-[#fff]
    );
    if (!textToks.length || !bgToks.length) continue;
    const fgTok = textToks[0];
    const bgTok = bgToks[0];

    // Look for the matching `dark:` overrides (use the FIRST one of each kind).
    const darkFgTok = tokens.find((t) => /^dark:text-/.test(t) && t.match(/^text-\[(?:xs|sm|base|lg|xl|\d+px)\]/) === null);
    const darkBgTok = tokens.find((t) => /^dark:bg-/.test(t) && !["dark:bg-transparent", "dark:bg-current", "dark:bg-inherit"].includes(t));

    // 大字体: text-2xl+  或 font-bold + lg/xl/2xl+
    const isLarge =
      /\b(2?xl|3xl|4xl|5xl)\b/.test(fgTok) ||
      (/\bfont-bold\b/.test(cls) && /\b(lg|xl|2xl)\b/.test(cls));

    // Skip bare font-size utilities that slipped through (text-xs/sm/base/etc.)
    const fgColor = extractColorToken(fgTok);
    const bgColor = extractColorToken(bgTok);
    if (!fgColor || !bgColor) continue;
    if (!PALETTE[fgColor.split("/")[0]] || !PALETTE[bgColor.split("/")[0]]) continue;
    // Same skip for the dark override — we still need the colors to be known.
    if (darkFgTok) {
      const c = extractColorToken(darkFgTok);
      if (!c || !PALETTE[c.split("/")[0]]) {
        // unknown dark override — fall back to default fgTok for the dark row
      }
    }

    const hasDarkVariant = /\bdark:/.test(cls);
    const alwaysDark = (cls.match(/\bdark\b/) ? true : false) && !hasDarkVariant;
    const modes = alwaysDark
      ? [["dark", true]]
      : hasDarkVariant
        ? [["light", false], ["dark", true]]
        : [["light", false]];
    for (const [mode, dark] of modes) {
      // In dark mode, prefer the `dark:` override (the developer is telling us "this is
      // the colour for dark mode"). Without this, a light-mode default bg like bg-black/5
      // would compound onto the black surface and report 1.00:1 — the bug v0 had.
      const useFg = dark && darkFgTok ? darkFgTok : fgTok;
      const useBg = dark && darkBgTok ? darkBgTok : bgTok;
      const fgH = tokenHex(useFg, dark);
      const bgH = tokenHex(useBg, dark);
      if (!fgH || !bgH) continue;
      const effBg = composite(hexRgb(bgH.hex), bgH.alpha, SURFACE[dark ? "dark" : "light"]);
      const textRgb = composite(hexRgb(fgH.hex), fgH.alpha, effBg);
      const ratio = cr(lum(textRgb), lum(effBg));
      const level = wcagLevel(ratio, isLarge);
      if (level === "FAIL" || (level === "AA-Large" && !isLarge)) {
        const key = `${mode}|${useFg}|${useBg}`;
        const prev = suspects.get(key);
        if (!prev || ratio < prev.ratio) {
          suspects.set(key, {
            key,
            ratio,
            level,
            fgTok: useFg,
            bgTok: useBg,
            mode,
            isLarge,
            example: cls.slice(0, 80),
          });
        }
      }
    }
  }

  if (suspects.size === 0) return null;
  // Sort by worst ratio
  const arr = [...suspects.values()].sort((a, b) => a.ratio - b.ratio);
  const list = arr
    .slice(0, 4)
    .map((s) => `${s.fgTok} on ${s.bgTok} = ${s.ratio.toFixed(2)}:1 [${s.level}]`)
    .join("; ");
  return {
    rule: `contrast-ratio: text/bg pair(s) below WCAG AA — ${list}`,
    fix: "raise foreground → neutral-700+/bg → neutral-200-, OR add dark: variant that swaps to a higher-contrast pair (WCAG SC 1.4.3)",
    evidence: `${arr.length} unique pair(s)`,
  };
}

// ─── 主扫描 ──────────────────────────────────────────────────────────────────
function scan(file) {
  const content = readSafe(file);
  const findings = [];
  const rules = [
    r1_labelFieldAssoc,
    r2_customControlRole,
    r3_tabOrder,
    r4_focusVisible,
    r5_liveRegion,
    r6_contrast,
    r7_targetSize,
    r8_motion,
  ];
  for (const r of rules) {
    const f = r(file, content);
    if (f) findings.push(f);
  }
  return findings;
}

// ─── 自测 ────────────────────────────────────────────────────────────────────
function selftest() {
  const tmp = path.join("/tmp", `a11y-scan-selftest-${Date.now()}.svelte`);
  // sample 1: settings page w/ LABEL but no <label> binding — should be flagged
  const bad = `<script>
  import { LABEL } from "./kit";
</script>
<Switch aria="x" />
<span class={LABEL}>foo</span>`;
  fs.writeFileSync(tmp, bad);
  const f1 = scan(tmp);
  fs.unlinkSync(tmp);
  if (!f1.some(x => x.rule.includes("label-field-association"))) {
    console.error("[a11y-scan selftest] FAIL: did not catch the bad settings page");
    console.error("  findings:", JSON.stringify(f1, null, 2));
    process.exit(1);
  }
  // sample 2: <div onclick> without role — should be flagged
  const bad2 = `<div onclick={() => {}}>click</div>`;
  const tmp2 = path.join("/tmp", `a11y-scan-selftest-2-${Date.now()}.svelte`);
  fs.writeFileSync(tmp2, bad2);
  const f2 = scan(tmp2);
  fs.unlinkSync(tmp2);
  if (!f2.some(x => x.rule.includes("clickable <div>"))) {
    console.error("[a11y-scan selftest] FAIL: did not catch the <div onclick>");
    process.exit(1);
  }
  // sample 3: tabindex=1 — should be flagged
  const bad3 = `<button tabindex="1">x</button>`;
  const tmp3 = path.join("/tmp", `a11y-scan-selftest-3-${Date.now()}.svelte`);
  fs.writeFileSync(tmp3, bad3);
  const f3 = scan(tmp3);
  fs.unlinkSync(tmp3);
  if (!f3.some(x => x.rule.includes("tabindex >= 1"))) {
    console.error("[a11y-scan selftest] FAIL: did not catch tabindex=1");
    process.exit(1);
  }
  // sample 4 (REQ-A283): a settings page built from the shared row primitive — the association
  // is generated by the primitive, so R1 must stay silent (otherwise the fix would be flagged).
  const good4 = `<script>
  import { GROUP } from "./kit";
  import ToggleRow from "./ToggleRow.svelte";
</script>
<section class={GROUP}>
  <ToggleRow label="自动息屏" on={true} ontoggle={() => {}} />
</section>`;
  const tmp4 = path.join("/tmp", `a11y-scan-selftest-4-${Date.now()}.svelte`);
  fs.writeFileSync(tmp4, good4);
  const f4 = scan(tmp4);
  fs.unlinkSync(tmp4);
  if (f4.some(x => x.rule.includes("label-field-association"))) {
    console.error("[a11y-scan selftest] FAIL: flagged a page that uses the row primitive");
    console.error("  findings:", JSON.stringify(f4, null, 2));
    process.exit(1);
  }
  // sample 5 (REQ-A283): two controls, one name source → the *unpaired* control must be
  // counted. This is the case v1/v2 got wrong: any `<label for>` anywhere in the file used to
  // silence the whole page.
  const bad5 = `<script>
  import { GROUP, LABEL } from "./kit";
</script>
<section class={GROUP}>
  <label for="a">甲</label><input id="a" />
  <span class={LABEL}>乙</span><Switch on={true} ontoggle={() => {}} />
</section>`;
  const tmp5 = path.join("/tmp", `a11y-scan-selftest-5-${Date.now()}.svelte`);
  fs.writeFileSync(tmp5, bad5);
  const f5 = scan(tmp5);
  fs.unlinkSync(tmp5);
  const r5 = f5.find(x => x.rule.includes("label-field-association"));
  if (!r5 || !/2 control\(s\) but only 1 name source/.test(r5.rule)) {
    console.error("[a11y-scan selftest] FAIL: did not count the unpaired control");
    console.error("  findings:", JSON.stringify(f5, null, 2));
    process.exit(1);
  }
  // sample 6 (REQ-A284): a clock with role="timer" — R5 must stay silent because role="timer"
  // is the on-demand answer for live readouts. (Before A284 the rule only knew about
  // aria-live / role=status / role=alert; this case is what added role="timer" to the
  // recognised-mitigation list.)
  const good6 = `<script>
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });
</script>
<span role="timer" aria-label="current time">{now.toLocaleTimeString()}</span>`;
  const tmp6 = path.join("/tmp", `a11y-scan-selftest-6-${Date.now()}.svelte`);
  fs.writeFileSync(tmp6, good6);
  const f6 = scan(tmp6);
  fs.unlinkSync(tmp6);
  if (f6.some(x => x.rule.includes("live-region"))) {
    console.error("[a11y-scan selftest] FAIL: a role=timer readout should NOT be flagged as live-region");
    console.error("  findings:", JSON.stringify(f6, null, 2));
    process.exit(1);
  }
  // sample 7 (REQ-A285): a bare <button class="..."> without any focus-visible keyword. With
  // the global CSS rule `button:focus-visible { outline: ... }` present in src/index.css,
  // R4 v3 must stay silent — the rule proves keyboard users see the blue outline, so the
  // file-level signal is a false positive. (Earlier drafts of R4 would have flagged this
  // even with the global CSS in place, because they only inspected the button's class attr.)
  if (!hasGlobalFocusRing()) {
    console.error("[a11y-scan selftest] FAIL: src/index.css does not carry the expected button:focus-visible outline rule");
    console.error("  REQ-A285 wants the global CSS in place before R4 v3 trusts it.");
    process.exit(1);
  }
  const good7 = `<script></script>
<button class="rounded-full bg-accent px-3 py-1 text-white">ok</button>`;
  const tmp7 = path.join("/tmp", `a11y-scan-selftest-7-${Date.now()}.svelte`);
  fs.writeFileSync(tmp7, good7);
  const f7 = scan(tmp7);
  fs.unlinkSync(tmp7);
  if (f7.some(x => x.rule.includes("focus-visible"))) {
    console.error("[a11y-scan selftest] FAIL: R4 v3 should trust the global button:focus-visible rule");
    console.error("  findings:", JSON.stringify(f7, null, 2));
    process.exit(1);
  }
  // sample 8 (REQ-A288): R6 contrast must catch a proven FAIL (text-danger 1.00 = #FF3B30 on
  // bg-neutral-300 = #d4d4d4, ratio ≈ 2.39, well below AA's 4.5 for small text). A passing
  // pair (white on black = 21) must stay silent. This proves the rule actually computes
  // contrast — without sample 8, a future refactor that silently broke the math (e.g.
  // dropped the alpha compositing for `text-white on bg-white/15`) would pass every other
  // test case, including the existing "no findings" assertions.
  const bad8 = `<div class="rounded bg-neutral-300 px-2 py-1 text-danger">close</div>`;
  const tmp8 = path.join("/tmp", `a11y-scan-selftest-8-${Date.now()}.svelte`);
  fs.writeFileSync(tmp8, bad8);
  const f8 = scan(tmp8);
  fs.unlinkSync(tmp8);
  if (!f8.some(x => x.rule.includes("contrast"))) {
    console.error("[a11y-scan selftest] FAIL: did not catch the FAIL contrast pair");
    console.error("  findings:", JSON.stringify(f8, null, 2));
    process.exit(1);
  }
  const good8 = `<div class="rounded bg-black px-2 py-1 text-white">readable</div>`;
  const tmp8b = path.join("/tmp", `a11y-scan-selftest-8b-${Date.now()}.svelte`);
  fs.writeFileSync(tmp8b, good8);
  const f8b = scan(tmp8b);
  fs.unlinkSync(tmp8b);
  if (f8b.some(x => x.rule.includes("contrast"))) {
    console.error("[a11y-scan selftest] FAIL: 21:1 white-on-black should NOT be flagged");
    console.error("  findings:", JSON.stringify(f8b, null, 2));
    process.exit(1);
  }
  // sample 9 (REQ-A290): R7 target-size.
  //   bad9: h-5 w-5 (20px) — must be flagged (AA-fail).
  //   good9a: h-11 w-11 (44px) — must stay silent (AAA-pass).
  //   good9b: no h/w class — must stay silent (we don't claim a missing-size button).
  const bad9 = `<button class="grid h-5 w-5 place-items-center" aria-label="x">x</button>`;
  const tmp9 = path.join("/tmp", `a11y-scan-selftest-9-${Date.now()}.svelte`);
  fs.writeFileSync(tmp9, bad9);
  const f9 = scan(tmp9);
  fs.unlinkSync(tmp9);
  if (!f9.some(x => x.rule.includes("target-size"))) {
    console.error("[a11y-scan selftest] FAIL: h-5 w-5 (20px) should be flagged as AA-fail");
    console.error("  findings:", JSON.stringify(f9, null, 2));
    process.exit(1);
  }
  const good9a = `<button class="grid h-11 w-11 place-items-center" aria-label="x">x</button>`;
  const tmp9a = path.join("/tmp", `a11y-scan-selftest-9a-${Date.now()}.svelte`);
  fs.writeFileSync(tmp9a, good9a);
  const f9a = scan(tmp9a);
  fs.unlinkSync(tmp9a);
  if (f9a.some(x => x.rule.includes("target-size"))) {
    console.error("[a11y-scan selftest] FAIL: 44×44 (HIG/WCAG AAA) should NOT be flagged");
    console.error("  findings:", JSON.stringify(f9a, null, 2));
    process.exit(1);
  }
  const good9b = `<button class="rounded px-3 py-2" onclick={noop}>text-only button</button>`;
  const tmp9b = path.join("/tmp", `a11y-scan-selftest-9b-${Date.now()}.svelte`);
  fs.writeFileSync(tmp9b, good9b);
  const f9b = scan(tmp9b);
  fs.unlinkSync(tmp9b);
  if (f9b.some(x => x.rule.includes("target-size"))) {
    console.error("[a11y-scan selftest] FAIL: a button with no h/w/size class is opaque to R7 — must stay silent");
    console.error("  findings:", JSON.stringify(f9b, null, 2));
    process.exit(1);
  }
  // sample 10 (REQ-A291): R8 motion.
  //   bad10: infinite animation in scoped style without @media override → must flag.
  //   good10: same animation but inside a @media (prefers-reduced-motion: reduce) block → silent.
  //   good10c: one-shot animation (no infinite) → silent.
  const bad10 = `<style>
    .pulse { animation: myPulse 0.7s ease-in-out infinite; }
    @keyframes myPulse { from { opacity: 0 } to { opacity: 1 } }
  </style>`;
  const tmp10 = path.join("/tmp", `a11y-scan-selftest-10-${Date.now()}.svelte`);
  fs.writeFileSync(tmp10, bad10);
  const f10 = scan(tmp10);
  fs.unlinkSync(tmp10);
  if (!f10.some(x => x.rule.includes("motion"))) {
    console.error("[a11y-scan selftest] FAIL: scoped infinite animation should be flagged");
    console.error("  findings:", JSON.stringify(f10, null, 2));
    process.exit(1);
  }
  const good10 = `<style>
    .pulse { animation: myPulse 0.7s ease-in-out infinite; }
    @keyframes myPulse { from { opacity: 0 } to { opacity: 1 } }
    @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  </style>`;
  const tmp10a = path.join("/tmp", `a11y-scan-selftest-10a-${Date.now()}.svelte`);
  fs.writeFileSync(tmp10a, good10);
  const f10a = scan(tmp10a);
  fs.unlinkSync(tmp10a);
  if (f10a.some(x => x.rule.includes("motion"))) {
    console.error("[a11y-scan selftest] FAIL: animation with @media override should NOT be flagged");
    console.error("  findings:", JSON.stringify(f10a, null, 2));
    process.exit(1);
  }
  const good10c = `<style>
    .fade-in { animation: fadeUp 0.2s ease-out both; }
    @keyframes fadeUp { from { opacity: 0 } to { opacity: 1 } }
  </style>`;
  const tmp10c = path.join("/tmp", `a11y-scan-selftest-10c-${Date.now()}.svelte`);
  fs.writeFileSync(tmp10c, good10c);
  const f10c = scan(tmp10c);
  fs.unlinkSync(tmp10c);
  if (f10c.some(x => x.rule.includes("motion"))) {
    console.error("[a11y-scan selftest] FAIL: one-shot (non-infinite) animation should be silent");
    console.error("  findings:", JSON.stringify(f10c, null, 2));
    process.exit(1);
  }
  console.log("[a11y-scan] selftest: 15 assertion(s), 0 failure(s).");
}

// ─── 入口 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const files = listSvelte(SRC);
const report = [];
for (const f of files) {
  const findings = scan(f);
  if (findings.length > 0) report.push({ file: path.relative(ROOT, f), findings });
}

// 排序:按发现数降序,文件路径次之
report.sort((a, b) => b.findings.length - a.findings.length || a.file.localeCompare(b.file));

const totalFindings = report.reduce((s, r) => s + r.findings.length, 0);

if (argv.includes("--json")) {
  console.log(JSON.stringify({
    files_scanned: files.length,
    files_with_findings: report.length,
    total_findings: totalFindings,
    report,
  }, null, 2));
  process.exit(0);
}

// markdown
const lines = [];
lines.push("# AmOS Frontend A11y Audit");
lines.push("");
lines.push(`> **扫描器**: \`scripts/a11y-scan.mjs\`(可重复跑;只报告缺口,不修代码)`);
lines.push(`>`);
lines.push(`> **生成日期**: ${new Date().toISOString().slice(0, 10)}`);
lines.push(`>`);
lines.push(`> **范围**: \`crates/amos-tauri/frontend-ts/src/svelte/**/*.svelte\` (${files.length} 文件)`);
lines.push("");
lines.push("## 摘要");
lines.push("");
lines.push(`- 扫描文件: **${files.length}**`);
lines.push(`- 含缺口文件: **${report.length}** (${(100 * report.length / files.length).toFixed(1)}%)`);
lines.push(`- 总缺口数: **${totalFindings}**`);
lines.push("");
lines.push("## 维度");
lines.push("");
for (const [k, v] of Object.entries(DIMENSIONS)) {
  lines.push(`- **${k}**: ${v}`);
}
lines.push("");
lines.push("## 按文件(按发现数降序)");
lines.push("");
lines.push("| 文件 | 缺口数 | 规则 | 证据 | 建议修法 |");
lines.push("|------|--------|------|------|----------|");
for (const r of report) {
  for (const f of r.findings) {
    const esc = (s) => s.replace(/\|/g, "\\|").slice(0, 200);
    lines.push(`| \`${esc(r.file)}\` | ${r.findings.length} | ${esc(f.rule)} | \`${esc(f.evidence)}\` | ${esc(f.fix)} |`);
  }
}
lines.push("");
lines.push("## 边界");
lines.push("");
lines.push("- 本扫描器**只报告缺口**——退出码 0,因为缺口的存在要被写进文档让工程团队看见,而非\"先修再说\"");
lines.push("- 规则的匹配是**启发式**的,有误报与漏报:误报可忽略(上下文是最终判官),漏报需用真屏幕阅读器与真键盘导航复核");
lines.push("- 本扫描器与 `scripts/i18n-scan.mjs` / `scripts/store-scan.mjs` / `scripts/write-scan.mjs` / `scripts/unwired-scan.mjs` 同源(同一组脚本族),可以 `bun run check` 一起跑");
lines.push("- 修法不是\"加 aria-label 一行\"就完:每条规则都需要(1) ARIA 属性,(2) 键盘可达,(3) 真屏幕阅读器复核;**三件事一起做才算\"补完\"**");

const out = lines.join("\n");
console.log(out);

if (argv.includes("--write")) {
  // 把 markdown 输出写到 docs/A11Y_AUDIT.md(自动覆盖);不带 --write 时仅 stdout,
  // 这是 a11y-scan 与其他扫描器的区别:其他扫描器会自动写,a11y-scan 默认
  // 只到 stdout,工程师可以"看完再决定是否落盘"。这把扫描器的"看见 vs 落地"
  // 区分开,避免覆盖 A11Y_AUDIT.md 的人工判断部分。
  try {
    fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
    fs.writeFileSync(MD_OUT, out);
    console.error(`[a11y-scan] wrote ${MD_OUT}`);
  } catch (e) {
    console.error(`[a11y-scan] WARN: failed to write ${MD_OUT}: ${e.message}`);
  }
}
