#!/usr/bin/env node
/**
 * dead-member-scan.mjs — 「类成员定义了，但生产里没有任何人提到它」（REQ-A897）。
 *
 * ## 为什么需要它：`unwired-scan` 的单位是**模块导出**，不是成员
 *
 * `unwired-scan` 抓的是「一个 `export` 没有生产引用」；`tsc` 抓不到，因为
 * `noUnusedLocals` 豁免 `export`。但**类的成员**连 `export` 都不是：一个 public 方法
 * 只在类体里出现一次，`tsc` 一声不响，`unwired-scan` 的语料里也根本没有它。
 * 2026-09-22 实测：这一族在本仓库有 **31** 个实例（另 2 个在本判据的地板之下，见下），
 * 全部落在 `src/lib/enterprise/**` 与 `cloudSync.ts` —— 也就是说整个前端的其它
 * 386 个生产文件里一个都没有。而其中**至少一个已经在生产里造成过真实的空白**：
 *
 *   * `AuditLogger.flushBuffer()` —— 公开的「把缓冲区搬进主数组」入口，生产里零调用者
 *     （写满自动落盘走的是旁边那份**字节相同**的私有 `flush()`），于是挂载着的
 *     `AuditLogViewer` 在设备上一行都读不到。28 条测试在调 `flushBuffer()`，
 *     也就是测试自己补上了生产从不做的那一步 —— 全绿。
 *   * `MDMManager.checkDailyExecutionLimit()` / `checkActionCount()` —— 名字、文档齐全的
 *     策略判据，生产零调用者，因为 `checkCanExecute()` 把它们**手工内联**了一遍。
 *
 * 这两个形状是同一件事：**名字在文档里、在测试里、在类型里，就是不在执行路径上。**
 * 本闸门就是让这一类重新可见。
 *
 * ## 判据（精确到「这个名字，除了它自己的声明之外，还有人提过吗」）
 *
 * 对每个类成员 M（方法 / `get` / `set`），在**生产**语料里数 `M.name` 这个标识符出现
 * 的次数，但**跳过**两类位置：
 *
 *   1. **成员声明本身**（`MethodDeclaration` / `Getter` / `Setter` / `PropertyDeclaration`
 *      的名字位）—— 否则同名的两个类会互相「证明」对方活着（`initialize`、`shutdown`
 *      这类名字在本仓库到处都是，第一版就是这么漏的：`flush()` 即使删掉，
 *      `MDMManager`/`TemplateManager` 各自的成员声明也会让计数 ≥ 2）；
 *   2. **import/export 说明符**（`import { initialize } from …`）—— 那指向的是模块导出，
 *      不是某个类的成员。
 *
 * 其余任何位置都算引用：`this.x()`（同类内互相调用）、`obj.x()`、`handler.x`、
 * 对象字面量简写 `{ x }`、甚至只是 `"x"` 之外的一次裸提到。所以判据是**保守**的 ——
 * 它只会漏报（有引用被误算成引用），不会把活着的成员报成死的。
 *
 * ## 边界（都是量出来的，不是方便）
 *
 * * **只数类成员，不数对象字面量的成员。** 工厂返回的对象（`dragGesture()` 返回
 *   `{ onpointermove … }`、`createKeyboardBindings()` 返回 `{ getSystemShortcut … }`）
 *   的成员是**被展开/解构**消费的（`{...dragGesture(...)}` 贴到元素上），文本上
 *   根本不是「按名字调用」。实测（2026-09-22）：把对象字面量纳进来会多出 2 个
 *   假阳性，且都是这一种。删掉这一类会把真缺陷一起删掉，所以两类分开处理。
 * * **测试文件只作为「信息」列出来，不参与判活。** 一个成员只在测试里被用，正是本族
 *   缺陷的形状（`checkDailyExecutionLimit` 有 18 处测试引用）。报告里会打出
 *   `testHits`，但判据只看生产。
 * * **不用正则猜结构。** 结构与 `lib-coverage-gate.mjs` 同一个先例：`require("typescript")`。
 *   拿不到 typescript 时本闸门**直接报错退出**，不降级 —— 一个「看不见任何东西所以全绿」
 *   的闸门正是这套审计要防的东西。
 *
 * 用法（在 frontend-ts 下）：
 *   node scripts/dead-member-scan.mjs               # 闸门（有新增即非零退出）
 *   node scripts/dead-member-scan.mjs --json        # 机器可读
 *   node scripts/dead-member-scan.mjs --selftest    # 钉住提取器与判据
 *   node scripts/dead-member-scan.mjs --update-allowlist
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
const SRC = join(ROOT, "src");
const ALLOWLIST_PATH = join(HERE, "dead-member-allowlist.json");
const RECEIVER_ALLOWLIST_PATH = join(HERE, "dead-member-receiver-allowlist.json");

/**
 * 双向的针（REQ-A897）：`MUST_SEE` 防「提取器坏了把普查清空」，`MUST_NOT_SEE`
 * 防「本轮的修复被回退」—— `flushBuffer()` 修好之后就有生产调用者了，
 * 它若重新出现在普查里，说明 `log()`/定时器/`shutdown()` 又各自拿回了自己那份实现。
 */
export const MUST_SEE = [
  // 仍然是死的：现在是 `checkActionAllowed()` 的适配器，而执行路径走的是
  // `firstDisabledAction → checkActionAllowed`，没有生产调用者。留着的理由（公开 API +
  // `@deprecated` 指路）写在白名单条目里。
  "MDMManager.isActionDisabled",
  "TemplateManager.publishTemplate",
];
export const MUST_NOT_SEE = [
  "AuditLogger.flushBuffer",
  // REQ-A899：这两条是本轮的**修复方向** —— `checkCanExecute()` 不再内联它们，
  // 于是它们从「命名但没人调用的判据」变成「被调用的唯一定义」。它们若重新出现在
  // 普查里，说明内联副本又回来了（`mdm-restriction-scan` 的读站点表也会同时红）。
  "MDMManager.checkDailyExecutionLimit",
  "MDMManager.checkActionCount",
];

/**
 * 「名字活着、接收者死」这一桶的**双向针**（REQ-A946）。
 *
 * `MUST_SEE` 防「接收者解析器坏了、把桶清空」—— 解析器一旦退化成"什么都解不出"，
 * 这一桶会**静悄悄地变空**，而不是红。所以钉住两条今天确实在这个桶里的成员。
 * `MUST_NOT_SEE` 防反向的坏法：「解不出接收者就当成死的」这种过度上报。两条都是
 * 生产里被**真的按接收者调过**的成员，它们若出现在这一桶里，说明解析器把
 * 局部变量/别名认错了（`project_gate_name_resolution_scope` 那个坑）。
 */
export const MUST_SEE_RECEIVER_DEAD = [
  // `updateConfig` 是 `configChosen` 的**唯一**写者，而它零生产调用者 —— 也正因为
  // 如此，`loadConfig()` 里那条 `if (this.configChosen) return;` 在生产里不可达。
  "AuditLogger.updateConfig",
  // 面板自己写了一份（走 `apiClient.request`，因而带着 REQ-A819 的判词语义）。
  "APIClient.testConnection",
];
export const MUST_NOT_SEE_RECEIVER_DEAD = [
  "MDMManager.ensureInitialized",
  "MDMManager.checkActionAllowed",
  "AuditLogger.log",
  "AuditLogger.query",
];

function getTS() {
  try {
    return require("typescript");
  } catch {
    console.error(
      "[dead-member-scan] 需要 devDependency `typescript` 来读结构；拿不到就拒绝运行\n" +
        "（不降级成正则猜测：猜错的普查比没有普查更糟）。请先在 frontend-ts 下 `bun install`。",
    );
    process.exit(2);
  }
}

const isTestPath = (p) => /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.ts$/.test(p);

/**
 * 判据的**地板**：名字与内建集合方法同名的成员，本闸门看不见（`Map.get`、`Set.delete`
 * 之类的调用会把计数抬起来，于是死成员被误当活）。2026-09-22 实测生产里正好 2 个：
 * `APIClient.get` 与 `APIClient.delete`（同一族里 `post` 是报到过的 —— 它没被谁撞名；
 * `put` 也被撞掉了，撞它的是 `mediaStore.put` / `IDBObjectStore.put`，**不在**这张表里，
 * 见下面那句「这张表只枚举了内建集合方法这一个来源」）。这两个不是"通过"，是"没测到"，所以单列出来打印，
 * 不进普查、不进白名单 —— 让地板**可见**，而不是让它伪装成绿。
 *
 * 这张表只枚举了**内建集合方法**这一个来源，所以它是一张**不完全**的地板清单：
 * 任何一个在生产里被别处（别的类的成员、普通对象的方法、局部变量）用过的同名成员，
 * 本闸门都看不见。`APIClient.put` 就是活例子。补法是把 `refs` 做成"按接收者解析"，
 * 属下一轮；在此之前，`--json` 的 `dead` 是**下界**，不是清单。
 */
export const AMBIGUOUS_NAMES = new Set([
  "get", "set", "delete", "has", "add", "clear", "keys", "values", "entries",
  "forEach", "push", "map", "filter", "includes", "toString", "toJSON",
  "then", "catch", "finally", "call", "apply", "bind", "concat", "slice",
  "split", "trim", "replace", "test", "exec", "sort", "find", "join", "at",
]);

/** 生产里的待扫文件：`.ts`（除 `.d.ts`/测试）与 `.svelte`。 */
export function productionFiles(dir = SRC) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|svelte)$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** `.svelte` 只看 `<script>` 块（模板/样式里没有类声明）。长度与原文一致，行号不漂。 */
export function scriptOf(path, src) {
  if (!path.endsWith(".svelte")) return src;
  let out = "";
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  let last = 0;
  while ((m = re.exec(src))) {
    out += " ".repeat(m.index - last) + m[1];
    last = m.index + m[0].length - (m[0].length - m[1].length);
  }
  return out.length ? out : src;
}

const parse = (ts, path, src) =>
  ts.createSourceFile(
    path,
    scriptOf(path, src),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".svelte") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** 这个名字位是不是「声明」——声明自己不算引用。 */
function isDeclName(ts, node) {
  const p = node.parent;
  if (!p || p.name !== node) return false;
  return (
    ts.isMethodDeclaration(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isPropertySignature(p) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p)
  );
}

/**
 * 从一个源文件里取出**类成员**声明。
 * 只认类（`class` 声明与类表达式），不认对象字面量 —— 见头部的边界说明。
 */
export function classMembers(ts, path, src) {
  const sf = parse(ts, path, src);
  const out = [];
  const visit = (n) => {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      for (const m of n.members) {
        const isAccessor = ts.isGetAccessor(m) || ts.isSetAccessor(m);
        if (!(ts.isMethodDeclaration(m) || isAccessor)) continue;
        if (!m.name || !ts.isIdentifier(m.name)) continue;
        out.push({
          file: path,
          cls: n.name?.text ?? "<anonymous>",
          name: m.name.text,
          kind: isAccessor ? (ts.isGetAccessor(m) ? "get" : "set") : "method",
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * 生产语料里每一处「名字位」的出现（已排除声明位与 import/export 说明符）。
 * 返回 `Map<name, count>`。
 */
export function referenceCounts(ts, files) {
  const counts = new Map();
  for (const { path, src } of files) {
    const sf = parse(ts, path, src);
    const visit = (n) => {
      if (ts.isIdentifier(n) && !isDeclName(ts, n)) {
        counts.set(n.text, (counts.get(n.text) ?? 0) + 1);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return counts;
}

// ============================================================================
// 按接收者解析（REQ-A946）—— 把上面 `AMBIGUOUS_NAMES` 文档里那句「属下一轮」做掉
// ============================================================================
//
// `referenceCounts` 是**名字级**的：一个成员的名字只要在别处被用过（别的类的成员、
// 普通对象的方法、局部变量、形参），计数就抬起来。于是「名字活着、调用者不存在」
// 这个形状本闸门看不见 —— `APIClient.put`（撞 `mediaStore.put`）是活例子，
// `AuditLogger.updateConfig`（它的名字在注释里被反复提到）也是。
//
// 下面的分析把**调用点的接收者**解出来，于是「类 C 的成员 M 被 X.M() 调用」与
// 「名字 M 被别的东西用了」可以分开。三条解析规则，都**只在能解出接收者时**才判定：
//
//   1. 同文件内的类型标注（`const m: MDMManager = …` / `private s: SyncScheduler`，
//      以及函数形参 `x: APIClient`）；
//   2. **导出单例别名表**（`export const mdmManager = new MDMManager()`，
//      或带标注的 `export const apiClient: APIClient = …`）—— 而且**该文件必须真的
//      导入了那个别名**，不按名字猜身份（REQ-A863 的教训：一张语料级的「名字→键」
//      表会按目录遍历顺序作答，把 10/152 个写站点判给了它并不写的那个键）；
//   3. `this`（同类内互调），以及 `this.<属性>` 的标注。
//
// 判据**保守**：解不出接收者就不算「这里调过」，所以它只会让某个成员**留在**
// 「接收者死」那一桶里，不会把活的报成死的 —— 一个假阳性的代价是白写一条理由，
// 一个假阴性的代价是这个形状继续隐形（本闸门存在的理由）。
//
// 级联抑制：接收者本身如果是一个**已登记**的未接线导出（`unwired-baseline.json`
// 的 `values`，或 `unwired-allowlist.json` 里带理由的那条），它的成员就不是新消息
// —— 整个模块本来就没接线。这些进 `cascade` 桶，不判定、不要求理由；否则
// `CloudSyncScheduler` 一个模块就会往新桶里灌 9 条同一条根因。

/**
 * 导出单例别名表：`export const X = new C()` 与 `export const X: C = …`。
 * 返回 `Map<导出名, {cls, file}>`。同一个名字在多文件导出时**后读到的覆盖先读到的**
 * —— 所以消费侧还要求「本文件真的导入了这个名字」，见 `receiverSites`。
 */
export function singletonAliases(ts, prod) {
  const out = new Map();
  for (const { path, src } of prod) {
    const sf = parse(ts, path, src);
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        let cls = null;
        if (
          d.initializer &&
          ts.isNewExpression(d.initializer) &&
          ts.isIdentifier(d.initializer.expression)
        ) {
          cls = d.initializer.expression.text;
        } else if (d.type && ts.isTypeReferenceNode(d.type) && ts.isIdentifier(d.type.typeName)) {
          cls = d.type.typeName.text;
        }
        if (cls) out.set(d.name.text, { cls, file: path });
      }
    }
  }
  return out;
}

/**
 * 一个文件里「名字 → 类名」的标注。三个来源，都会用一个**本文件看得见的**类名：
 *
 *   1. 显式标注（`const m: MDMManager = …`、形参 `x: APIClient`、类属性 `private s: S`）；
 *   2. `new C(…)` 的初始化式（`const runtime = new ShortcutTriggerRuntime({…})`）——
 *      这是生产里的常见写法（依赖注入的构造实参），不认它就等于把整个
 *      `ShortcutTriggerRuntime` 误报成死的（实测：加上这一条，`start`/`fire`/`stop`/`sync`
 *      四条里三条当场变活）；
 *   3. 本文件自己的 `class C` 声明（`new C()` 与 `class C` 都在这里时，"看得见"成立）。
 *
 * 返回 `{ types, localClasses }`：前者是 `Map<name, cls>`，后者是"本文件声明的类名"集合
 * —— 别名表与 `new` 推断都要用它来确认"这个名字在本文件里真的能指到那个类"。
 */
function fileAnnotations(ts, sf) {
  const out = new Map();
  const localClasses = new Set();
  const clsOfNew = (init) => {
    if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
      return init.expression.text;
    }
    return null;
  };
  const add = (nameNode, typeNode, init) => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    // 先到先得：同名标注冲突时保守地保留第一个（见上面"保守"那段）。
    if (out.has(nameNode.text)) return;
    if (typeNode && ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
      out.set(nameNode.text, typeNode.typeName.text);
      return;
    }
    const c = clsOfNew(init);
    if (c) out.set(nameNode.text, c);
  };
  const visit = (n) => {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      if (n.name) localClasses.add(n.name.text);
    }
    if (ts.isVariableDeclaration(n)) add(n.name, n.type, n.initializer);
    else if (ts.isParameter(n)) add(n.name, n.type, undefined);
    else if (ts.isPropertyDeclaration(n)) add(n.name, n.type, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { types: out, localClasses };
}

/** 本文件 `import` 进来的标识符（默认 / 命名 / 命名空间）。 */
function importedNames(ts, sf) {
  const out = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    if (c.name) out.add(c.name.text);
    const b = c.namedBindings;
    if (b) {
      if (ts.isNamespaceImport(b)) out.add(b.name.text);
      else for (const e of b.elements) out.add(e.name.text);
    }
  }
  return out;
}

/** 从 `node` 往上找最近的类名（`this` 落在哪一类里）。 */
function enclosingClass(ts, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p.name?.text ?? null;
  }
  return null;
}

/**
 * 解一个接收者表达式**指向哪个类**。解不出回 `null`（保守）。
 * `locals` 是**本文件**的标注表，`aliases` 是全局单例表，`imports` 是本文件的导入名。
 */
export function resolveReceiverClass(ts, recv, locals, aliases, imports, selfClass, file) {
  if (recv.kind === ts.SyntaxKind.ThisKeyword) return selfClass;
  if (ts.isIdentifier(recv)) {
    const n = recv.text;
    if (locals.has(n)) return locals.get(n);
    const a = aliases.get(n);
    // 只在该名字**真的看得见**时才认：本文件导入了它，或者它本来就声明在本文件里。
    // 否则一个同名的局部变量会被当成别人的单例 —— REQ-A863 那个
    // 「语料级的名字→键表按目录遍历顺序作答」的坑。
    if (a && (imports.has(n) || a.file === file)) return a.cls;
    return null;
  }
  // `this.someProp.M(...)`：属性有自己的标注。
  if (
    ts.isPropertyAccessExpression(recv) &&
    recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(recv.name)
  ) {
    return locals.get(recv.name) ?? null;
  }
  return null;
}

/** 生产语料里所有**能解出接收者**的 `X.M` 站点，返回 `[{cls, name, file, line}]`。 */
export function receiverSites(ts, prod) {
  const aliases = singletonAliases(ts, prod);
  const sites = [];
  for (const { path, src } of prod) {
    const sf = parse(ts, path, src);
    const imports = importedNames(ts, sf);
    const { types, localClasses } = fileAnnotations(ts, sf);
    // 只留"这个类名在本文件里真的指得到"的映射：导入了，或者本文件自己声明了。
    // 少了这道，一个同名的工厂函数会被当成人家的类（REQ-A863 的坑）。
    const locals = new Map();
    for (const [n, c] of types) {
      if (imports.has(c) || localClasses.has(c)) locals.set(n, c);
    }
    const visit = (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
        const cls = resolveReceiverClass(
          ts,
          n.expression,
          locals,
          aliases,
          imports,
          enclosingClass(ts, n),
          path,
        );
        if (cls) {
          sites.push({
            cls,
            name: n.name.text,
            file: path,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites;
}

/**
 * 普查：一套**虚拟文件**（`{path, src}`）进，死的类成员出。
 *
 * 判据一句话：这个名字在**生产**里除声明位之外一次都没被提到。同类内互相调用
 * （`this.x()`）是提及，所以「私有小助手」不会被误报。
 *
 * `deadExports`（可选）是**已登记未接线**的导出键集合（`<文件>::<导出名>`）。里面有
 * 的那个类，它的「名字活着、接收者死」成员进 `cascade` 桶 —— 整块本来就没接线，
 * 逐条列它的成员只是把一条根因抄 N 遍。
 */
export function census(ts, all, { deadExports = new Set() } = {}) {
  const prod = all.filter((f) => !isTestPath(f.path));
  const members = [];
  for (const f of prod) members.push(...classMembers(ts, f.path, f.src));

  const refs = referenceCounts(ts, prod);
  const testRefs = referenceCounts(
    ts,
    all.filter((f) => isTestPath(f.path)),
  );

  const dead = [];
  const unadjudicable = [];
  // 接收者解析：`类.成员` → 生产里**真的按接收者**调过几次。
  const sites = receiverSites(ts, prod);
  const recvCounts = new Map();
  for (const s of sites) {
    const k = `${s.cls}.${s.name}`;
    recvCounts.set(k, (recvCounts.get(k) ?? 0) + 1);
  }
  // 类名 → 它的导出键（`<文件>::<导出名>`），用来查级联。两个来源：导出单例
  // （`export const r = new R()`）与**直接导出的类**（`export class R`）——后者
  // 也要算，否则 `cloudSync.ts` 那四个 resolver（只作为类导出）查不到级联。
  const aliases = singletonAliases(ts, prod);
  const classExports = new Map();
  const addExport = (cls, key) => {
    if (!classExports.has(cls)) classExports.set(cls, new Set());
    classExports.get(cls).add(key);
  };
  for (const [exportName, { cls, file }] of aliases) addExport(cls, `${file}::${exportName}`);
  for (const { path, src } of prod) {
    const sf = parse(ts, path, src);
    for (const st of sf.statements) {
      if (!ts.isClassDeclaration(st) || !st.name) continue;
      if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      addExport(st.name.text, `${path}::${st.name.text}`);
    }
  }

  const receiverDead = [];
  const cascade = [];
  for (const m of members) {
    if (AMBIGUOUS_NAMES.has(m.name)) {
      unadjudicable.push(m);
      continue;
    }
    // 声明本身不在 `refs` 里（`isDeclName` 把它排掉了），所以「0 次」就是死。
    if ((refs.get(m.name) ?? 0) === 0) {
      dead.push({ ...m, testHits: testRefs.get(m.name) ?? 0 });
      continue;
    }
    // 名字活着。那么它是**真的被调用**，还是只是名字在别处被用过？
    if ((recvCounts.get(`${m.cls}.${m.name}`) ?? 0) > 0) continue;
    const entry = { ...m, testHits: testRefs.get(m.name) ?? 0, nameRefs: refs.get(m.name) ?? 0 };
    // 级联：这个类的单例导出本身已登记为"未接线"（带理由或不带），那它的成员
    // 不是新消息 —— 整块没接线，逐条列只是把一条根因抄 N 遍。
    const exps = classExports.get(m.cls);
    const hit = exps
      ? [...exps].find(
          (k) => deadExports.has(k) || deadExports.has(`${k.split("::")[0]}::*`),
        )
      : undefined;
    if (hit) cascade.push({ ...entry, via: hit });
    else receiverDead.push(entry);
  }
  const byName = (a, b) =>
    b.testHits - a.testHits || a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  dead.sort(byName);
  receiverDead.sort(byName);
  cascade.sort(byName);
  return {
    files: prod.length,
    members: members.length,
    dead,
    receiverDead,
    cascade,
    unadjudicable,
  };
}

/**
 * 读真实语料。整棵 `src/**` 一起读进来（测试文件**也在内**）—— 生产与测试的分流交给
 * `census` 里的 `isTestPath`，因为「一个成员只在测试里被用」这句话需要两边都看得见
 * （报告要打 `testHits`），靠目录挑选会把这份信息丢掉。
 */
export function scanRepo(ts, dir = SRC, opts = {}) {
  const all = productionFiles(dir).map((p) => ({
    path: relative(ROOT, p),
    src: readFileSync(p, "utf8"),
  }));
  return census(ts, all, opts);
}

/** 基线的键带文件（基线就该钉在文件上）；报告与针只用人看得懂的 `类.成员`。 */
const keyOf = (d) => `${d.file}::${d.cls}.${d.name}`;
const shortOf = (d) => `${d.cls}.${d.name}`;
/**
 * 白名单：已知、**有理由**的零引用成员（与 `unwired-allowlist.json` 同一约定）。
 * 每条都写明为什么它可以不在执行路径上；没有理由的条目不许进这里 ——
 * 「基线」这个词会让人以为"这是正常的"，而这些成员恰恰是**待办的债务**。
 */
const readAllowlist = () =>
  existsSync(ALLOWLIST_PATH) ? JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) : [];
const allowKey = (e) => `${e.path}::${e.cls}.${e.name}`;

/**
 * 接收者白名单（REQ-A946）：**名字活着、但没有任何按接收者的调用**的成员。
 * 与上面同一约定 —— 每条必须带理由。它不是"待办债务"那张表（那是 `dead` 那张），
 * 而是「这条确实不在执行路径上，且我们知道为什么，而且**不打算**接」那张：
 * 被取代的实现、只在测试里用的缝、没有宿主的逃生口。
 */
const readReceiverAllowlist = () =>
  existsSync(RECEIVER_ALLOWLIST_PATH)
    ? JSON.parse(readFileSync(RECEIVER_ALLOWLIST_PATH, "utf8"))
    : [];
const recvKey = (e) => `${e.path}::${e.cls}.${e.name}`;

/**
 * 「已登记的未接线导出」——级联抑制的输入。两个来源都算：
 *   * `unwired-baseline.json` 的 `values`（记着，但没理由 —— 是待办）；
 *   * `unwired-allowlist.json` 的条目（**有理由** —— 有意不接）。
 * 两者都表示"这块东西没接线"，所以它的成员不该一条条往新桶里灌。
 */
function deadExportKeys() {
  const keys = new Set();
  const basePath = join(HERE, "unwired-baseline.json");
  if (existsSync(basePath)) {
    const b = JSON.parse(readFileSync(basePath, "utf8"));
    for (const v of b.values ?? []) keys.add(v); // 形如 `src/lib/foo.ts::bar`
  }
  const allowPath = join(HERE, "unwired-allowlist.json");
  if (existsSync(allowPath)) {
    for (const e of JSON.parse(readFileSync(allowPath, "utf8"))) {
      // 整模块登记（`module: true`）→ 该文件的**每一个**导出都没接线，用 `path::*` 表示。
      if (e.module) keys.add(`${e.path}::*`);
      else if (e.name) keys.add(`${e.path}::${e.name}`);
    }
  }
  return keys;
}

function selftest() {
  const ts = getTS();
  const fail = (msg) => {
    console.error(`[dead-member-scan] selftest FAIL: ${msg}`);
    process.exit(1);
  };
  const expect = (cond, msg) => {
    if (!cond) fail(msg);
  };

  // 1. 未被任何地方提到的成员 → 死。
  //    2. 被别处调用的成员 → 活；3. 同类内 `this.` 调用 → 活。
  const a = `export class A {
  used() { return 1; }
  helper() { return 2; }
  dead() { return 3; }
  get view() { return this.helper(); }
}`;
  //    `view` 被读（所以活），`helper` 只被 `view` 的 `this.helper()` 提到（同类内引用 → 也活）。
  const b = `import { A } from "./a";
export function go(x: A) { return x.used() + x.view; }`;
  const r1 = census(ts, [
    { path: "src/a.ts", src: a },
    { path: "src/b.ts", src: b },
  ]);
  expect(r1.members === 4, `成员数应为 4，实际 ${r1.members}`);
  const dead1 = r1.dead.map((d) => d.name).sort();
  expect(
    JSON.stringify(dead1) === JSON.stringify(["dead"]),
    `只有 dead 该是死的，实际 ${JSON.stringify(dead1)}（view 被读，helper 被 view 的 this.helper() 提到）`,
  );

  // 4. 只在测试里被用 → 仍然是死的（这正是本族的形状），但 testHits 要看得见。
  const t = `import { A } from "../a";
it("x", () => { new A().dead(); });`;
  const r2 = census(ts, [
    { path: "src/a.ts", src: a },
    { path: "src/b.ts", src: b },
    { path: "src/__tests__/a.test.ts", src: t },
  ]);
  expect(r2.dead.length === 1, `测试引用不得让成员复活，实际死成员 ${r2.dead.length}`);
  expect(r2.dead[0].testHits === 1, `testHits 应为 1，实际 ${r2.dead[0].testHits}`);

  // 5. 同名的成员声明**不算**对彼此的引用：B.initialize 没被调用，就该报 B.initialize。
  //    （第一版在这里漏报：两个类各有一个 initialize，裸数名字得到 2 ≥ 2。）
  const c = `export class C { initialize() {} }`;
  const d = `export class D { initialize() {} }`;
  const r3 = census(ts, [
    { path: "src/c.ts", src: c },
    { path: "src/d.ts", src: d },
  ]);
  expect(
    r3.dead.length === 2,
    `两个 initialize 都该是死的，实际 ${r3.dead.length} —— 声明位没有被排除？`,
  );

  // 6. 对象字面量的成员**不在语料里**（工厂返回的对象是被展开消费的，见头部边界）。
  const e = `export function make() { return { onmove() {}, deadish() {} }; }`;
  const r4 = census(ts, [{ path: "src/e.ts", src: e }]);
  expect(r4.members === 0, `对象字面量成员不该被提取，实际 ${r4.members}`);

  // 7. `.svelte` 的 `<script>` 块在语料里，且行号不漂（遮罩是等长的）。
  const s = `<script lang="ts">\nclass W { orphan() {} }\n</script>\n<div></div>`;
  const r5 = census(ts, [{ path: "src/W.svelte", src: s }]);
  expect(r5.members === 1 && r5.dead[0].name === "orphan", "svelte script 块没被扫到");

  // 8. `get`/`set` 也算成员。
  const f = `class G { get alone() { return 1; } set alone2(v: number) {} }`;
  const r6 = census(ts, [{ path: "src/g.ts", src: f }]);
  expect(r6.members === 2, `getter/setter 应被提取，实际 ${r6.members}`);

  // 9. 与内建集合方法同名的成员进「判据看不见」那一桶，**不进** dead —— 地板要可见，
  //    不能让它静悄悄地既不报也不列。`m.get(…)` 把 `get` 的计数抬到 1，所以纳进
  //    普查的话 `H.get` 会被误当活；本 fixture 就是说这件事。
  const h = `class H { get(k: string) { return k; } helper() {} }`;
  const i = `export function useMap(m: Map<string, number>) { return m.get("x"); }`;
  const r7 = census(ts, [
    { path: "src/h.ts", src: h },
    { path: "src/i.ts", src: i },
  ]);
  expect(r7.unadjudicable.length === 1, `get 该进 unadjudicable，实际 ${r7.unadjudicable.length}`);
  expect(r7.dead.length === 1 && r7.dead[0].name === "helper", `helper 才该是死的，实际 ${JSON.stringify(r7.dead.map((d) => d.name))}`);

  console.log("[dead-member-scan] selftest OK — 9 fixtures");

  // ==========================================================================
  // 10-14：按接收者解析（REQ-A946）。9 条 fixture 全部走到这里才打印 OK，所以
  // 它们与上面那 9 条是同一道门。
  // ==========================================================================

  // 10. 别名表 + 跨文件按接收者调用 ⇒ `called` 活；而 `shadowed` 的名字在别处被
  //     **另一个对象**用过（名字级 ≥ 1），接收者级 0 ⇒ 进新桶。这一条同时钉住
  //     「名字级活着不等于被调用」这件事本身。
  const ra = `export class R { called() { return 1; } shadowed() { return 2; } }`;
  const rb = `import { R } from "./ra";
export const r = new R();
export function go() { return r.called(); }`;
  const rc = `export const other = { shadowed: 1 };
export function go2() { return other.shadowed; }`;
  const r8 = census(ts, [
    { path: "src/ra.ts", src: ra },
    { path: "src/rb.ts", src: rb },
    { path: "src/rc.ts", src: rc },
  ]);
  expect(
    r8.dead.length === 0,
    `两条名字都被提到过，dead 该是空的，实际 ${JSON.stringify(r8.dead.map((d) => d.name))}`,
  );
  const r8recv = r8.receiverDead.map((d) => d.name);
  expect(
    JSON.stringify(r8recv) === JSON.stringify(["shadowed"]),
    `只有 shadowed 该进接收者死那一桶，实际 ${JSON.stringify(r8recv)}`,
  );

  // 11. **按接收者解析的类型说话**：另一个类的同名成员被调用，**不**能救活 R.called。
  //     （接收者解到 `Other` ⇒ 计数记在 `Other.called` 上，`R.called` 仍是 0。）
  const ro = `export class Other { called() { return 1; } }`;
  const rd = `import { Other } from "./ro";
export function go3() { const r: Other = new Other(); return r.called(); }`;
  const r9 = census(ts, [
    { path: "src/ra.ts", src: ra },
    { path: "src/rc.ts", src: rc },
    { path: "src/ro.ts", src: ro },
    { path: "src/rd.ts", src: rd },
  ]);
  expect(
    JSON.stringify(r9.receiverDead.map((d) => d.name)) === JSON.stringify(["called", "shadowed"]),
    `R 的两条都该留在桶里（调用记在了 Other.called 上），实际 ${JSON.stringify(r9.receiverDead.map((d) => d.name))}`,
  );

  // 12. **别名表要求该文件真的 import 了那个名字**：不导入就不认（否则一个同名的
  //     局部变量会被当成人家的单例 —— REQ-A863 那个「按目录遍历顺序作答」的坑）。
  const re = `export function go4() { return r.called(); }`;
  const r10 = census(ts, [
    { path: "src/ra.ts", src: ra },
    { path: "src/rc.ts", src: rc },
    { path: "src/re.ts", src: re },
  ]);
  expect(
    r10.receiverDead.length === 2,
    `没有 import 别名时解不出接收者 ⇒ 两条都留在桶里（保守方向），实际 ${JSON.stringify(r10.receiverDead.map((d) => d.name))}`,
  );

  // 13. 同类内 `this.M()` 按接收者也算活（`this` → 所在类）。`outer` 自己没人调，
  //     所以它**该**在名字级的 dead 里 —— 这条同时说明两个桶不重叠。
  const rf = `export class S { inner() {} outer() { this.inner(); return 1; } }`;
  const r11 = census(ts, [{ path: "src/rf.ts", src: rf }]);
  expect(
    r11.receiverDead.length === 0 && JSON.stringify(r11.dead.map((d) => d.name)) === JSON.stringify(["outer"]),
    `this.inner() 该救活 inner、outer 该是名字级的死，实际 receiverDead=${JSON.stringify(r11.receiverDead.map((d) => d.name))} dead=${JSON.stringify(r11.dead.map((d) => d.name))}`,
  );

  // 14. 级联抑制：接收者本身已登记为未接线 ⇒ 成员进 `cascade`，不进新桶。
  const corpus = [
    { path: "src/ra.ts", src: ra },
    { path: "src/rb.ts", src: rb },
    { path: "src/rc.ts", src: rc },
  ];
  const r12 = census(ts, corpus, { deadExports: new Set(["src/rb.ts::r"]) });
  expect(
    r12.receiverDead.length === 0 && r12.cascade.length === 1 && r12.cascade[0].name === "shadowed",
    `已登记未接线的接收者，其成员该进 cascade，实际 recvDead=${r12.receiverDead.length} cascade=${r12.cascade.length}`,
  );
  // 同一条语料、不加级联 ⇒ 回到新桶（证明上面那条变绿是级联干的，不是解析器没看见）。
  const r13 = census(ts, corpus, { deadExports: new Set() });
  expect(
    r13.receiverDead.length === 1 && r13.cascade.length === 0,
    `不登记时 shadowed 该在新桶里，实际 recvDead=${r13.receiverDead.length} cascade=${r13.cascade.length}`,
  );

  console.log("[dead-member-scan] selftest OK — 14 fixtures（含 5 条接收者解析）");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return selftest();

  const ts = getTS();
  const report = scanRepo(ts, SRC, { deadExports: deadExportKeys() });
  const allowlist = readAllowlist();
  const baseSet = new Set(allowlist.map(allowKey));
  const reasonOf = new Map(allowlist.map((e) => [allowKey(e), e.reason]));
  const nowSet = new Set(report.dead.map(keyOf));

  const newly = report.dead.filter((d) => !baseSet.has(keyOf(d)));
  const wired = [...baseSet].filter((k) => !nowSet.has(k));

  // 双向的针（与 void-cmd-scan 同一判据）：普查少了一个必须看见的名字，说明提取器坏了。
  const nowShort = new Set(report.dead.map(shortOf));
  const missing = MUST_SEE.filter((k) => !nowShort.has(k));
  const resurrected = MUST_NOT_SEE.filter((k) => nowShort.has(k));

  // 接收者那一桶：同上，外加它自己的一对针。**这一桶是"要理由"的**，不是"要修"的
  // （见 `RECEIVER_ALLOWLIST_PATH` 的文档）：一条不在执行路径上、且我们知道为什么。
  const recvAllow = readReceiverAllowlist();
  const recvSet = new Set(recvAllow.map(recvKey));
  const recvReason = new Map(recvAllow.map((e) => [recvKey(e), e.reason]));
  const nowRecv = new Set(report.receiverDead.map(keyOf));
  const recvNew = report.receiverDead.filter((d) => !recvSet.has(keyOf(d)));
  const recvWired = [...recvSet].filter((k) => !nowRecv.has(k));
  const recvShort = new Set(report.receiverDead.map(shortOf));
  const recvMissing = MUST_SEE_RECEIVER_DEAD.filter((k) => !recvShort.has(k));
  const recvOverreach = MUST_NOT_SEE_RECEIVER_DEAD.filter((k) => recvShort.has(k));
  // 有理由的条目里理由空着/占位 —— 与 `unwired-scan` 同一条规矩：不许静默放行。
  const recvBare = recvAllow.filter((e) => !e.reason || !String(e.reason).trim());

  if (argv.includes("--update-allowlist")) {
    // 保留已有的 reason；新条目写一个显眼的占位符，逼下一双眼睛去填（不静默放行）。
    const next = report.dead.map(({ file, cls, name }) => ({
      path: file,
      cls,
      name,
      reason: reasonOf.get(`${file}::${cls}.${name}`) ?? "TODO: 说明为什么它可以不在执行路径上",
    }));
    writeFileSync(ALLOWLIST_PATH, JSON.stringify(next, null, 2) + "\n");
    console.log(`[dead-member-scan] 白名单已重写：${next.length} 条（有 ${next.filter((e) => e.reason.startsWith("TODO")).length} 条待补理由）`);
    return;
  }
  if (argv.includes("--update-receiver-allowlist")) {
    const next = report.receiverDead.map(({ file, cls, name }) => ({
      path: file,
      cls,
      name,
      reason: recvReason.get(`${file}::${cls}.${name}`) ?? "TODO: 说明为什么它不被任何接收者调用",
    }));
    writeFileSync(RECEIVER_ALLOWLIST_PATH, JSON.stringify(next, null, 2) + "\n");
    console.log(`[dead-member-scan] 接收者白名单已重写：${next.length} 条（有 ${next.filter((e) => e.reason.startsWith("TODO")).length} 条待补理由）`);
    return;
  }
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          ...report,
          newly,
          wired,
          missing,
          resurrected,
          recvNew,
          recvWired,
          recvMissing,
          recvOverreach,
          recvBare,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `[dead-member-scan] ${report.files} 生产文件 / ${report.members} 个类成员 / ` +
      `${report.dead.length} 个生产里零引用（白名单 ${baseSet.size}）/ ` +
      `${report.receiverDead.length} 个名字活着但没被任何接收者调用（白名单 ${recvSet.size}）/ ` +
      `${report.cascade.length} 个随已登记未接线的接收者级联 / ` +
      `${report.unadjudicable.length} 个判据看不见（见下）`,
  );
  // 地板可见：这些成员**没被测到**，不是"通过"。
  for (const m of report.unadjudicable) {
    console.log(`  (unadjudicable) ${m.file}::${m.cls}.${m.name} —— 名字与内建集合方法同名，本闸门看不见`);
  }
  // 级联只报一条总数 + 根因，不逐条刷屏（同一根因，9 条同模块的成员）。
  for (const d of report.cascade) {
    console.log(`  (cascade) ${d.cls}.${d.name} —— 接收者 ${d.via} 已登记为未接线，随它一起，不单独判定`);
  }

  let bad = false;
  if (missing.length) {
    bad = true;
    console.error(`[dead-member-scan] FAIL — 普查里看不到必须看见的成员：${missing.join(", ")}`);
  }
  if (resurrected.length) {
    bad = true;
    console.error(
      `[dead-member-scan] FAIL — 本轮的修复被回退了（这些成员又变成零引用）：${resurrected.join(", ")}`,
    );
  }
  if (newly.length) {
    bad = true;
    console.error(`[dead-member-scan] FAIL — ${newly.length} 个新出现的零引用类成员：`);
    for (const d of newly) {
      console.error(`  ${keyOf(d)}  (${d.kind}, 测试引用 ${d.testHits})`);
    }
  }
  if (wired.length) {
    // 只是提醒：白名单里的条目活过来了，该把它删掉（白名单只能缩小）。
    console.log(`[dead-member-scan] note — ${wired.length} 条白名单条目已经有生产引用了，请从白名单移除：`);
    for (const k of wired) console.log(`  ${k}`);
  }
  if (recvMissing.length) {
    bad = true;
    console.error(
      `[dead-member-scan] FAIL — 接收者那一桶里看不到必须看见的成员：${recvMissing.join(", ")}\n` +
        `  （这一桶**静悄悄地变空**正是它最可能的坏法：解析器一旦退化成"什么都解不出"，` +
        `它会全绿而不是全红。）`,
    );
  }
  if (recvOverreach.length) {
    bad = true;
    console.error(
      `[dead-member-scan] FAIL — 接收者解析把**确实被调用**的成员误报成死的：${recvOverreach.join(", ")}`,
    );
  }
  if (recvBare.length) {
    bad = true;
    console.error(`[dead-member-scan] FAIL — 接收者白名单里有没写理由的条目：`);
    for (const e of recvBare) console.error(`  ${recvKey(e)}`);
  }
  if (recvNew.length) {
    bad = true;
    console.error(
      `[dead-member-scan] FAIL — ${recvNew.length} 个成员的名字活着，但生产里没有任何**按接收者**的调用：`,
    );
    for (const d of recvNew) {
      console.error(`  ${keyOf(d)}  (${d.kind}, 名字级 ${d.nameRefs} 次, 测试引用 ${d.testHits})`);
    }
    console.error(
      `  两条出路：它能被接上 ⇒ 接到执行路径上；它真的不该在路径上 ⇒ 写进 ` +
        `scripts/dead-member-receiver-allowlist.json 并写明**为什么**（--update-receiver-allowlist 生成占位）。`,
    );
  }
  if (recvWired.length) {
    // 只是提醒：这一桶的条目活过来了，该删掉（白名单只能缩小）。
    console.log(`[dead-member-scan] note — ${recvWired.length} 条接收者白名单条目已经有按接收者的调用了，请移除：`);
    for (const k of recvWired) console.log(`  ${k}`);
  }
  if (bad) process.exit(1);
  console.log("[dead-member-scan] OK — 没有新增的零引用类成员，也没有新增的「名字活着、接收者死」成员。");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
