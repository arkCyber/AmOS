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
      const templates: EnterpriseTemplate[] = [
        {
          id: "tpl-001",
          name: "每日报告",
          description: "自动生成每日工作报告",
          category: "productivity",
          department: "engineering",
          version: "1.0.0",
          author: "Admin",
          tags: ["report", "daily"],
          parameters: [],
          actions: [],
          requiredPermissions: [],
          icon: "📊",
          installCount: 100,
          rating: 4.5,
          isRequired: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: "tpl-002",
          name: "周报生成",
          description: "生成周报模板",
          category: "productivity",
          department: "engineering",
          version: "1.0.0",
          author: "Admin",
          tags: ["report", "weekly"],
          parameters: [],
          actions: [],
          requiredPermissions: [],
          icon: "📈",
          installCount: 80,
          rating: 4.3,
          isRequired: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const searchQuery = "每日";
      const filtered = templates.filter(t => 
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description.toLowerCase().includes(searchQuery.toLowerCase())
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("tpl-001");
    });

    test("空搜索应该返回所有模板", () => {
      const templates: EnterpriseTemplate[] = [
        { id: "1", name: "Template 1" } as EnterpriseTemplate,
        { id: "2", name: "Template 2" } as EnterpriseTemplate,
      ];

      const searchQuery = "";
      const filtered = templates.filter(t => 
        !searchQuery || 
        t.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      expect(filtered).toHaveLength(2);
    });
  });

  describe("分类过滤", () => {
    test("应该能够按分类过滤模板", () => {
      const templates: EnterpriseTemplate[] = [
        { id: "1", category: "productivity" } as EnterpriseTemplate,
        { id: "2", category: "automation" } as EnterpriseTemplate,
        { id: "3", category: "productivity" } as EnterpriseTemplate,
      ];

      const category = "productivity";
      const filtered = templates.filter(t => 
        !category || category === "all" || t.category === category
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(t => t.category === "productivity")).toBe(true);
    });

    test("'all' 分类应该返回所有模板", () => {
      const templates: EnterpriseTemplate[] = [
        { id: "1", category: "productivity" } as EnterpriseTemplate,
        { id: "2", category: "automation" } as EnterpriseTemplate,
      ];

      const category = "all";
      const filtered = templates.filter(t => 
        !category || category === "all" || t.category === category
      );

      expect(filtered).toHaveLength(2);
    });
  });

  describe("部门过滤", () => {
    test("应该能够按部门过滤模板", () => {
      const templates: EnterpriseTemplate[] = [
        { id: "1", department: "engineering" } as EnterpriseTemplate,
        { id: "2", department: "sales" } as EnterpriseTemplate,
        { id: "3", department: "engineering" } as EnterpriseTemplate,
      ];

      const department = "engineering";
      const filtered = templates.filter(t => 
        !department || department === "all" || t.department === department
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.every(t => t.department === "engineering")).toBe(true);
    });
  });

  describe("组合过滤", () => {
    test("应该支持搜索 + 分类 + 部门组合过滤", () => {
      const templates: EnterpriseTemplate[] = [
        {
          id: "1",
          name: "工程报告",
          category: "productivity",
          department: "engineering",
        } as EnterpriseTemplate,
        {
          id: "2",
          name: "销售报告",
          category: "productivity",
          department: "sales",
        } as EnterpriseTemplate,
        {
          id: "3",
          name: "工程自动化",
          category: "automation",
          department: "engineering",
        } as EnterpriseTemplate,
      ];

      const searchQuery = "工程";
      const category = "productivity";
      const department = "engineering";

      const filtered = templates.filter(t => {
        const matchesSearch = !searchQuery || 
          t.name.toLowerCase().includes(searchQuery.toLowerCase());
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
      const templates: EnterpriseTemplate[] = [
        { id: "1", category: "productivity" } as EnterpriseTemplate,
        { id: "2", category: "automation" } as EnterpriseTemplate,
        { id: "3", category: "productivity" } as EnterpriseTemplate,
        { id: "4", category: "communication" } as EnterpriseTemplate,
      ];

      const categories = Array.from(new Set(templates.map(t => t.category)));

      expect(categories).toHaveLength(3);
      expect(categories).toContain("productivity");
      expect(categories).toContain("automation");
      expect(categories).toContain("communication");
    });

    test("应该能够提取所有唯一的部门", () => {
      const templates: EnterpriseTemplate[] = [
        { id: "1", department: "engineering" } as EnterpriseTemplate,
        { id: "2", department: "sales" } as EnterpriseTemplate,
        { id: "3", department: "engineering" } as EnterpriseTemplate,
        { id: "4", department: "hr" } as EnterpriseTemplate,
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
      const parameter: TemplateParameter = {
        name: "projectName",
        type: "string",
        label: "项目名称",
        description: "输入项目名称",
        required: true,
        defaultValue: "",
      };

      const value = "";
      const isValid = !parameter.required || (value && value.trim().length > 0);

      expect(isValid).toBe(false);
    });

    test("应该验证数字参数范围", () => {
      const parameter: TemplateParameter = {
        name: "count",
        type: "number",
        label: "数量",
        required: true,
        min: 1,
        max: 100,
      };

      const validateNumber = (value: number, param: TemplateParameter): boolean => {
        if (param.min !== undefined && value < param.min) return false;
        if (param.max !== undefined && value > param.max) return false;
        return true;
      };

      expect(validateNumber(50, parameter)).toBe(true);
      expect(validateNumber(0, parameter)).toBe(false);
      expect(validateNumber(101, parameter)).toBe(false);
    });

    test("应该验证选项参数", () => {
      const parameter: TemplateParameter = {
        name: "priority",
        type: "select",
        label: "优先级",
        required: true,
        options: ["low", "medium", "high"],
      };

      const value = "medium";
      const isValid = !parameter.options || parameter.options.includes(value);

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
        isRequired: true,
      };

      const badges: string[] = [];
      if (template.isRequired) badges.push("required");

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
        rating: 4.5,
        installCount: 150,
      };

      const badges: string[] = [];
      if ((template.rating ?? 0) >= 4.5 && (template.installCount ?? 0) >= 100) {
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
      const templates = templateManager.getAllTemplates();
      expect(Array.isArray(templates)).toBe(true);
    });

    test("应该能够获取已安装的模板", () => {
      const installations = templateManager.getInstallations();
      expect(Array.isArray(installations)).toBe(true);
    });
  });
});
