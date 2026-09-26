#!/usr/bin/env node
/**
 * perf-budget-scan.mjs — 门禁：「性能预算」这条断言必须测**代码**，不许测**这台机器此刻有多空**
 * （REQ-A850 / F-DEV-106）
 *
 * 为什么需要它（不是假想，是同一次运行里量出来的）：本仓当时有 **22 条**这样的断言 ——
 *
 *     const start = performance.now();       // 或 Date.now()
 *     <干活>
 *     const duration = performance.now() - start;
 *     expect(duration).toBeLessThan(N);
 *
 * `now()` 的差值是「干活」**加上**「这段时间里这台机器被别的进程抢走了多少 CPU」。把两台
 * 仪器放在**同一次运行、同一份负载**下交替跑同一件活（`encryptMDMData`，12 组样本，预算
 * 50ms，40 个自旋进程压满 18 核）：
 *
 *     单次计时：   min 18.59 / p50 36.04 / max **201.49**ms  ⇒ **4/12 组越过预算**
 *     取 K 次最小：min 10.90 / p50 20.53 / max  **40.90**ms  ⇒ **0/12 组越过预算**
 *
 * 也就是说那条断言的**单次翻红概率约三分之一**，且红的含义是「刚才有人抢 CPU」，不是
 * 「代码变慢了」。后果不是「偶发红」这么轻：`bun run check` **不再是确定性的** —— 绿的不
 * 能当证据（也许只是这次机器空），红的会被当成噪音重跑一遍，于是所有人学会「重跑到绿为止」。
 * 而直觉上的补救（把 N 调大）是拿「抓得住真回归」换「不抖」。
 *
 * 判据（本门禁守的那一条）：**被断言耗时与数值比较的那个变量，必须来自
 * `fastest()` / `fastestAsync()`**（K 次尝试取最小值，理由与边界写在
 * `src/__tests__/perfBudget.ts` 的头部）。判的是**绑定**，不是数值 —— 阈值一个都不许因此
 * 被改大，改大阈值这条门禁看不见，但它在用法说明里被明确禁止。
 *
 * 允许一跳本地助手（`compass.test.ts` 的 `measure(iterations, fn)` 就是这一形状：它自己
 * 调 `fastest`），因为把判据写在助手内部同样是「这个值来自取最小值」，而**两跳及以上、
 * 以及经参数传进来的耗时，本门禁看不见**（见下面「诚实边界」）。
 *
 * 三样东西都不会腐烂：
 *   * `MUST_SEE_FILES` —— 有预算断言的**文件集合**按**双向集合相等**钉住。一个文件悄悄
 *     不再有这类断言（被删、被改名、被挪走）不会触发任何别的规则：它没有调用点、也不
 *     影响任何阈值，所以**只有集合相等能看见**（本仓的既有教训：下限不是钉子）。
 *   * 豁免名单 `scripts/perf-budget-allowlist.json`：每个站点要有自己的 `kind`、所属
 *     `kind` 的非空 `reason`，以及**它自己的 `note`**；`note` 会在运行输出里逐条打印出来，
 *     好让人反驳。陈旧条目（站点已消失或已合规）同样失败。
 *   * 运行输出逐条打印**普查**（文件、变量、阈值、绑定方式），所以「这个数是几」永远可见。
 *
 * 诚实边界（别把这门禁当成它没有的东西）：
 *   * **两跳及以上**的助手、以及把耗时**当参数传进**断言函数的写法，文本抽取看不见 ⇒
 *     只能靠上面那个文件集合的钉子兜住「一整条消失」，兜不住「一整条改变形状」。
 *   * 它判的是**绑定**，不判**阈值合不合理**：`expect(duration).toBeLessThan(10_000_000)`
 *     在这门禁眼里完全合规，而它其实什么都测不出。阈值是否随被测对象一起演进，本门禁不管。
 *   * `toBeLessThan` 之外还有别的写法（`toBeLessThanOrEqual`、`expect(x < N).toBe(true)`、
 *     `assert.ok(x < N)`）—— 本仓用到的只有 `toBeLessThan`；多出来的写法要扩的是**抽取器**，
 *     不是判据。
 *
 * 用法：
 *   node scripts/perf-budget-scan.mjs              # 门禁
 *   node scripts/perf-budget-scan.mjs --selftest   # 内嵌用例（证明抽取器按说明工作）
 *   node scripts/perf-budget-scan.mjs --json       # 机器可读
 * 退出码：0 通过 / 1 有未绑定的预算断言或名单腐烂 / 2 参数错误
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, matchDelim, invokedDirectly } from "./void-cmd-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

/** The three runner roots, and where each runner looks (see `orphan-test-scan.mjs`). */
const TEST_ROOTS = ["src/__tests__", "src/lib/__tests__", "svelte-tests"];
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * The file census, pinned by **set equality in both directions**. A file leaving this set is
 * invisible to every other rule (no call sites, no thresholds touched), so only a pin sees it.
 */
const MUST_SEE_FILES = [
  "src/__tests__/MeasureApp.test.ts",
  "src/__tests__/badgeSoundSystem.test.ts",
  "src/__tests__/notificationDeduplication.test.ts",
  "src/lib/__tests__/cloud.test.ts",
  "src/lib/__tests__/cloudSync.test.ts",
  "src/lib/__tests__/compass.test.ts",
  "src/lib/__tests__/mdmCrypto.test.ts",
  "src/lib/__tests__/pushNotifications.test.ts",
  "src/lib/__tests__/voice.test.ts",
  "src/lib/__tests__/webman-security.test.ts",
  "src/lib/__tests__/webman.test.ts",
];

/** The two instruments, by name. Anything else is not this family. */
const FASTEST_RE = /\b(?:fastest|fastestAsync)\s*\(/;

/**
 * A **raw clock delta**: `performance.now() - <something>` / `Date.now() - <something>`.
 * Anchored on the subtraction so a deadline (`Date.now() + 5000`) is not misread as a duration.
 */
const RAW_DELTA_RE = /(?:performance|Date)\s*\.\s*now\s*\([^)]*\)\s*-\s*[A-Za-z_$]/;

/** `expect(<ident>).toBeLessThan(<number>)` — the budget assertion shape this repo uses. */
const BUDGET_RE =
  /expect\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.\s*toBeLessThan\s*\(\s*([0-9][0-9_]*)\s*\)/g;

/** A local declaration, so its right-hand side can be inspected for the instrument. */
const DECL_RE = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;

/** The end of the statement starting at `from`, at brace/paren depth 0. */
export function statementEnd(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === ";" && depth <= 0) return i;
    else if (c === "\n" && depth <= 0) {
      // a statement may legitimately continue on the next line; only stop when the line
      // already looks complete (no trailing operator/open delimiter).
      const so_far = src.slice(from, i).trimEnd();
      // `>` matters: an arrow function may end a line with `=>` and continue on the next
      // (`const measure = (n, fn): number =>\n  fastest(...)`), which is exactly the shape
      // `compass.test.ts` uses. Without `>` here the right-hand side was cut before `fastest(`
      // and the site became invisible — the gate's own pin caught that, not a human.
      if (so_far && !/[=(,+\-*/&|?:.[{>]$/.test(so_far)) return i;
    }
  }
  return src.length;
}

/**
 * Every identifier in the file that is bound to a **duration**, and HOW it is bound.
 * Returns `{ decls, resolve }`, where `decls` is the ordered list of declarations and
 * `resolve(name, before)` finds the **latest** one preceding `before`.
 *
 * Per-OCCURRENCE, not per-name: a file commonly names four different durations `duration`
 * (one per test), and a map keyed by identifier keeps only the first — which made an earlier
 * version of this gate judge the wrong declaration and go green on a reverted site. The
 * negative control caught that; the fix is to resolve each assertion against the declaration
 * that actually precedes it.
 *
 * `kind` is one of:
 *   - `"fastest"`     — bound by `fastest(...)` / `fastestAsync(...)`;
 *   - `"fastest-hop"` — bound by a local helper (one hop) whose own body calls `fastest`;
 *   - `"raw"`         — bound by a bare clock subtraction (`now() - start`);
 *   - `"raw-hop"`     — bound by a local helper (one hop) that does a bare clock subtraction.
 */
export function analyse(src) {
  const s = stripComments(src);
  const lineOf = (idx) => s.slice(0, idx).split("\n").length;

  // Pass 1 — every declaration's right-hand side (or function body), in source order.
  const decls = [];
  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(s))) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    let end;
    if (m[1] !== undefined) {
      end = statementEnd(s, DECL_RE.lastIndex);
    } else {
      // `function name(` — take the body braces.
      const open = s.indexOf("{", DECL_RE.lastIndex);
      if (open === -1) continue;
      const close = matchDelim(s, open, "{", "}");
      end = close === -1 ? s.length : close + 1;
    }
    const rhs = s.slice(DECL_RE.lastIndex, end);
    const own = FASTEST_RE.test(rhs) ? "fastest" : RAW_DELTA_RE.test(rhs) ? "raw" : null;
    decls.push({ name, rhs, at: m.index, own, line: lineOf(m.index) });
  }
  decls.sort((a, b) => a.at - b.at);

  /** The latest declaration of `name` that starts before `before`, or undefined. */
  const declBefore = (name, before) => {
    let found;
    for (const d of decls) {
      if (d.at >= before) break;
      if (d.name === name) found = d;
    }
    return found;
  };

  const calledNames = (rhs) => {
    const names = [];
    const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    let mm;
    while ((mm = re.exec(rhs))) names.push(mm[1]);
    return names;
  };

  /** How (if at all) `name` is bound to a duration at byte offset `before`. */
  const resolve = (name, before) => {
    const d = declBefore(name, before);
    if (!d) return null;
    if (d.own) return { kind: d.own, line: d.line, via: null };
    // one hop: assigned from a call to a local helper that itself computes a duration.
    for (const callee of calledNames(d.rhs)) {
      if (callee === name) continue;
      const h = declBefore(callee, d.at);
      if (h && h.own) return { kind: `${h.own}-hop`, line: d.line, via: callee };
    }
    return null;
  };

  return { decls, resolve, declBefore };
}

/** Every budget assertion in the file, judged against the declaration that precedes it. */
export function budgetSites(src) {
  const s = stripComments(src);
  const { resolve } = analyse(src);
  const sites = [];
  BUDGET_RE.lastIndex = 0;
  let m;
  while ((m = BUDGET_RE.exec(s))) {
    const ident = m[1];
    const bound = resolve(ident, m.index);
    if (!bound) continue; // not a duration this file computes ⇒ not this family
    sites.push({
      ident,
      budget: Number(m[2].replace(/_/g, "")),
      kind: bound.kind,
      via: bound.via,
      line: s.slice(0, m.index).split("\n").length,
      ok: bound.kind === "fastest" || bound.kind === "fastest-hop",
    });
  }
  return sites;
}

/** `<file>::<ident>` — the allow-list key, stable across line-number drift. */
export const siteKey = (file, ident) => `${file}::${ident}`;

/** Set difference in both directions. A floor cannot see a one-name loss; this can. */
export function pinDiff(got, want) {
  const g = new Set(got);
  const w = new Set(want);
  return {
    missing: [...w].filter((x) => !g.has(x)).sort(),
    extra: [...g].filter((x) => !w.has(x)).sort(),
  };
}

/** Whether a `kind` no site references declares why it is still on file. `note` is this
 *  file's spelling; the `reason` prefix is `write-allowlist.json`'s (its kinds are strings
 *  and its retired one already reads `RETIRED (REQ-A150, round 86). …`). */
function declaresMemberless(spec) {
  if (spec && typeof spec === "object") {
    if (typeof spec.note === "string" && spec.note.trim() !== "") return true;
    return /^(RETIRED|UNUSED|KEPT)\b/.test(String(spec.reason ?? "").trim());
  }
  return /^(RETIRED|UNUSED|KEPT)\b/.test(String(spec ?? "").trim());
}

/** Well-formedness of the allow-list: every site needs its own kind and a non-empty note,
 *  and — the same rule read the other way (REQ-A1492) — a `kind` no site references has to
 *  say why it is still on file. This file's two kinds are memberless on purpose and each
 *  carries a `note` saying so; without this clause nothing kept the next one honest, and
 *  `write-allowlist.json`'s `derived-tick` rotted exactly that way (its last member became
 *  a checked write and the reason kept describing the old shape). */
export function checkAllowlistShape(doc) {
  const problems = [];
  const kinds = doc.kinds ?? {};
  const referenced = new Set((doc.sites ?? []).map((s) => s?.kind).filter((k) => typeof k === "string"));
  for (const [k, v] of Object.entries(kinds)) {
    if (!v || typeof v.reason !== "string" || v.reason.trim() === "") {
      problems.push(`kind "${k}" has no reason`);
    }
    if (!referenced.has(k) && !declaresMemberless(v)) {
      problems.push(
        `kind "${k}" is referenced by no site and does not say why it is kept ` +
          "(add a `note`, or begin its `reason` with RETIRED ∕ UNUSED ∕ KEPT)",
      );
    }
  }
  for (const site of doc.sites ?? []) {
    const label = `${site.file ?? "?"}::${site.ident ?? "?"}`;
    if (!site.file || !site.ident) problems.push(`${label}: needs both file and ident`);
    if (!site.kind) problems.push(`${label}: no kind`);
    else if (!kinds[site.kind]) problems.push(`${label}: names undefined kind "${site.kind}"`);
    if (typeof site.note !== "string" || site.note.trim() === "") {
      problems.push(`${label}: no note (a kind's reason is one sentence for many sites and can always be read as fitting)`);
    }
  }
  return problems;
}

/** Every test file under the three runner roots. */
export function testFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== "node_modules" && !ent.name.startsWith(".")) testFiles(p, acc);
    } else if (TEST_FILE_RE.test(ent.name)) acc.push(p);
  }
  return acc;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function readAllowlist() {
  const p = path.join(ROOT, "scripts", "perf-budget-allowlist.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function runScan(asJson) {
  const files = TEST_ROOTS.flatMap((r) => testFiles(path.join(ROOT, r))).sort();
  const allow = readAllowlist();
  const shape = checkAllowlistShape(allow);
  const allowKeys = new Set((allow.sites ?? []).map((s) => siteKey(s.file, s.ident)));

  const census = [];
  const offenders = [];
  const withBudgets = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const site of budgetSites(src)) {
      const file = rel(f);
      withBudgets.add(file);
      const key = siteKey(file, site.ident);
      const exempt = allowKeys.has(key);
      census.push({ file, ...site, allowlisted: exempt });
      if (!site.ok && !exempt) offenders.push({ file, ...site });
    }
  }

  const stale = (allow.sites ?? []).filter((s) => !census.some((c) => siteKey(c.file, c.ident) === siteKey(s.file, s.ident) && !c.ok));
  const pin = pinDiff(withBudgets, MUST_SEE_FILES);

  // Every allow-listed site's own note is reprinted, so a reader can rebut it.
  const notes = census.filter((c) => c.allowlisted);

  if (asJson) {
    console.log(JSON.stringify({ census, offenders, pin, shape, stale }, null, 2));
  } else {
    const byFile = new Map();
    for (const c of census) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file).push(c);
    }
    for (const [file, sites] of [...byFile].sort()) {
      for (const s of sites) {
        const how =
          s.kind === "fastest" ? "fastest(...)"
          : s.kind === "fastest-hop" ? `fastest via helper ${s.via}()`
          : s.kind === "raw" ? "RAW single-shot clock delta"
          : `RAW single-shot via helper ${s.via}()`;
        console.log(`[perf-budget-scan] ${file}:${s.line}  ${s.ident} < ${s.budget}ms  — ${how}${s.allowlisted ? "  (allow-listed)" : ""}`);
      }
    }
    for (const s of notes) {
      const entry = (allow.sites ?? []).find((x) => siteKey(x.file, x.ident) === siteKey(s.file, s.ident));
      console.log(`[perf-budget-scan] allow-listed ${siteKey(s.file, s.ident)} (${entry.kind}) — ${entry.note}`);
    }
    console.log(
      `[perf-budget-scan] ${census.length} budget assertion(s) in ${withBudgets.size} file(s); ${notes.length} allow-listed.`,
    );
  }

  let failed = false;
  if (shape.length) {
    failed = true;
    console.error(`[FAIL] perf-budget-allowlist.json is malformed:`);
    for (const p of shape) console.error(`       - ${p}`);
  }
  if (pin.missing.length || pin.extra.length) {
    failed = true;
    console.error(`[FAIL] perf-budget: the file census drifted from the pin (a file leaving this set has no call sites and touches no threshold, so nothing else can see it):`);
    for (const f of pin.missing) console.error(`       - pinned but no longer has any budget assertion: ${f}`);
    for (const f of pin.extra) console.error(`       - has budget assertions but is not pinned: ${f}`);
    console.error(`       Fix: bind the new sites through fastest()/fastestAsync(), or update MUST_SEE_FILES deliberately.`);
  }
  if (stale.length) {
    failed = true;
    console.error(`[FAIL] perf-budget: stale allow-list entries (the site is compliant now, or is gone):`);
    for (const s of stale) console.error(`       - ${siteKey(s.file, s.ident)}`);
  }
  if (offenders.length) {
    failed = true;
    console.error(`[FAIL] perf-budget: an assertion compares a SINGLE-SHOT clock delta against a budget, so its verdict is about how busy the machine was, not about the code (REQ-A850 / F-DEV-106):`);
    for (const o of offenders) {
      console.error(`       - ${o.file}:${o.line}  ${o.ident} < ${o.budget}ms  (bound by ${o.kind}${o.via ? ` via ${o.via}()` : ""})`);
    }
    console.error(`       Fix: const ${"{dur}"} = fastest(PERF_ATTEMPTS, () => { ... });  from src/__tests__/perfBudget.ts`);
    console.error(`       (min over K attempts: contention only ADDS time to an attempt, never removes it, so the min`);
    console.error(`        approaches the unloaded cost — while a real regression raises every attempt.)`);
  }
  if (!failed) {
    console.log(`[perf-budget-scan] OK — every perf budget is measured by min-of-K, not by whichever process won the CPU.`);
  }
  process.exit(failed ? 1 : 0);
}

export function runSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, !!cond]);

  // --- the two instruments are told apart ------------------------------------------------
  ok("a bare clock subtraction is a raw duration", budgetSites(
    "const start = performance.now();\nwork();\nconst duration = performance.now() - start;\nexpect(duration).toBeLessThan(50);",
  ).map((s) => s.kind).join() === "raw");

  ok("Date.now() is a clock too", budgetSites(
    "const t0 = Date.now();\nwork();\nconst ms = Date.now() - t0;\nexpect(ms).toBeLessThan(10);",
  ).map((s) => s.kind).join() === "raw");

  ok("fastest() is the instrument", budgetSites(
    "const duration = fastest(PERF_ATTEMPTS, () => { work(); });\nexpect(duration).toBeLessThan(50);",
  ).every((s) => s.kind === "fastest" && s.ok));

  ok("fastestAsync() counts too", budgetSites(
    "const d = await fastestAsync(PERF_ATTEMPTS, () => go());\nexpect(d).toBeLessThan(50);",
  ).every((s) => s.kind === "fastest" && s.ok));

  // --- the one hop that the codebase actually uses (compass's `measure`) -------------------
  const hop = budgetSites([
    "const measure = (n, fn) => fastest(PERF_ATTEMPTS, () => { for (let i = 0; i < n; i++) fn(i); });",
    "const elapsed = measure(1000, () => work());",
    "expect(elapsed).toBeLessThan(5);",
  ].join("\n"));
  ok("a local helper that itself calls fastest() is accepted (one hop)", hop.length === 1 && hop[0].kind === "fastest-hop" && hop[0].ok);

  const rawHop = budgetSites([
    "const measure = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };",
    "const elapsed = measure(() => work());",
    "expect(elapsed).toBeLessThan(5);",
  ].join("\n"));
  ok("a local helper that does a bare clock subtraction is a raw site, not a free pass",
    rawHop.length === 1 && rawHop[0].kind === "raw-hop" && !rawHop[0].ok);

  // --- things that must NOT be flagged ----------------------------------------------------
  ok("a deadline is not a duration", budgetSites(
    "const deadline = Date.now() + 5000;\nexpect(deadline).toBeLessThan(999999);",
  ).length === 0);

  ok("an unrelated count assertion is not this family", budgetSites(
    "const ids = new Set();\nfor (const x of xs) ids.add(x);\nexpect(ids.size).toBeLessThan(1000);",
  ).length === 0);

  ok("toBeLessThan on a literal is not this family", budgetSites(
    "expect(rows.length).toBeLessThan(100);",
  ).length === 0);

  ok("the instrument's OWN doc comment is not read as code (comments are stripped first)", budgetSites(
    "/**\n *     const duration = performance.now() - start;\n *     expect(duration).toBeLessThan(N);\n */\nconst duration = fastest(PERF_ATTEMPTS, () => work());\nexpect(duration).toBeLessThan(50);",
  ).every((s) => s.ok));

  ok("an underscored budget is read as one number", budgetSites(
    "const d = fastest(PERF_ATTEMPTS, () => work());\nexpect(d).toBeLessThan(10_000);",
  ).map((s) => s.budget).join() === "10000");

  ok("two sites in one file are two sites", budgetSites(
    "const a = fastest(PERF_ATTEMPTS, () => one());\nexpect(a).toBeLessThan(5);\nconst b = fastest(PERF_ATTEMPTS, () => two());\nexpect(b).toBeLessThan(7);",
  ).length === 2);

  // The reuse case: one file, one NAME, several durations (voice.test.ts names four of them
  // `duration`). A map keyed by identifier keeps only the first declaration, so a reverted
  // second site stayed green — this case is what makes that hole unshippable.
  const reuse = budgetSites([
    "const duration = fastest(PERF_ATTEMPTS, () => one());",
    "expect(duration).toBeLessThan(50);",
    "const start = performance.now();",
    "two();",
    "const duration = performance.now() - start;",
    "expect(duration).toBeLessThan(50);",
  ].join("\n"));
  ok("a file reusing one identifier for several durations is judged per occurrence, not per name",
    reuse.length === 2 && reuse[0].ok && !reuse[1].ok && reuse[1].kind === "raw");

  ok("the reused-name site still reports both, so the census cannot shrink silently",
    reuse.map((s) => s.budget).join() === "50,50");

  // --- the pin sees a one-name loss that nothing else can ---------------------------------
  ok("a file leaving the census is reported as missing", pinDiff(["a", "b"], ["a", "b", "c"]).missing.join() === "c");
  ok("an unpinned file is reported as extra (both directions)", pinDiff(["a", "b", "z"], ["a", "b"]).extra.join() === "z");
  ok("identical sets produce no drift", pinDiff(["b", "a"], ["a", "b"]).missing.length === 0 && pinDiff(["b", "a"], ["a", "b"]).extra.length === 0);

  // --- the allow-list cannot be used as a bin ---------------------------------------------
  ok("a site with no kind at all is rejected", checkAllowlistShape(
    { kinds: { k: { reason: "why", note: "memberless in this fixture" } }, sites: [{ file: "a", ident: "d", note: "because" }] },
  ).length === 1);
  ok("a site naming an undefined kind is rejected", checkAllowlistShape(
    { kinds: { k: { reason: "why", note: "memberless in this fixture" } }, sites: [{ file: "a", ident: "d", kind: "nope", note: "x" }] },
  ).length === 1);
  ok("a site with no note is rejected even when its kind is defined and reasoned", checkAllowlistShape(
    { kinds: { k: { reason: "why" } }, sites: [{ file: "a", ident: "d", kind: "k" }] },
  ).length === 1);
  ok("a site whose note is blank is rejected too", checkAllowlistShape(
    { kinds: { k: { reason: "why" } }, sites: [{ file: "a", ident: "d", kind: "k", note: "   " }] },
  ).length === 1);
  ok("a kind with a blank reason is rejected", checkAllowlistShape(
    { kinds: { k: { reason: "  ", note: "memberless in this fixture" } }, sites: [] },
  ).length === 1);
  ok("a well-formed entry passes", checkAllowlistShape(
    { kinds: { k: { reason: "why" } }, sites: [{ file: "a", ident: "d", kind: "k", note: "because" }] },
  ).length === 0);
  // A kind no site references is a budget exemption nobody asked for; nothing looked at it
  // (the scan reads kinds *for* sites), so its reason could outlive the site it described.
  ok("a memberless kind that explains nothing is rejected", checkAllowlistShape(
    { kinds: { k: { reason: "why" } }, sites: [] },
  ).length === 1);
  ok("a memberless kind with a note passes", checkAllowlistShape(
    { kinds: { k: { reason: "why", note: "kept with no members on purpose" } }, sites: [] },
  ).length === 0);
  ok("a memberless kind whose reason begins RETIRED passes", checkAllowlistShape(
    { kinds: { k: { reason: "RETIRED (REQ-A1, round N). …" } }, sites: [] },
  ).length === 0);
  ok("the SHIPPED allow-list is well-formed (a typo in the real file must not be a green run)",
    checkAllowlistShape(readAllowlist()).length === 0);

  // --- the shipped corpus really is bound -------------------------------------------------
  const shipped = MUST_SEE_FILES.flatMap((f) =>
    budgetSites(fs.readFileSync(path.join(ROOT, f), "utf8")).map((s) => ({ f, s })),
  );
  ok(`every budget assertion in the pinned corpus is bound (found ${shipped.length})`,
    shipped.length > 0 && shipped.every(({ s }) => s.ok));

  let bad = 0;
  for (const [name, cond] of checks) {
    if (cond) console.log(`  [ok] ${name}`);
    else {
      console.error(`  [FAIL] ${name}`);
      bad += 1;
    }
  }
  if (bad === 0) console.log(`[perf-budget-scan] selftest OK — ${checks.length} case(s).`);
  else console.error(`[perf-budget-scan] selftest FAILED — ${bad}/${checks.length} case(s).`);
  process.exit(bad === 0 ? 0 : 1);
}

const IS_ENTRY = invokedDirectly(import.meta.url, process.argv[1]);
const argv = process.argv.slice(2);
if (argv.some((a) => a !== "--selftest" && a !== "--json")) {
  console.error("usage: perf-budget-scan.mjs [--selftest] [--json]");
  process.exit(2);
}
if (IS_ENTRY && argv.includes("--selftest")) runSelftest();
else if (IS_ENTRY) runScan(argv.includes("--json"));
