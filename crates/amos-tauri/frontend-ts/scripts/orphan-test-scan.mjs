#!/usr/bin/env node
/**
 * orphan-test-scan.mjs — 门禁：**每个测试文件都必须有一个 runner 会执行它**（REQ-A339）
 *
 * 为什么需要它（不是假想）：本仓有两个 runner，各自只看自己的根目录 ——
 *   * `bun`（`scripts/bun-iso-test.mjs`）：`src/__tests__/**` 与 `src/lib/__tests__/**`
 *   * `vitest`（`vitest.config.ts`）：`svelte-tests/**`
 * 而**第三类目录**（例如 `src/svelte/…/__tests__/`）落在这两者之外 ⇒ 文件会**静静地
 * 永远不跑**。这不是理论：本轮发现 `src/svelte/settings/__tests__/KeyboardPage.test.ts`
 * 正是如此 —— 它甚至**跑不起来**（DOM 测试写在了 bun 的根目录外，`document is not
 * defined`），但因为没人跑它，**没有任何门会红**。`bun-iso-test.mjs` 的注释里早就写着这个
 * 失败模式（"otherwise those files would silently never run"），只是**没有门替它守着**。
 *
 * 判据（刻意简单到不会误报）：
 *   * 收集前端下所有 `*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`
 *   * "可达" = 路径以 `src/__tests__/`、`src/lib/__tests__/`（bun）或 `svelte-tests/`（vitest）开头
 *   * 其余一律 FAIL，并给出**怎么改**（DOM 测试移到 `svelte-tests/`；纯函数测试移到
 *     `src/__tests__/` 或 `src/lib/__tests__/`）
 *
 * 例外必须写进 `scripts/test-reach-allowlist.json` **并给出理由**；**陈旧条目会失败**
 * （文件已可达、或已不存在 ⇒ 必须删掉那一条），因此豁免不会腐烂。
 *
 * 用法：
 *   node scripts/orphan-test-scan.mjs              # 门禁
 *   node scripts/orphan-test-scan.mjs --selftest   # 内嵌用例（证明分类器按说明工作）
 *   node scripts/orphan-test-scan.mjs --json       # 机器可读
 * 退出码：0 通过 / 1 有孤岛测试或 allowlist 腐烂 / 2 参数错误
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

/** The two runners' roots, and *which* runner claims each (the fix depends on it). */
const RUNNER_ROOTS = [
  { prefix: "src/__tests__/", runner: "bun" },
  { prefix: "src/lib/__tests__/", runner: "bun" },
  { prefix: "svelte-tests/", runner: "vitest" },
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "target"]);

/** Where a file lives → the runner that executes it, or `null` (an orphan). */
export function runnerFor(rel) {
  for (const { prefix, runner } of RUNNER_ROOTS) {
    if (rel.startsWith(prefix)) return runner;
  }
  return null;
}

function collect(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) collect(p, out);
    } else if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(ent.name)) {
      out.push(path.relative(ROOT, p).split(path.sep).join("/"));
    }
  }
  return out;
}

export function classify(files, allow = {}) {
  const orphans = [];
  const exempt = [];
  for (const f of files) {
    if (runnerFor(f)) continue;
    if (Object.prototype.hasOwnProperty.call(allow, f)) exempt.push(f);
    else orphans.push(f);
  }
  return { orphans, exempt };
}

/** An allowlist entry whose file is gone (or is now reachable) must be deleted, not left. */
export function staleEntries(files, allow = {}) {
  const present = new Set(files);
  return Object.keys(allow).filter((f) => !present.has(f) || runnerFor(f) !== null);
}


function main(argv) {
  const selftest = argv.includes("--selftest");
  const json = argv.includes("--json");
  const unknown = argv.filter((a) => !["--selftest", "--json"].includes(a));
  if (unknown.length) {
    console.error(`[orphan-test-scan] unknown argument(s): ${unknown.join(" ")}`);
    return 2;
  }

  if (selftest) {
    let failed = 0;
    const cases = [
      ["src/__tests__/a.test.ts", "bun"],
      ["src/lib/__tests__/a.test.ts", "bun"],
      ["src/svelte/settings/__tests__/KeyboardPage.test.ts", null],
      ["svelte-tests/shell.svelte.test.ts", "vitest"],
      ["src/svelte/__tests__/x.test.ts", null],
      ["src/lib/systemKeys.ts", null], // not a test file — `collect` never passes one in
    ];
    for (const [rel, want] of cases) {
      const got = runnerFor(rel);
      if (got !== want) {
        console.error(`  [x] runnerFor(${rel}) = ${got}, want ${want}`);
        failed += 1;
      }
    }
    const files = ["src/__tests__/a.test.ts", "src/svelte/x/__tests__/b.test.ts"];
    const { orphans, exempt } = classify(files, { "src/svelte/x/__tests__/b.test.ts": "why" });
    if (orphans.length !== 0 || exempt.length !== 1) {
      console.error(`  [x] classify with an allowlist: ${JSON.stringify({ orphans, exempt })}`);
      failed += 1;
    }
    if (staleEntries(files, { "src/svelte/x/__tests__/b.test.ts": "why" }).length !== 0) {
      console.error("  [x] a live exemption was reported stale");
      failed += 1;
    }
    const stale = staleEntries(files, {
      "src/__tests__/a.test.ts": "now reachable",
      "gone.test.ts": "gone",
    });
    if (stale.length !== 2) {
      console.error(`  [x] reachable/gone exemptions were not reported stale: ${stale}`);
      failed += 1;
    }
    const assertions = cases.length + 3;
    console.log(`[orphan-test-scan] selftest: ${assertions} assertion(s), ${failed} failure(s).`);
    return failed === 0 ? 0 : 1;
  }

  const allowPath = path.join(ROOT, "scripts", "test-reach-allowlist.json");
  const allow = fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, "utf8")) : {};
  const files = collect(ROOT);
  const { orphans, exempt } = classify(files, allow);
  const stale = staleEntries(files, allow);

  if (json) {
    console.log(JSON.stringify({ files: files.length, orphans, exempt, stale }, null, 2));
    return orphans.length || stale.length ? 1 : 0;
  }

  if (stale.length) {
    console.error(
      `[orphan-test-scan] FAIL — allowlist entr${stale.length > 1 ? "ies" : "y"} no longer needed:`,
    );
    for (const f of stale) {
      console.error(`       - ${f}  (${allow[f]})`);
      console.error(`         it is reachable by a runner now (or no longer exists) — delete it.`);
    }
  }
  if (orphans.length) {
    console.error(`[orphan-test-scan] FAIL — test file(s) no runner executes:`);
    for (const f of orphans) {
      console.error(`       - ${f}`);
      console.error(
        `         DOM test ⇒ move it to svelte-tests/ (vitest); pure test ⇒ src/__tests__/ or src/lib/__tests__/ (bun).`,
      );
    }
  }
  if (orphans.length || stale.length) return 1;

  console.log(
    `[orphan-test-scan] OK — all ${files.length} test file(s) are executed by a runner (bun: src/__tests__ + src/lib/__tests__; vitest: svelte-tests/), ${exempt.length} exempt with a reason.`,
  );
  return 0;
}

// Only run when invoked directly, so the selftest's helpers stay importable (the repo's pattern).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  process.exit(main(process.argv.slice(2)));
}
