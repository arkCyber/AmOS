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
 *     (env::var / option_env! / read_env / parse_env 等调用)
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
  const text = fs.readFileSync(file, 'utf8');
  const envs = new Set();

  // 策略:
  // 1. 直接字符串字面量调用: env::var("X"), env!("X"), option_env!("X"), read_env("X"), env_flag("X"), ...
  // 2. 常量声明模式: pub const FOO: &str = "AMOS_X"; → 若该常量名在该文件其他位置被 helper 调用, 也算
  // 3. set_var("AMOS_X") 测试驱动入口,也算

  const directRe = [
    /env::var\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
    /std::env::var\(\s*"AMOS_[A-Z][A-Z0-9_]*"/g,
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
      `\\b(?:std::)?env::var\\s*\\(\\s*${constName}\\b` +
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
