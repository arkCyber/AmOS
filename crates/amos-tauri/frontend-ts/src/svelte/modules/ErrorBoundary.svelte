<!--
  ErrorBoundary.svelte — 错误边界组件 (航空航天级)
  
  功能:
  - 捕获子组件错误
  - 防止应用崩溃
  - 提供友好错误界面
  - 错误日志记录
  - 重试机制
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from '../locale.svelte';

  interface Props {
    children?: import('svelte').Snippet;
    fallback?: import('svelte').Snippet<[Error]>;
    onError?: (error: Error, errorInfo: { componentStack: string }) => void;
  }

  let { children, fallback, onError }: Props = $props();

  let hasError = $state(false);
  let error = $state<Error | null>(null);
  let errorCount = $state(0);
  let lastErrorTime = $state(0);

  // 错误处理函数
  function handleError(err: Error, info?: { componentStack?: string }) {
    const now = Date.now();
    
    // 防止错误风暴 (1 秒内超过 5 个错误)
    if (now - lastErrorTime < 1000) {
      errorCount++;
      if (errorCount > 5) {
        console.error('[ErrorBoundary] Error storm detected, stopping capture');
        return;
      }
    } else {
      errorCount = 1;
    }
    
    lastErrorTime = now;
    hasError = true;
    error = err;

    // 记录错误
    console.error('[ErrorBoundary] Caught error:', err);
    if (info?.componentStack) {
      console.error('[ErrorBoundary] Component stack:', info.componentStack);
    }

    // 调用回调
    if (onError) {
      try {
        onError(err, { componentStack: info?.componentStack || '' });
      } catch (callbackError) {
        console.error('[ErrorBoundary] Error in onError callback:', callbackError);
      }
    }
  }

  // 重置错误状态
  function reset() {
    hasError = false;
    error = null;
    errorCount = 0;
  }

  // 全局错误监听
  let errorHandler: ((event: ErrorEvent) => void) | null = null;
  let unhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

  onMount(() => {
    // 监听未捕获的错误
    errorHandler = (event: ErrorEvent) => {
      handleError(event.error || new Error(event.message));
      event.preventDefault();
    };

    // 监听未处理的 Promise 拒绝
    unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const error = event.reason instanceof Error 
        ? event.reason 
        : new Error(String(event.reason));
      handleError(error);
      event.preventDefault();
    };

    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', unhandledRejectionHandler);
  });

  onDestroy(() => {
    if (errorHandler) {
      window.removeEventListener('error', errorHandler);
    }
    if (unhandledRejectionHandler) {
      window.removeEventListener('unhandledrejection', unhandledRejectionHandler);
    }
  });

</script>

{#if hasError && error}
  {#if fallback}
    {@render fallback(error)}
  {:else}
    <!-- 默认兜底界面（REQ-A504）：**真 markup**，不是拼出来的 HTML 字符串。
         旧实现把这张卡片写成模板串再 `{@html …}`，两个后果都不是小事：
           ① 文案是**硬编码中文**（"应用出错 / 重试 / 刷新页面"），而 zh+en 界面里应走 `t()` ——
              两条 i18n 检查都看不见它（检查 4 只读 markup 段，`<script>` 那一遍只匹配**赋值**，
              不匹配 `return \`…\``）；
           ② `err.message` / `err.stack` 被当**原始 HTML** 插入。错误文本可以是外部带来的
              （桥回来的载荷、页面抛出的消息），而 `{@html}` 按定义不转义 ⇒ 那是一条注入面。
         现在文案走 `t()`，插值由 Svelte 转义。 -->
    <div class="flex h-full w-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-900">
      <div
        class="max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-700 dark:bg-neutral-800"
      >
        <div class="mb-4 flex items-center gap-3">
          <span class="text-3xl" aria-hidden="true">⚠️</span>
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t("errorBoundary.title")}
          </h2>
        </div>

        <p class="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          {t("errorBoundary.description")}
        </p>

        <details class="mb-4">
          <summary
            class="cursor-pointer text-sm font-medium text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          >
            {t("errorBoundary.details")}
          </summary>
          <pre
            class="mt-2 overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
            data-testid="error-boundary-details">{error.message}
{error.stack ?? ""}</pre>
        </details>

        <div class="flex gap-3">
          <button
            onclick={reset}
            class="flex-1 rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 active:bg-blue-700"
          >
            {t("errorBoundary.retry")}
          </button>
          <button
            onclick={() => window.location.reload()}
            class="flex-1 rounded-lg bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600"
          >
            {t("errorBoundary.reload")}
          </button>
        </div>
      </div>
    </div>
  {/if}
{:else}
  {@render children?.()}
{/if}
