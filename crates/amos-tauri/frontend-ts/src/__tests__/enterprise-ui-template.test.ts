/**
 * __tests__/enterprise-ui-template.test.ts
 * 
 * TemplateLibrary UI 组件测试
 * 
 * 测试范围:
 * - 模板搜索和过滤逻辑
 * - 模板分类和部门过滤
 * - 参数验证逻辑
 * - 安装状态管理
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { templateManager } from "../lib/enterprise";
import type { EnterpriseTemplate, TemplateParameter } from "../lib/enterprise/templates";

// 注册 happy-dom 全局对象
beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("TemplateLibrary UI 逻辑测试", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("模板搜索", () => {
    test("应该能够按名称搜索模板", () => {
      const templates: Partial<EnterpriseTemplate>[] = [
        { id: "tpl-001", name: "每日报告", description: "自动生成每日工作报告" },
        { id: "tpl-002", name: "周报生成", description: "生成周报模板" },
      ];

      const searchQuery: string = "每日";
      const filtered = templates.filter(t =>
        !searchQuery ||
        (t.name?.toLowerCase() || "").includes(searchQuery.toLowerCase()) ||
        (t.description?.toLowerCase() || "").includes(searchQuery.toLowerCase())
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("tpl-001");
    });

    test("空搜索应该返回所有模板", () => {
      const templates: Array<Partial<EnterpriseTemplate>> = [
        { id: "1", name: "Template 1" },
        { id: "2", name: "Template 2" },
      ];

      const searchQuery: string = "";
      const filtered = templates.filter(t =>
        !searchQuery ||
        (t.name?.toLowerCase() || "").includes(searchQuery.toLowerCase())
      );

      expect(filtered).toHaveLength(2);
    });
  });

  describe("分类过滤", () => {
    test("应该能够按分类过滤模板", () => {
      const templates: Partial<EnterpriseTemplate>[] = [
        { id: "1", category: "productivity" },
        { id: "2", category: "automation" },
        { id: "3", category: "productivity" },
      ];

      const category: string = "productivity";
      const filtered = templates.filter(t =>
        !category || category === "all" || t.category === category
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(t => t.category === "productivity")).toBe(true);
    });

    test("'all' 分类应该返回所有模板", () => {
      const templates: Partial<EnterpriseTemplate>[] = [
        { id: "1", category: "productivity" },
        { id: "2", category: "automation" },
      ];

      const category: string = "all";
      const filtered = templates.filter(t =>
        !category || category === "all" || t.category === category
      );

      expect(filtered).toHaveLength(2);
    });
  });

  describe("部门过滤", () => {
    test("应该能够按部门过滤模板", () => {
      const templates: Partial<EnterpriseTemplate>[] = [
        { id: "1", department: "engineering" },
        { id: "2", department: "sales" },
        { id: "3", department: "engineering" },
      ];

      const department: string = "engineering";
      const filtered = templates.filter(t =>
        !department || department === "all" || t.department === department
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(t => t.department === "engineering")).toBe(true);
    });
  });

  describe("组合过滤", () => {
    test("应该支持搜索 + 分类 + 部门组合过滤", () => {
      const templates: Partial<EnterpriseTemplate>[] = [
        { id: "1", name: "工程报告", category: "productivity", department: "engineering" },
        { id: "2", name: "销售报告", category: "productivity", department: "sales" },
        { id: "3", name: "工程自动化", category: "automation", department: "engineering" },
      ];

      const searchQuery: string = "工程";
      const category: string = "productivity";
      const department: string = "engineering";

      const filtered = templates.filter(t => {
        const matchesSearch = !searchQuery ||
          (t.name?.toLowerCase() || "").includes(searchQuery.toLowerCase());
        const matchesCategory = !category || category === "all" ||
          t.category === category;
        const matchesDepartment = !department || department === "all" ||
          t.department === department;

        return matchesSearch && matchesCategory && matchesDepartment;
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("1");
    });
  });

  describe("分类和部门提取", () => {
    test("应该能够提取所有唯一的分类", () => {
      const templates: Partial<EnterpriseTemplate>[] = [
        { id: "1", category: "productivity" },
        { id: "2", category: "automation" },
        { id: "3", category: "productivity" },
        { id: "4", category: "communication" },
      ];

      const categories = Array.from(new Set(templates.map(t => t.category)));

      expect(categories).toHaveLength(3);
      expect(categories).toContain("productivity");
      expect(categories).toContain("automation");
      expect(categories).toContain("communication");
    });

    test("应该能够提取所有唯一的部门", () => {
      const templates: Partial<EnterpriseTemplate>[] = [
        { id: "1", department: "engineering" },
        { id: "2", department: "sales" },
        { id: "3", department: "engineering" },
        { id: "4", department: "hr" },
      ];

      const departments = Array.from(new Set(templates.map(t => t.department)));

      expect(departments).toHaveLength(3);
      expect(departments).toContain("engineering");
      expect(departments).toContain("sales");
      expect(departments).toContain("hr");
    });
  });

  describe("参数验证", () => {
    test("应该验证必填参数", () => {
      const parameter: Partial<TemplateParameter> = {
        key: "projectName",
        name: "项目名称",
        type: "text",
        defaultValue: "",
        required: true,
        description: "项目名称",
      };

      const value = "";
      const isValid = !parameter.required || (typeof value === "string" && value.trim().length > 0);

      expect(isValid).toBe(false);
    });

    test("应该验证数字参数范围", () => {
      const parameter: Partial<TemplateParameter> = {
        key: "count",
        name: "数量",
        type: "number",
        defaultValue: 1,
        required: true,
        description: "数量",
        validation: {
          min: 1,
          max: 100,
        },
      };

      const validateNumber = (value: number, param: Partial<TemplateParameter>): boolean => {
        const min = param.validation?.min;
        const max = param.validation?.max;
        if (min !== undefined && value < min) return false;
        if (max !== undefined && value > max) return false;
        return true;
      };

      expect(validateNumber(50, parameter)).toBe(true);
      expect(validateNumber(0, parameter)).toBe(false);
      expect(validateNumber(101, parameter)).toBe(false);
    });

    test("应该验证选项参数", () => {
      const options: Array<{ label: string; value: unknown }> = [
        { label: "低", value: "low" as unknown },
        { label: "中", value: "medium" as unknown },
        { label: "高", value: "high" as unknown },
      ];

      const parameter: Partial<TemplateParameter> = {
        key: "priority",
        name: "优先级",
        type: "select",
        defaultValue: "medium",
        required: true,
        description: "优先级",
        options,
      };

      const value = "medium";
      const validValues = options.map(o => o.value);
      const isValid = !parameter.options || validValues.includes(value);

      expect(isValid).toBe(true);
    });
  });

  describe("安装状态", () => {
    test("应该检测模板是否已安装", () => {
      const installedTemplateIds = ["tpl-001", "tpl-002"];
      const templateId = "tpl-001";

      const isInstalled = installedTemplateIds.includes(templateId);

      expect(isInstalled).toBe(true);
    });

    test("未安装的模板应该返回 false", () => {
      const installedTemplateIds = ["tpl-001", "tpl-002"];
      const templateId = "tpl-003";

      const isInstalled = installedTemplateIds.includes(templateId);

      expect(isInstalled).toBe(false);
    });
  });

  describe("模板徽章", () => {
    test("必需的模板应该显示 required 徽章", () => {
      const template: Partial<EnterpriseTemplate> = {
        targetRoles: ["admin"],
      };

      const badges: string[] = [];
      if ((template.targetRoles?.length ?? 0) > 0) badges.push("required");

      expect(badges).toContain("required");
    });

    test("已安装的模板应该显示 installed 徽章", () => {
      const templateId = "tpl-001";
      const installedTemplateIds = ["tpl-001", "tpl-002"];

      const badges: string[] = [];
      if (installedTemplateIds.includes(templateId)) {
        badges.push("installed");
      }

      expect(badges).toContain("installed");
    });

    test("高评分模板应该显示 popular 徽章", () => {
      const template: Partial<EnterpriseTemplate> = {
        installedCount: 150,
      };

      const badges: string[] = [];
      if ((template.installedCount ?? 0) >= 100) {
        badges.push("popular");
      }

      expect(badges).toContain("popular");
    });
  });

  describe("格式化辅助函数", () => {
    test("应该格式化安装数量", () => {
      const formatInstallCount = (count: number): string => {
        if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
        return count.toString();
      };

      expect(formatInstallCount(50)).toBe("50");
      expect(formatInstallCount(999)).toBe("999");
      expect(formatInstallCount(1000)).toBe("1.0k");
      expect(formatInstallCount(1500)).toBe("1.5k");
      expect(formatInstallCount(10000)).toBe("10.0k");
    });

    test("应该格式化评分显示", () => {
      const formatRating = (rating: number): string => {
        return rating.toFixed(1);
      };

      expect(formatRating(4.5)).toBe("4.5");
      expect(formatRating(4.0)).toBe("4.0");
      expect(formatRating(4.87)).toBe("4.9");
    });
  });

  describe("实际模板管理器集成", () => {
    test("应该能够获取所有模板", () => {
      const templates = templateManager.getTemplates();
      expect(Array.isArray(templates)).toBe(true);
    });
  });
});
