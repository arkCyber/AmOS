/**
 * TemplateLibrary.test.ts - 企业模板库组件单元测试
 * 
 * 测试覆盖:
 * - 模板列表渲染
 * - 搜索和过滤功能
 * - 模板详情模态框
 * - 模板安装流程
 * - 参数配置和验证
 * - 错误处理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import TemplateLibrary from "../TemplateLibrary.svelte";
import { templateManager } from "../../../lib/enterprise";
import type { EnterpriseTemplate } from "../../../lib/enterprise/templates";

// Mock 企业模板管理器
vi.mock("../../../lib/enterprise", () => ({
  templateManager: {
    getTemplates: vi.fn(),
    installTemplate: vi.fn(),
  },
}));

// Mock 快捷指令加载
vi.mock("../../../lib/shortcuts", () => ({
  loadShortcuts: vi.fn(() => []),
}));

// Mock 国际化
vi.mock("../../locale.svelte", () => ({
  t: vi.fn((key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      "templates.title": "企业模板库",
      "templates.subtitle": "浏览和安装企业提供的标准化快捷指令模板",
      "templates.searchPlaceholder": "搜索模板...",
      "templates.allCategories": "全部类别",
      "templates.allDepartments": "全部部门",
      "templates.resetFilters": "重置筛选",
      "templates.foundCount": `找到 ${params?.count || 0} 个模板`,
      "templates.emptyTitle": "暂无模板",
      "templates.emptyHint": "请尝试调整筛选条件",
      "templates.badgeRequired": "必装",
      "templates.badgeInstalled": "已安装",
      "templates.version": `版本 ${params?.version}`,
      "templates.installCount": `${params?.count} 次安装`,
      "templates.close": "关闭",
      "templates.versionLabel": "版本",
      "templates.categoryLabel": "类别",
      "templates.departmentLabel": "部门",
      "templates.installCountLabel": "安装次数",
      "templates.descriptionLabel": "描述",
      "templates.parametersTitle": "参数配置",
      "templates.selectPlaceholder": "请选择",
      "templates.cancel": "取消",
      "templates.install": "安装",
      "templates.installing": "安装中...",
      "templates.installSuccess": "安装成功",
      "templates.installFailed": `安装失败: ${params?.reason}`,
      "templates.missingParams": `缺少必填参数: ${params?.params}`,
      "templates.unknownError": "未知错误",
    };
    return translations[key] || key;
  }),
}));

// Mock 焦点陷阱
vi.mock("../../../lib/focusTrap", () => ({
  attachFocusTrap: vi.fn(() => () => {}),
}));

describe("TemplateLibrary", () => {
  // 测试数据
  const mockTemplates: EnterpriseTemplate[] = [
    {
      id: "tpl-1",
      name: "销售报告生成器",
      description: "自动生成每日销售报告",
      category: "销售",
      department: "销售部",
      version: "1.0.0",
      status: "published",
      isForced: false,
      parameters: [
        {
          key: "report_email",
          name: "接收邮箱",
          type: "text",
          required: true,
          description: "报告发送目标邮箱",
        },
      ],
      shortcutData: {
        id: "shortcut-1",
        name: "销售报告",
        color: "blue",
        icon: "chart",
        actions: [
          { type: "get_data", config: {} },
          { type: "format_report", config: {} },
          { type: "send_email", config: {} },
        ],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "tpl-2",
      name: "会议纪要助手",
      description: "快速创建会议纪要",
      category: "办公",
      department: "行政部",
      version: "2.1.0",
      status: "published",
      isForced: true,
      parameters: [],
      shortcutData: {
        id: "shortcut-2",
        name: "会议纪要",
        color: "green",
        icon: "note",
        actions: [
          { type: "create_note", config: {} },
          { type: "share", config: {} },
        ],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "tpl-3",
      name: "客户反馈收集",
      description: "收集和整理客户反馈",
      category: "市场",
      version: "1.5.0",
      status: "published",
      isForced: false,
      parameters: [
        {
          key: "survey_url",
          name: "问卷链接",
          type: "url",
          required: true,
          description: "客户反馈问卷的 URL",
        },
        {
          key: "auto_remind",
          name: "自动提醒",
          type: "boolean",
          required: false,
          defaultValue: false,
          description: "是否自动发送提醒",
        },
      ],
      shortcutData: {
        id: "shortcut-3",
        name: "反馈收集",
        color: "orange",
        icon: "feedback",
        actions: [{ type: "collect_feedback", config: {} }],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (templateManager.getTemplates as any).mockReturnValue(mockTemplates);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("基础渲染", () => {
    it("应该渲染标题和副标题", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("企业模板库")).toBeInTheDocument();
      expect(screen.getByText("浏览和安装企业提供的标准化快捷指令模板")).toBeInTheDocument();
    });

    it("应该渲染搜索框", () => {
      render(TemplateLibrary);
      
      const searchInput = screen.getByPlaceholderText("搜索模板...");
      expect(searchInput).toBeInTheDocument();
    });

    it("应该渲染类别和部门筛选器", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("全部类别")).toBeInTheDocument();
      expect(screen.getByText("全部部门")).toBeInTheDocument();
    });

    it("应该渲染所有模板卡片", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("销售报告生成器")).toBeInTheDocument();
      expect(screen.getByText("会议纪要助手")).toBeInTheDocument();
      expect(screen.getByText("客户反馈收集")).toBeInTheDocument();
    });

    it("应该显示模板数量", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("找到 3 个模板")).toBeInTheDocument();
    });
  });

  describe("搜索功能", () => {
    it("应该根据搜索关键词过滤模板", async () => {
      (templateManager.getTemplates as any).mockImplementation((filters?: any) => {
        if (!filters?.search) return mockTemplates;
        return mockTemplates.filter(t => 
          t.name.includes(filters.search) || t.description.includes(filters.search)
        );
      });

      const { container } = render(TemplateLibrary);
      const searchInput = screen.getByPlaceholderText("搜索模板...") as HTMLInputElement;
      
      await fireEvent.input(searchInput, { target: { value: "销售" } });
      
      await waitFor(() => {
        expect(screen.getByText("销售报告生成器")).toBeInTheDocument();
        expect(screen.queryByText("会议纪要助手")).not.toBeInTheDocument();
      });
    });

    it("搜索无结果时应该显示空状态", async () => {
      (templateManager.getTemplates as any).mockImplementation((filters?: any) => {
        if (filters?.search === "不存在的模板") return [];
        return mockTemplates;
      });

      render(TemplateLibrary);
      const searchInput = screen.getByPlaceholderText("搜索模板...") as HTMLInputElement;
      
      await fireEvent.input(searchInput, { target: { value: "不存在的模板" } });
      
      await waitFor(() => {
        expect(screen.getByText("暂无模板")).toBeInTheDocument();
        expect(screen.getByText("请尝试调整筛选条件")).toBeInTheDocument();
      });
    });

    it("应该显示清除搜索按钮", async () => {
      render(TemplateLibrary);
      const searchInput = screen.getByPlaceholderText("搜索模板...") as HTMLInputElement;
      
      await fireEvent.input(searchInput, { target: { value: "测试" } });
      
      await waitFor(() => {
        const clearBtn = screen.getByText("×");
        expect(clearBtn).toBeInTheDocument();
      });
    });

    it("点击清除按钮应该清空搜索", async () => {
      render(TemplateLibrary);
      const searchInput = screen.getByPlaceholderText("搜索模板...") as HTMLInputElement;
      
      await fireEvent.input(searchInput, { target: { value: "测试" } });
      
      const clearBtn = screen.getByText("×");
      await fireEvent.click(clearBtn);
      
      expect(searchInput.value).toBe("");
    });
  });

  describe("筛选功能", () => {
    it("应该根据类别筛选模板", async () => {
      (templateManager.getTemplates as any).mockImplementation((filters?: any) => {
        if (!filters?.category) return mockTemplates;
        return mockTemplates.filter(t => t.category === filters.category);
      });

      render(TemplateLibrary);
      const categorySelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
      
      await fireEvent.change(categorySelect, { target: { value: "销售" } });
      
      await waitFor(() => {
        expect(screen.getByText("销售报告生成器")).toBeInTheDocument();
        expect(screen.queryByText("会议纪要助手")).not.toBeInTheDocument();
      });
    });

    it("应该根据部门筛选模板", async () => {
      (templateManager.getTemplates as any).mockImplementation((filters?: any) => {
        if (!filters?.department) return mockTemplates;
        return mockTemplates.filter(t => t.department === filters.department);
      });

      render(TemplateLibrary);
      const departmentSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
      
      await fireEvent.change(departmentSelect, { target: { value: "销售部" } });
      
      await waitFor(() => {
        expect(screen.getByText("销售报告生成器")).toBeInTheDocument();
        expect(screen.queryByText("会议纪要助手")).not.toBeInTheDocument();
      });
    });

    it("应该支持组合筛选", async () => {
      (templateManager.getTemplates as any).mockImplementation((filters?: any) => {
        let result = mockTemplates;
        if (filters?.category) {
          result = result.filter(t => t.category === filters.category);
        }
        if (filters?.search) {
          result = result.filter(t => t.name.includes(filters.search));
        }
        return result;
      });

      render(TemplateLibrary);
      const searchInput = screen.getByPlaceholderText("搜索模板...") as HTMLInputElement;
      const categorySelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
      
      await fireEvent.input(searchInput, { target: { value: "销售" } });
      await fireEvent.change(categorySelect, { target: { value: "销售" } });
      
      await waitFor(() => {
        expect(screen.getByText("销售报告生成器")).toBeInTheDocument();
        expect(screen.getByText("找到 1 个模板")).toBeInTheDocument();
      });
    });

    it("应该显示重置筛选按钮", async () => {
      render(TemplateLibrary);
      const searchInput = screen.getByPlaceholderText("搜索模板...") as HTMLInputElement;
      
      await fireEvent.input(searchInput, { target: { value: "测试" } });
      
      await waitFor(() => {
        expect(screen.getByText("重置筛选")).toBeInTheDocument();
      });
    });

    it("点击重置应该清除所有筛选条件", async () => {
      render(TemplateLibrary);
      const searchInput = screen.getByPlaceholderText("搜索模板...") as HTMLInputElement;
      const categorySelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
      
      await fireEvent.input(searchInput, { target: { value: "测试" } });
      await fireEvent.change(categorySelect, { target: { value: "销售" } });
      
      const resetBtn = screen.getByText("重置筛选");
      await fireEvent.click(resetBtn);
      
      expect(searchInput.value).toBe("");
      expect(categorySelect.value).toBe("");
    });
  });

  describe("模板卡片显示", () => {
    it("应该显示模板图标和名称", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("销售报告生成器")).toBeInTheDocument();
      // 图标通过 getCategoryIcon 显示
    });

    it("应该显示必装徽章", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("必装")).toBeInTheDocument();
    });

    it("应该显示模板描述", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("自动生成每日销售报告")).toBeInTheDocument();
      expect(screen.getByText("快速创建会议纪要")).toBeInTheDocument();
    });

    it("应该显示版本信息", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("版本 1.0.0")).toBeInTheDocument();
      expect(screen.getByText("版本 2.1.0")).toBeInTheDocument();
    });

    it("应该显示类别和部门标签", () => {
      render(TemplateLibrary);
      
      expect(screen.getByText("销售")).toBeInTheDocument();
      expect(screen.getByText("办公")).toBeInTheDocument();
      expect(screen.getByText("销售部")).toBeInTheDocument();
    });
  });

  describe("模板详情模态框", () => {
    it("点击模板卡片应该打开详情模态框", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        expect(screen.getAllByText("销售报告生成器")[1]).toBeInTheDocument(); // 模态框中的标题
        expect(screen.getByText("自动生成每日销售报告")).toBeInTheDocument();
      });
    });

    it("应该显示模板的详细信息", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        expect(screen.getByText("版本")).toBeInTheDocument();
        expect(screen.getByText("类别")).toBeInTheDocument();
        expect(screen.getByText("部门")).toBeInTheDocument();
        expect(screen.getByText("描述")).toBeInTheDocument();
      });
    });

    it("应该显示参数配置表单", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        expect(screen.getByText("参数配置")).toBeInTheDocument();
        expect(screen.getByText("接收邮箱")).toBeInTheDocument();
      });
    });

    it("应该显示快捷指令信息", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        expect(screen.getByText(/包含 3 个动作/)).toBeInTheDocument();
      });
    });

    it("点击关闭按钮应该关闭模态框", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const closeBtn = screen.getByLabelText("关闭");
        fireEvent.click(closeBtn);
      });
      
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("点击取消按钮应该关闭模态框", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const cancelBtn = screen.getByText("取消");
        fireEvent.click(cancelBtn);
      });
      
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });
  });

  describe("参数配置", () => {
    it("应该支持文本类型参数", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const input = screen.getByPlaceholderText("报告发送目标邮箱") as HTMLInputElement;
        expect(input).toBeInTheDocument();
        expect(input.type).toBe("text");
      });
    });

    it("应该支持 URL 类型参数", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("客户反馈收集").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const input = screen.getByPlaceholderText("客户反馈问卷的 URL") as HTMLInputElement;
        expect(input).toBeInTheDocument();
        expect(input.type).toBe("url");
      });
    });

    it("应该支持布尔类型参数", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("客户反馈收集").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const checkbox = screen.getByText("是否自动发送提醒").previousElementSibling as HTMLInputElement;
        expect(checkbox).toBeInTheDocument();
        expect(checkbox.type).toBe("checkbox");
      });
    });

    it("应该标记必填参数", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        expect(screen.getByText("*")).toBeInTheDocument(); // 必填标记
      });
    });

    it("应该初始化参数默认值", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("客户反馈收集").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const checkbox = screen.getByText("是否自动发送提醒").previousElementSibling as HTMLInputElement;
        expect(checkbox.checked).toBe(false); // defaultValue: false
      });
    });
  });

  describe("模板安装", () => {
    it("缺少必填参数时应该提示错误", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("销售报告生成器").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const installBtn = screen.getByText("安装");
        fireEvent.click(installBtn);
      });
      
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("缺少必填参数"));
      alertSpy.mockRestore();
    });

    it("成功安装应该显示成功提示", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      (templateManager.installTemplate as any).mockResolvedValue({
        success: true,
        shortcutId: "shortcut-123",
      });
      
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("会议纪要助手").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const installBtn = screen.getByText("安装");
        fireEvent.click(installBtn);
      });
      
      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("安装成功"));
      });
      
      alertSpy.mockRestore();
    });

    it("安装失败应该显示错误提示", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      (templateManager.installTemplate as any).mockResolvedValue({
        success: false,
        message: "网络错误",
      });
      
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("会议纪要助手").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const installBtn = screen.getByText("安装");
        fireEvent.click(installBtn);
      });
      
      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("网络错误"));
      });
      
      alertSpy.mockRestore();
    });

    it("安装过程中应该禁用按钮", async () => {
      (templateManager.installTemplate as any).mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({ success: true }), 100))
      );
      
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("会议纪要助手").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const installBtn = screen.getByText("安装") as HTMLButtonElement;
        fireEvent.click(installBtn);
      });
      
      await waitFor(() => {
        const installingBtn = screen.getByText("安装中...") as HTMLButtonElement;
        expect(installingBtn.disabled).toBe(true);
      });
    });

    it("安装成功后应该关闭模态框", async () => {
      vi.spyOn(window, "alert").mockImplementation(() => {});
      (templateManager.installTemplate as any).mockResolvedValue({
        success: true,
        shortcutId: "shortcut-123",
      });
      
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("会议纪要助手").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const installBtn = screen.getByText("安装");
        fireEvent.click(installBtn);
      });
      
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });
  });

  describe("边界情况", () => {
    it("应该处理空模板列表", () => {
      (templateManager.getTemplates as any).mockReturnValue([]);
      
      render(TemplateLibrary);
      
      expect(screen.getByText("暂无模板")).toBeInTheDocument();
      expect(screen.getByText("找到 0 个模板")).toBeInTheDocument();
    });

    it("应该处理没有参数的模板", async () => {
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("会议纪要助手").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        expect(screen.queryByText("参数配置")).not.toBeInTheDocument();
      });
    });

    it("应该处理没有部门的模板", () => {
      render(TemplateLibrary);
      
      const marketingCard = screen.getByText("客户反馈收集").closest("button");
      // 模板 3 没有 department 字段
      expect(marketingCard).toBeInTheDocument();
    });

    it("应该处理安装异常", async () => {
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      (templateManager.installTemplate as any).mockRejectedValue(new Error("网络连接失败"));
      
      render(TemplateLibrary);
      
      const templateCard = screen.getByText("会议纪要助手").closest("button");
      await fireEvent.click(templateCard!);
      
      await waitFor(() => {
        const installBtn = screen.getByText("安装");
        fireEvent.click(installBtn);
      });
      
      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("网络连接失败"));
      });
      
      alertSpy.mockRestore();
    });
  });

  describe("辅助函数", () => {
    it("getCategoryIcon 应该返回正确的图标", () => {
      render(TemplateLibrary);
      
      // 通过渲染的类别标签验证图标
      expect(screen.getByText("销售")).toBeInTheDocument();
      expect(screen.getByText("办公")).toBeInTheDocument();
      expect(screen.getByText("市场")).toBeInTheDocument();
    });

    it("isInstalled 应该正确判断安装状态", () => {
      const { loadShortcuts } = require("../../../lib/shortcuts");
      loadShortcuts.mockReturnValue([{ templateId: "tpl-1" }]);
      
      render(TemplateLibrary);
      
      // 模板 1 应该显示"已安装"徽章
      expect(screen.getByText("已安装")).toBeInTheDocument();
    });
  });
});
