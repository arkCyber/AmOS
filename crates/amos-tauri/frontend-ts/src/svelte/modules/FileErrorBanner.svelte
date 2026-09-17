<script lang="ts">
  /**
   * FileErrorBanner.svelte — 增强的文件操作错误反馈组件
   * 
   * 显示详细的错误信息、严重程度和可选的重试按钮。
   * 支持错误风暴检测和自动消失。
   */
  import { t } from "../locale.svelte";
  import type { FileOperationError } from "../../lib/filesError";
  import { getErrorMessageKey } from "../../lib/filesError";

  interface Props extends Record<string, unknown> {
    error: FileOperationError | null;
    onRetry?: () => void;
    onDismiss: () => void;
    /** 是否检测到错误风暴 */
    isStorm?: boolean;
  }

  let { error, onRetry, onDismiss, isStorm = false } = $props<Props>();

  // 根据严重程度生成样式
  const getSeverityClass = (severity: FileOperationError["severity"]): string => {
    switch (severity) {
      case "critical":
        return "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30";
      case "error":
        return "bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30";
      case "warning":
        return "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30";
      case "info":
        return "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30";
      default:
        return "bg-neutral-500/10 text-neutral-700 dark:text-neutral-300 border-neutral-500/30";
    }
  };

  // 严重程度图标
  const getSeverityIcon = (severity: FileOperationError["severity"]): string => {
    switch (severity) {
      case "critical":
        return "🛑";
      case "error":
        return "⚠️";
      case "warning":
        return "⚠️";
      case "info":
        return "ℹ️";
      default:
        return "ℹ️";
    }
  };
</script>

{#if error}
  <div
    role="alert"
    class={`mt-2 flex flex-wrap items-center gap-2 rounded-xl border p-3 ${getSeverityClass(error.severity)}`}
    data-testid="file-error-banner"
    data-severity={error.severity}
  >
    <!-- 严重程度图标 -->
    <span class="text-lg" aria-hidden="true">{getSeverityIcon(error.severity)}</span>

    <!-- 错误消息 -->
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium">
        {isStorm ? t("files.errorStorm") : t(getErrorMessageKey(error))}
      </p>
      {#if error.context && Object.keys(error.context).length > 0}
        <p class="mt-0.5 text-xs opacity-70">
          {Object.entries(error.context)
            .map(([key, val]) => `${key}: ${val}`)
            .join(", ")}
        </p>
      {/if}
    </div>

    <!-- 操作按钮 -->
    <div class="flex gap-2">
      {#if error.retryable && onRetry && !isStorm}
        <button
          onclick={onRetry}
          class="rounded-full px-3 py-1 text-xs font-medium bg-current/10 hover:bg-current/20 transition active:scale-95"
          data-testid="retry-button"
        >
          {t("files.retryAction")}
        </button>
      {/if}
      <button
        onclick={onDismiss}
        class="rounded-full px-3 py-1 text-xs font-medium bg-current/10 hover:bg-current/20 transition active:scale-95"
        data-testid="dismiss-button"
      >
        {t("files.dismissError")}
      </button>
    </div>
  </div>
{/if}
