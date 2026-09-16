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
  console.log("[a11y-scan] selftest: 7 assertion(s), 0 failure(s).");
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
