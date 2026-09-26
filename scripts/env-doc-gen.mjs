#!/usr/bin/env node
/**
 * env-doc-gen.mjs — AmOS ENV 变量文档生成/校验
 *
 * 模式:
 *   --check          检查 docs/ENV_VARIABLES.md 与代码扫描结果一致
 *   --emit-json      机器可读 JSON 列表(用于 CI / 其它门禁消费)
 *   --self-test      内嵌用例,证明门禁本身可靠
 *
 * 扫描源:
 *   - crates 目录树下所有 .rs 文件中出现的 "AMOS_*" 字面量
 *     (env::var / env::var_os / option_env! / read_env / parse_env 等调用)
 *   - crates 目录树下 src/bin 同样扫描
 *
 * 不替代代码 —— 仅供文档同步与失配检测。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RUST_SRC_GLOBS = ['crates'];
const ENV_DOC = path.join(ROOT, 'docs/ENV_VARIABLES.md');

const ENV_NAME_RE = /"AMOS_[A-Z][A-Z0-9_]*"/g;
const OTHER_ENV_RE = /"[A-Z][A-Z0-9_]{3,}"/g;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'target' || ent.name === 'node_modules' || ent.name === 'dist') continue;
      walk(p, files);
    } else if (ent.isFile() && p.endsWith('.rs')) {
      files.push(p);
    }
  }
  return files;
}

function scanRustFiles() {
  const files = [];
  for (const root of RUST_SRC_GLOBS) {
    const abs = path.join(ROOT, root);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  return files;
}

function extractEnvsFromFile(file) {
  return extractEnvsFromText(fs.readFileSync(file, 'utf8'));
}

/**
 * Skip a Rust double-quoted string starting at `i` (which must be the opening
 * `"`), returning the index of the closing quote — honouring `\` escapes so a
 * `\"` inside the literal does not end it early.
 */
function skipString(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '"') return j;
  }
  return text.length - 1;
}

/**
 * The brace-matched body of the `fn` whose signature begins at `sigIndex`, with
 * line and block comments plus string literals skipped so a brace inside either
 * does not unbalance the match. `null` when the signature has no `{` body.
 */
function fnBodyAt(text, sigIndex) {
  const open = text.indexOf('{', sigIndex);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '"') { i = skipString(text, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}

/**
 * Names of local fns that forward a **parameter** into `env::var` — e.g.
 * `fn pick(name: &str, file: &str) { … std::env::var(name) … }` called as
 * `pick("AMOS_PODCAST_SUBSCRIPTIONS", …)`.
 *
 * The direct-call scan can only see a literal written *at* the call, so every
 * env name that reaches the environment through such a helper was invisible:
 * `amos-podcast`'s four per-store paths read through `pick`, and the doc gate
 * structurally **forbade** documenting them (adding the names flipped the check
 * to "lists ENVs not used in code"). The corpus must be *the use site* — a value
 * handed to something that calls `env::var` — not the spelling of the helper
 * (REQ-A1906 / F-DEV-167).
 */
function collectForwardingHelpers(text) {
  const names = new Set();

  /** `bodyStart` is where the parameter list ends; the body is the brace-matched
   * block if one opens before the next `;`, otherwise the expression up to it. */
  const consider = (name, paramsSrc, bodyStart) => {
    const params = paramsSrc
      .split(',')
      .map(p => p.split(':')[0].trim())
      .filter(p => /^[a-z_][A-Za-z0-9_]*$/.test(p) && p !== 'mut');
    if (params.length === 0) return;
    const open = text.indexOf('{', bodyStart);
    const semi = text.indexOf(';', bodyStart);
    let body = null;
    if (open !== -1 && (semi === -1 || open < semi)) body = fnBodyAt(text, bodyStart);
    else if (semi !== -1) body = text.slice(bodyStart, semi);
    if (!body) return;
    if (params.some(p => new RegExp(`env::var(?:_os)?\\s*\\(\\s*${p}\\b`).test(body))) {
      names.add(name);
    }
  };

  for (const m of text.matchAll(/\bfn\s+([a-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g)) {
    consider(m[1], m[2], m.index + m[0].length);
  }
  // Closures are the shape that hid the podcast stores: `let pick = |name: &str,
  // file: &str| -> Option<PathBuf> { … }` — no `fn` keyword to match on.
  for (const m of text.matchAll(/\blet\s+([a-z_][A-Za-z0-9_]*)\s*=\s*(?:move\s*)?\|([^|]*)\|/g)) {
    consider(m[1], m[2], m.index + m[0].length);
  }
  return names;
}

function extractEnvsFromText(text) {
  const envs = new Set();

  // 策略:
  // 1. 直接字符串字面量调用: env::var("X"), env!("X"), option_env!("X"), read_env("X"), env_flag("X"), ...
  // 2. 常量声明模式: pub const FOO: &str = "AMOS_X"; → 若该常量名在该文件其他位置被 helper 调用, 也算
  // 3. set_var("AMOS_X") 测试驱动入口,也算

  const directRe = [
    /env::var(?:_os)?\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
    /std::env::var(?:_os)?\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
    /env!\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
    /option_env!\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
    /read_env\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
    /\b(?:env_flag|get_env|env_or|env_or_default|env_bool|env_int|env_string|opt_env_u32|opt_env_i32|env_governor_flag|env_parsed|env_parse_or|env_value)\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
    /set_var\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
  ];
  for (const re of directRe) {
    for (const m of text.matchAll(re)) {
      const n = m[0].match(/"AMOS_[A-Z][A-Z0-9_]*"/);
      if (n) envs.add(n[0].slice(1, -1));
    }
  }

  // (b) 常量声明 + 同文件被 helper 调用
  const constDecls = [...text.matchAll(/(?:pub\s+)?const\s+(\w+)\s*:\s*&str\s*=\s*"(AMOS_[A-Z][A-Z0-9_]*)"/g)];
  for (const m of constDecls) {
    const constName = m[1];
    const envName = m[2];
    // 查找该常量名是否在文件中被 helper 调用
    const helperCallRe = new RegExp(
      `\\b(?:std::)?env::var(?:_os)?\\s*\\(\\s*${constName}\\b` +
      `|\\b(?:env_flag|get_env|env_or|env_or_default|env_bool|env_int|env_string|opt_env_u32|opt_env_i32|env_governor_flag|env_parsed|env_parse_or|env_value)\\s*\\(\\s*${constName}\\b`
    );
    if (helperCallRe.test(text)) {
      envs.add(envName);
    } else {
      // 兜底:即使是 const 声明,只要值是 "AMOS_*" 也加入,因为它几乎一定是 env 名
      // (下一轮 --check 会通过文档覆盖检测漏报)
      envs.add(envName);
    }
  }

  // (c) 经由**转发型 helper** 的读取: `fn pick(name: &str, …) { env::var(name) }`
  //     的调用点 `pick("AMOS_X", …)`。直接调用的正则看不到它 —— 字面量是在
  //     helper 内部以**参数**到达 `env::var` 的(REQ-A1906 / F-DEV-167)。
  for (const helper of collectForwardingHelpers(text)) {
    const callRe = new RegExp(`\\b${helper}\\s*\\(\\s*"(AMOS_[A-Z][A-Z0-9_]*)"`, 'g');
    for (const m of text.matchAll(callRe)) envs.add(m[1]);
  }

  return [...envs];
}

function buildInventory() {
  const files = scanRustFiles();
  /** @type {Record<string, {files: string[], mentions: number}>} */
  const inv = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const envs = extractEnvsFromFile(f);
    for (const e of envs) {
      inv[e] ??= { files: [], mentions: 0 };
      inv[e].files.push(rel);
      inv[e].mentions += 1;
    }
  }
  return inv;
}

function parseEnvDoc() {
  if (!fs.existsSync(ENV_DOC)) return { found: new Set(), missing: true };
  const text = fs.readFileSync(ENV_DOC, 'utf8');
  const found = new Set();
  for (const m of text.matchAll(/`?(AMOS_[A-Z][A-Z0-9_]*)`?/g)) {
    if (text.includes(m[1])) found.add(m[1]);
  }
  return { found, missing: false };
}

function cmdCheck() {
  const inv = buildInventory();
  const { found, missing } = parseEnvDoc();
  if (missing) {
    console.error(`[FAIL] env-doc: ${ENV_DOC} not found. Run \`make env-doc\`.`);
    process.exit(1);
  }
  const inCode = new Set(Object.keys(inv));
  const inDocButNotCode = [...found].filter(e => !inCode.has(e));
  const inCodeButNotDoc = [...inCode].filter(e => !found.has(e));
  let bad = false;
  if (inCodeButNotDoc.length) {
    bad = true;
    console.error(`[FAIL] env-doc: code declares ENVs not in ${path.basename(ENV_DOC)}:`);
    for (const e of inCodeButNotDoc) console.error(`       - ${e}`);
  }
  if (inDocButNotCode.length) {
    bad = true;
    console.error(`[FAIL] env-doc: ${path.basename(ENV_DOC)} lists ENVs not used in code:`);
    for (const e of inDocButNotCode) console.error(`       - ${e}`);
  }
  if (bad) {
    console.error('');
    console.error(`Fix: update ${path.basename(ENV_DOC)} (table entries), then re-run.`);
    process.exit(1);
  }
  console.log(`[OK] env-doc: ${inCode.size} ENVs in code and documented.`);
}

function cmdEmitJson() {
  const inv = buildInventory();
  const out = [];
  for (const [name, info] of Object.entries(inv).sort()) {
    out.push({
      name,
      mentions: info.mentions,
      files: info.files,
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

function cmdSelfTest() {
  const tests = [
    {
      name: 'scans a known ENV from amos-ai',
      run: () => {
        const inv = buildInventory();
        assert(inv['AMOS_BACKEND'] || inv['AMOS_SOCKET'] || inv['AMOS_TCP_TOKEN'],
          'expected at least one well-known AMOS_* to be discovered');
      },
    },
    {
      name: 'returns Set of unique ENV names',
      run: () => {
        const inv = buildInventory();
        const keys = Object.keys(inv);
        assert(keys.every(k => /^AMOS_[A-Z][A-Z0-9_]*$/.test(k)), 'all keys must match AMOS_* pattern');
        assert(new Set(keys).size === keys.length, 'keys must be unique');
      },
    },
    {
      name: 'tracks per-file mentions',
      run: () => {
        const inv = buildInventory();
        for (const [name, info] of Object.entries(inv)) {
          assert(info.files.length >= 1, `${name}: at least one file`);
          assert(info.mentions >= info.files.length, `${name}: mentions >= files`);
        }
      },
    },
    {
      name: 'excludes target/ and node_modules/',
      run: () => {
        const inv = buildInventory();
        for (const info of Object.values(inv)) {
          for (const f of info.files) {
            assert(!f.includes('target/'), `must not scan target/: ${f}`);
            assert(!f.includes('node_modules/'), `must not scan node_modules/: ${f}`);
          }
        }
      },
    },
    {
      name: 'ENV name regex matches expected shape',
      run: () => {
        const sample = '"AMOS_BACKEND" "AMOS_TCP_TOKEN" "AMOS_RAG_DIM"';
        const matches = [...sample.matchAll(/"AMOS_[A-Z][A-Z0-9_]*"/g)].map(m => m[0].slice(1, -1));
        assert(JSON.stringify(matches) === '["AMOS_BACKEND","AMOS_TCP_TOKEN","AMOS_RAG_DIM"]',
          `unexpected matches: ${matches}`);
      },
    },
    {
      name: 'doc parser extracts ENV names from backticks',
      run: () => {
        const sample = '`AMOS_BACKEND` and AMOS_TCP_TOKEN both work.';
        const matches = [...sample.matchAll(/`?(AMOS_[A-Z][A-Z0-9_]*)`?/g)].map(m => m[1]);
        assert(matches.length === 2, `expected 2, got ${matches.length}`);
      },
    },
    {
      // The blind spot this round closes: a name whose literal reaches
      // `env::var` through a **parameter** (`amos-podcast`'s `pick`). Before the
      // fix the direct-call scan missed it, and the doc side *forbade*
      // documenting it ("lists ENVs not used in code").
      name: 'a value forwarded through a helper parameter is discovered',
      run: () => {
        const fnSample = [
          'fn pick(name: &str, file: &str) -> Option<PathBuf> {',
          '    if let Ok(v) = std::env::var(name) { return Some(v.into()); }',
          '    None',
          '}',
          'let subs = pick("AMOS_PROBE_FORWARDED", "x.json");',
        ].join('\n');
        const gotFn = extractEnvsFromText(fnSample);
        assert(gotFn.includes('AMOS_PROBE_FORWARDED'),
          `expected the forwarded name via a fn, got ${gotFn}`);

        // The shape that actually hid the podcast store paths — a closure.
        const closureSample = [
          'let pick = |name: &str, file: &str| -> Option<PathBuf> {',
          '    if let Ok(v) = std::env::var(name) { return Some(v.into()); }',
          '    None',
          '};',
          'let subs = pick("AMOS_PROBE_CLOSURE", "x.json");',
        ].join('\n');
        const gotClosure = extractEnvsFromText(closureSample);
        assert(gotClosure.includes('AMOS_PROBE_CLOSURE'),
          `expected the forwarded name via a closure, got ${gotClosure}`);
      },
    },
    {
      // The sibling read style: `env::var_os` returns `Option<OsString>` and is
      // how the F-AI-026 lineage keeps "unset" distinct from "not valid
      // Unicode". A gate that spells the use site `env::var` alone is blind to
      // it — the podcast live gate reads `AMOS_PODCAST_LIVE` through `var_os`,
      // so the doc row looked like an ENV "not used in code" (REQ-A1906).
      name: 'a value read through env::var_os is a use site',
      run: () => {
        const sample = [
          'fn live_enabled() -> bool {',
          '    decide_live(std::env::var_os("AMOS_PROBE_OS").as_deref())',
          '}',
        ].join('\n');
        const got = extractEnvsFromText(sample);
        assert(got.includes('AMOS_PROBE_OS'),
          `expected env::var_os to count as a use site, got ${got}`);

        // And through a forwarding parameter, the forwarded name must survive too.
        const forwarded = [
          'fn read(name: &str) -> Option<OsString> { std::env::var_os(name) }',
          'let v = read("AMOS_PROBE_OS_FORWARDED");',
        ].join('\n');
        const gotForwarded = extractEnvsFromText(forwarded);
        assert(gotForwarded.includes('AMOS_PROBE_OS_FORWARDED'),
          `expected a var_os-forwarding helper to be followed, got ${gotForwarded}`);
      },
    },
    {
      // Disjoint negative control: the rule is "the parameter reaches
      // `env::var`", **not** "any `"AMOS_*"` argument". A helper that merely
      // takes a parameter must not make its argument look like an env name.
      name: 'a helper parameter not forwarded to env::var is not a use site',
      run: () => {
        const sample = [
          'fn join(a: &str, b: &str) -> String { format!("{a}{b}") }',
          'let s = join("AMOS_PROBE_NOT_ENV", "x");',
        ].join('\n');
        const got = extractEnvsFromText(sample);
        assert(!got.includes('AMOS_PROBE_NOT_ENV'),
          `must not invent an env from a non-forwarding helper, got ${got}`);
      },
    },
    {
      name: 'the real tree discovers the helper-forwarded podcast store names',
      run: () => {
        const inv = buildInventory();
        for (const n of ['AMOS_PODCAST_SUBSCRIPTIONS', 'AMOS_PODCAST_LIBRARY',
          'AMOS_PODCAST_PROGRESS', 'AMOS_PODCAST_DOWNLOADS']) {
          assert(inv[n], `expected ${n} (read via amos-podcast's pick helper)`);
        }
      },
    },
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${t.name}: ${err.message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} self-test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} self-tests passed.`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cmd = process.argv[2] || '--check';
if (cmd === '--check') cmdCheck();
else if (cmd === '--emit-json') cmdEmitJson();
else if (cmd === '--self-test') cmdSelfTest();
else {
  console.error('Usage: env-doc-gen.mjs [--check | --emit-json | --self-test]');
  process.exit(2);
}
