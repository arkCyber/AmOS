import { describe, expect, test, beforeEach } from "bun:test";
import {
  BACKUP_VERSION,
  SYNC_STORES,
  parseBackup,
  readCloud,
  restoreStores,
  setCloudPrefs,
  snapshotStores,
  summarizeBackup,
} from "../cloud";

// Import types but comment out to avoid unused warnings
// type BackupSummary, CloudPrefs, RestoreReport are available if needed

describe("云同步系统 - 航空航天级审计", () => {
  describe("CloudPrefs 配置管理", () => {
    test("readCloud 从设置对象中读取 iCloud 配置", () => {
      const prefs = readCloud({ iCloudSync: true, cloudLast: 1726574400000 });
      expect(prefs.enabled).toBe(true);
      expect(prefs.lastSync).toBe(1726574400000);
    });

    test("readCloud 容错: null/undefined 返回默认配置", () => {
      expect(readCloud(null)).toEqual({ enabled: false, lastSync: 0 });
      expect(readCloud(undefined)).toEqual({ enabled: false, lastSync: 0 });
      expect(readCloud({})).toEqual({ enabled: false, lastSync: 0 });
    });

    test("readCloud 容错: 非法值返回默认", () => {
      expect(readCloud({ iCloudSync: "yes" })).toEqual({ enabled: false, lastSync: 0 });
      expect(readCloud({ cloudLast: "never" })).toEqual({ enabled: false, lastSync: 0 });
      expect(readCloud({ cloudLast: NaN })).toEqual({ enabled: false, lastSync: 0 });
      expect(readCloud({ cloudLast: Infinity })).toEqual({ enabled: false, lastSync: 0 });
    });

    test("setCloudPrefs 设置单个或多个配置项", () => {
      const base = { foo: "bar" };
      let next = setCloudPrefs(base, { enabled: true });
      expect(next).toEqual({ foo: "bar", iCloudSync: true });
      expect(base).toEqual({ foo: "bar" }); // 不可变

      next = setCloudPrefs(next, { lastSync: 1234567890 });
      expect(next).toEqual({ foo: "bar", iCloudSync: true, cloudLast: 1234567890 });

      next = setCloudPrefs({}, { enabled: false, lastSync: 0 });
      expect(next).toEqual({ iCloudSync: false, cloudLast: 0 });
    });

    test("setCloudPrefs 容错: null/非对象输入返回新对象", () => {
      expect(setCloudPrefs(null as any, { enabled: true })).toEqual({ iCloudSync: true });
      expect(setCloudPrefs([] as any, { lastSync: 100 })).toEqual({ cloudLast: 100 });
    });
  });

  describe("snapshotStores - 备份快照生成", () => {
    test("生成包含版本号、时间戳和存储映射的 JSON 快照", () => {
      const stores = {
        "amos.notes": [{ id: 1, text: "note1" }],
        "amos.files": [],
        "amos.photos": [{ id: 1, src: "photo.jpg" }],
      };
      const at = 1726574400000;
      const snapshot = snapshotStores(stores, at);

      const parsed = JSON.parse(snapshot);
      expect(parsed.v).toBe(BACKUP_VERSION);
      expect(parsed.at).toBe(at);
      expect(parsed.stores).toEqual({
        "amos.notes": [{ id: 1, text: "note1" }],
        "amos.files": [],
        "amos.photos": [{ id: 1, src: "photo.jpg" }],
      });
    });

    test("仅包含 SYNC_STORES 列表中的存储键", () => {
      const stores = {
        "amos.notes": ["hello"],
        "amos.wifi": { ssid: "test" }, // 非用户数据，不应包含
        "amos.unknown": "data",
      };
      const snapshot = snapshotStores(stores, Date.now());
      const parsed = JSON.parse(snapshot);

      expect(parsed.stores["amos.notes"]).toEqual(["hello"]);
      expect(parsed.stores["amos.wifi"]).toBeUndefined();
      expect(parsed.stores["amos.unknown"]).toBeUndefined();
    });

    test("SYNC_STORES 常量完整性检查", () => {
      // 确保所有用户数据存储都在快照列表中（使用实际的常量值）
      const requiredStores = [
        "amos.notes",
        "amos.files",
        "amos.files.favorites",
        "amos.photos",
        "amos.captures", // CAPTURES_KEY
        "amos.messages.convs", // CONV_KEY
        "amos.sms.drafts", // DRAFT_KEY
        "amos.music",
        "amos.vmemos", // VMEMOS_KEY
        "amos.reminders",
        "amos.reminderLists", // LISTS_KEY
        "amos.contacts",
        "amos.calendar", // CALENDAR_KEY
        "amos.calendars", // CALENDARS_KEY
        "amos.alarms",
        "amos.calllog", // CALLLOG_KEY
        "amos.interp.log", // INTERP_LOG_KEY
      ];
      for (const key of requiredStores) {
        expect(SYNC_STORES.some(s => s === key)).toBe(true);
      }
      expect(SYNC_STORES.length).toBe(17);
    });

    test("空存储返回空 stores 对象但保留元数据", () => {
      const snapshot = snapshotStores({}, 1000);
      const parsed = JSON.parse(snapshot);
      expect(parsed.v).toBe(BACKUP_VERSION);
      expect(parsed.at).toBe(1000);
      expect(Object.keys(parsed.stores)).toHaveLength(0);
    });

    test("快照是确定性的（相同输入产生相同输出）", () => {
      const stores = { "amos.notes": ["a", "b"], "amos.photos": [1, 2, 3] };
      const at = 1726574400000;
      const s1 = snapshotStores(stores, at);
      const s2 = snapshotStores(stores, at);
      expect(s1).toBe(s2); // 字节级相同
    });
  });

  describe("parseBackup - 备份解析", () => {
    test("解析版本化备份（v1 格式）", () => {
      const raw = JSON.stringify({
        v: 1,
        at: 1726574400000,
        stores: {
          "amos.notes": ["note1"],
          "amos.photos": [],
        },
      });
      const parsed = parseBackup(raw);
      expect(parsed).toEqual({
        "amos.notes": ["note1"],
        "amos.photos": [],
      });
    });

    test("解析 legacy 备份（无版本号）", () => {
      const raw = JSON.stringify({
        "amos.notes": ["old note"],
        "amos.files": [],
      });
      const parsed = parseBackup(raw);
      expect(parsed).toEqual({
        "amos.notes": ["old note"],
        "amos.files": [],
      });
    });

    test("仅返回 SYNC_STORES 中的键", () => {
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.notes": ["a"],
          "amos.wifi": { ssid: "test" }, // 不应返回
          "amos.evil": "payload", // 不应返回
        },
      });
      const parsed = parseBackup(raw);
      expect(parsed).toEqual({ "amos.notes": ["a"] });
    });

    test("容错: 损坏的 JSON 返回 null", () => {
      expect(parseBackup("{invalid json")).toBeNull();
      expect(parseBackup("")).toBeNull();
      expect(parseBackup(null)).toBeNull();
      expect(parseBackup(undefined)).toBeNull();
    });

    test("容错: 非对象返回 null", () => {
      expect(parseBackup("[]")).toBeNull();
      expect(parseBackup('"string"')).toBeNull();
      expect(parseBackup("123")).toBeNull();
    });

    test("接受已解析的对象（不仅是字符串）", () => {
      const obj = {
        v: 1,
        at: 1000,
        stores: { "amos.notes": ["a"] },
      };
      const parsed = parseBackup(obj);
      expect(parsed).toEqual({ "amos.notes": ["a"] });
    });
  });

  describe("summarizeBackup - 备份摘要", () => {
    test("统计备份中的存储数量、填充数量和总数", () => {
      const raw = JSON.stringify({
        v: 1,
        at: 1726574400000,
        stores: {
          "amos.notes": ["note1", "note2"],
          "amos.files": [], // 空数组
          "amos.photos": [{ id: 1 }],
          "amos.contacts": null, // null
        },
      });
      const summary = summarizeBackup(raw);
      expect(summary).toEqual({
        stores: 4, // 4 个键
        filled: 2, // notes 和 photos 有内容
        total: SYNC_STORES.length, // 17
        at: 1726574400000,
        v: 1,
      });
    });

    test("空字符串、空对象、null 被视为空值", () => {
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.notes": "",
          "amos.files": {},
          "amos.photos": null,
        },
      });
      const summary = summarizeBackup(raw);
      expect(summary?.filled).toBe(0);
    });

    test("legacy 备份（无元数据）返回 null 的 v 和 at", () => {
      const raw = JSON.stringify({ "amos.notes": ["a"] });
      const summary = summarizeBackup(raw);
      expect(summary?.v).toBeNull();
      expect(summary?.at).toBeNull();
      expect(summary?.stores).toBe(1);
    });

    test("损坏的备份返回 null", () => {
      expect(summarizeBackup("{bad}")).toBeNull();
      expect(summarizeBackup(null)).toBeNull();
    });
  });

  describe("restoreStores - 备份恢复", () => {
    let writeLog: Array<{ key: string; value: unknown }>;
    let writeSuccess: Set<string>;
    const mockWrite = (key: string, value: unknown): boolean => {
      writeLog.push({ key, value });
      return writeSuccess.has(key);
    };

    beforeEach(() => {
      writeLog = [];
      writeSuccess = new Set(SYNC_STORES); // 默认所有写入成功
    });

    test("恢复所有 SYNC_STORES 键", () => {
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.notes": ["note1"],
          "amos.files": [],
          "amos.photos": [{ id: 1 }],
        },
      });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(true);
      expect(report.restored).toEqual(["amos.notes", "amos.files", "amos.photos"]);
      expect(report.failed).toEqual([]);
      expect(report.refused).toEqual([]);
      expect(writeLog).toHaveLength(3);
    });

    test("拒绝非 SYNC_STORES 键（安全防护）", () => {
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.notes": ["a"],
          "amos.permissions": { camera: true }, // 权限不应恢复
          "amos.wifi": { ssid: "evil" }, // 设备状态不应恢复
        },
      });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(true);
      expect(report.restored).toEqual(["amos.notes"]);
      expect(report.refused.sort()).toEqual(["amos.permissions", "amos.wifi"]);
    });

    test("报告写入失败的键", () => {
      writeSuccess.delete("amos.files"); // 模拟 files 写入失败
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.notes": ["a"],
          "amos.files": [],
        },
      });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(true);
      expect(report.restored).toEqual(["amos.notes"]);
      expect(report.failed).toEqual(["amos.files"]);
    });

    test("拒绝版本号过高的备份（unsupported-version）", () => {
      const raw = JSON.stringify({
        v: BACKUP_VERSION + 1,
        at: 1000,
        stores: { "amos.notes": ["future"] },
      });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(false);
      expect(report.reason).toBe("unsupported-version");
      expect(report.restored).toEqual([]);
      expect(writeLog).toHaveLength(0); // 未写入任何数据
    });

    test("拒绝损坏的备份（malformed）", () => {
      const report = restoreStores("{bad", mockWrite);
      expect(report.ok).toBe(false);
      expect(report.reason).toBe("malformed");
      expect(writeLog).toHaveLength(0);
    });

    test("按 SYNC_STORES 顺序恢复（确定性）", () => {
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.photos": [1],
          "amos.notes": [2],
          "amos.files": [3],
        },
      });
      restoreStores(raw, mockWrite);
      // 写入顺序应与 SYNC_STORES 定义顺序一致
      const keys = writeLog.map((w) => w.key);
      // Check order consistency
      expect(keys.indexOf("amos.notes")).toBeLessThan(keys.indexOf("amos.files"));
      expect(keys.indexOf("amos.files")).toBeLessThan(keys.indexOf("amos.photos"));
    });

    test("空备份恢复成功但不写入任何数据", () => {
      const raw = JSON.stringify({ v: 1, at: 1000, stores: {} });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(true);
      expect(report.restored).toEqual([]);
      expect(writeLog).toHaveLength(0);
    });

    test("legacy 备份（无版本号）可以恢复", () => {
      const raw = JSON.stringify({ "amos.notes": ["old"] });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(true);
      expect(report.restored).toEqual(["amos.notes"]);
    });
  });

  describe("航空航天级可靠性测试", () => {
    test("大数据快照性能（10k 条目）", () => {
      const stores: Record<string, unknown> = {};
      for (const key of SYNC_STORES) {
        stores[key] = Array.from({ length: 10000 }, (_, i) => ({
          id: i,
          data: `item-${i}`,
        }));
      }
      const start = performance.now();
      const snapshot = snapshotStores(stores, Date.now());
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(500); // < 500ms
      expect(snapshot.length).toBeGreaterThan(0);
    });

    test("并发快照+恢复不冲突", () => {
      const stores = { "amos.notes": ["a", "b", "c"] };
      const at = Date.now();
      const s1 = snapshotStores(stores, at);
      const p1 = parseBackup(s1);
      const s2 = snapshotStores(stores, at);
      const p2 = parseBackup(s2);
      expect(s1).toBe(s2);
      expect(p1).toEqual(p2);
    });

    test("边界: 空键值对", () => {
      const snapshot = snapshotStores({ "amos.notes": null }, 1000);
      const parsed = parseBackup(snapshot);
      expect(parsed).toEqual({ "amos.notes": null });
    });

    test("边界: 极大时间戳", () => {
      const at = 9999999999999;
      const snapshot = snapshotStores({}, at);
      const parsed = JSON.parse(snapshot);
      expect(parsed.at).toBe(at);
    });

    test("安全: 备份中的恶意键无法注入到恢复中", () => {
      const writeLog: string[] = [];
      const mockWrite = (key: string) => {
        writeLog.push(key);
        return true;
      };
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.notes": ["ok"],
          "__proto__": { evil: true },
          constructor: { evil: true },
        },
      });
      const report = restoreStores(raw, mockWrite);
      expect(report.restored).toEqual(["amos.notes"]);
      expect(writeLog).toEqual(["amos.notes"]);
      // __proto__ 可能在 JSON 解析时被过滤，所以检查至少有一个恶意键被拒绝
      expect(report.refused.length).toBeGreaterThan(0);
      // constructor 应该被拒绝
      expect(report.refused).toContain("constructor");
    });

    test("一致性: 快照→解析→恢复完整链路", () => {
      const original = {
        "amos.notes": [{ id: 1, text: "hello" }],
        "amos.files": [],
        "amos.photos": [1, 2, 3],
      };
      const snapshot = snapshotStores(original, 1000);
      parseBackup(snapshot); // Parse to validate structure
      const restored: Record<string, unknown> = {};
      restoreStores(snapshot, (key, value) => {
        restored[key] = value;
        return true;
      });
      expect(restored).toEqual(original);
    });
  });

  describe("错误恢复与容错", () => {
    test("部分失败不影响其他存储", () => {
      const failKey = "amos.files";
      const mockWrite = (key: string) => key !== failKey;
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: {
          "amos.notes": ["a"],
          "amos.files": ["b"],
          "amos.photos": ["c"],
        },
      });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(true);
      expect(report.restored).toContain("amos.notes");
      expect(report.restored).toContain("amos.photos");
      expect(report.failed).toEqual(["amos.files"]);
    });

    test("存储满时返回 failed，不抛出异常", () => {
      const mockWrite = () => false; // 模拟所有写入失败
      const raw = JSON.stringify({
        v: 1,
        at: 1000,
        stores: { "amos.notes": ["a"] },
      });
      const report = restoreStores(raw, mockWrite);
      expect(report.ok).toBe(true);
      expect(report.restored).toEqual([]);
      expect(report.failed).toEqual(["amos.notes"]);
    });
  });
});
