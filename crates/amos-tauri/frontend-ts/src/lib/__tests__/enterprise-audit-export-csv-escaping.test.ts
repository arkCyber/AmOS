/**
 * 审计 CSV 导出的字段必须**按 RFC 4180 转义**，否则一条合法的审计记录会在导出里变成别的记录。
 *
 * 修前 `exportLogs` 的 CSV 分支逐字是
 * `const csv = [headers, ...rows].map(row => row.join(",")).join("\n");`
 * —— 每个格子原样用逗号拼起来。而 `eventDescription` 是**自由文本**
 * （执行类日志逐字是 `执行快捷指令: ${shortcutName}`，见 `logExecution`），
 * `errorMessage` 更是任意错误文本。于是：
 *
 *  * 名字里带一个逗号（`买牛奶,面包`）⇒ 这一行多出一格，从「结果」往后的每一列
 *    都错位到邻居头上 —— 导出的凭据把 success 记到别人的「结果」列里；
 *  * 错误信息里带一个换行 ⇒ 一行被劈成两行，行数、列数同时不对；
 *  * 带双引号 ⇒ 文本被截断在引号处。
 *
 * 判据：`exportLogs` 的 **JSON 分支**（`JSON.stringify(logs, null, 2)`）对同一批行是
 * 完好的 —— 同一个方法、同一个按钮（查看器的「导出 JSON ∕ CSV」菜单），只有 CSV 这一支
 * 假设了「字段里不会有分隔符」。这是 `logger.error` 之外的第二个同屏兄弟。
 *
 * 负对照（逐字还原修前那一行）：带逗号那条会以「10 个字段 ≠ 9 个」红，
 * 带换行那条会以「3 行 ≠ 2 行」红；且 `data[4]` 只剩逗号前半截。
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

/**
 * 最小的 RFC 4180 读取器：认识引号包裹的字段（`""` = 一个引号），也认识
 * **引号里的换行**（它是一个字段的字节，不是一条记录的边界），于是「几条记录」
 * 「每条几列」「每列是什么」都能被测出来 —— 直接 `csv.split("\n")` 做不到这一点，
 * 那正是修前的形状。被测代码不导出这个解析器；测试自带一份，避免用被测实现验证被测实现。
 */
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

async function writeOne(description: string, resourceName?: string): Promise<string> {
  await auditLogger.log({
    eventType: "shortcut_execute",
    eventCategory: "execution",
    eventDescription: description,
    resourceName,
    result: "success",
  });
  await auditLogger.flushBuffer();
  return auditLogger.exportLogs({}, "csv");
}

describe("REQ-A1540 — 审计 CSV 导出按 RFC 4180 转义字段", () => {
  it("描述里的逗号不改变列数，也不把后面的列挤走", async () => {
    const csv = await writeOne("执行快捷指令: 买牛奶,面包", "日常");
    const records = splitCsv(csv);
    const header = records[0]!;
    const data = records[1]!;

    // 9 列就是 9 列 —— 修前这里会读出 10 个字段（面包成了「资源」列）。
    expect(data).toHaveLength(header.length);
    expect(header).toHaveLength(9);
    // 被逗号劈开的那一格必须**原样**读回来，且「结果」仍在它自己那一列上。
    expect(data[4]).toBe("执行快捷指令: 买牛奶,面包");
    expect(data[6]).toBe("success");
  });

  it("描述里的换行被引号包住，一条记录仍然是一条记录", async () => {
    const records = splitCsv(await writeOne("第一行\n第二行"));

    // 表头 + 一条逻辑记录 = 2 条。修前换行裸着，会被读成两条残缺记录。
    expect(records).toHaveLength(2);
    expect(records[1]).toHaveLength(9);
    expect(records[1]![4]).toBe("第一行\n第二行");
  });

  it("字段里的双引号成对加倍，文本不被截断", async () => {
    const data = splitCsv(await writeOne('他说"好的"', 'a"b'))[1]!;

    expect(data).toHaveLength(9);
    expect(data[4]).toBe('他说"好的"');
    expect(data[5]).toBe('a"b');
  });

  it("正控 · 没有特殊字符的行不被加引号（没有被过度改写）", async () => {
    const csv = await writeOne("普通描述", "普通资源");
    // 这一行没有换行，所以「记录」与「物理行」在这里是同一件事。
    const row = csv.split("\n")[1]!;

    expect(row).not.toContain('"');
    expect(splitCsv(csv)[1]![4]).toBe("普通描述");
  });
});
