<!-- ErrorBoundary.svelte — 错误边界组件 (航空航天级) -->
<script lang="ts">
  import { t } from "./locale.svelte";
  
  interface Props {
    children: import('svelte').Snippet;
  }
  
  let { children }: Props = $props();
  
  let error = $state<Error | null>(null);
  let errorInfo = $state<string>("");
  
  function handleError(event: ErrorEvent) {
    error = event.error;
    errorInfo = event.error?.stack || event.message || "未知错误";
    console.error('[WebMan ErrorBoundary]', event.error);
    
    // 阻止错误继续传播
    event.preventDefault();
  }
  
  function handleUnhandledRejection(event: PromiseRejectionEvent) {
    error = new Error(event.reason?.message || "Promise 未处理的拒绝");
    errorInfo = event.reason?.stack || String(event.reason) || "未知 Promise 错误";
    console.error('[WebMan ErrorBoundary] Unhandled Rejection:', event.reason);
    
    event.preventDefault();
  }
  
  $effect(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('error', handleError);
      window.addEventListener('unhandledrejection', handleUnhandledRejection);
      
      return () => {
        window.removeEventListener('error', handleError);
        window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      };
    }
  });
  
  function reset() {
    error = null;
    errorInfo = "";
    window.location.reload();
  }
  
  function copyError() {
    const text = `WebMan 错误报告\n\n错误: ${error?.message}\n\n堆栈:\n${errorInfo}`;
    navigator.clipboard.writeText(text).then(() => {
      alert('错误信息已复制到剪贴板');
    });
  }
</script>

{#if error}
  <div class="flex h-full w-full flex-col items-center justify-center bg-neutral-50 p-8 dark:bg-neutral-900">
    <!-- 错误图标 -->
    <div class="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
      <span class="text-4xl">⚠️</span>
    </div>
    
    <!-- 错误标题 -->
    <h1 class="mb-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
      浏览器遇到错误
    </h1>
    
    <!-- 错误描述 -->
    <p class="mb-6 max-w-md text-center text-sm text-neutral-600 dark:text-neutral-400">
      WebMan 遇到了一个意外错误。您可以尝试重新加载，或者复制错误信息报告给开发者。
    </p>
    
    <!-- 错误消息 -->
    {#if import.meta.env?.DEV}
      <div class="mb-6 w-full max-w-2xl rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/10">
        <p class="mb-2 font-mono text-xs font-semibold text-red-700 dark:text-red-400">
          {error.message}
        </p>
        <pre class="max-h-40 overflow-auto font-mono text-xs text-red-600 dark:text-red-500">{errorInfo}</pre>
      </div>
    {/if}
    
    <!-- 操作按钮 -->
    <div class="flex gap-3">
      <button
        onclick={reset}
        class="flex items-center gap-2 rounded-full bg-accent px-6 py-3 font-medium text-white transition-opacity hover:opacity-90"
      >
        <span>🔄</span>
        <span>重新加载</span>
      </button>
      
      {#if import.meta.env?.DEV}
        <button
          onclick={copyError}
          class="flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-6 py-3 font-medium transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
        >
          <span>📋</span>
          <span>复制错误</span>
        </button>
      {/if}
    </div>
    
    <!-- 技术信息 -->
    <div class="mt-8 text-xs text-neutral-500">
      <p>如果问题持续存在，请尝试清除浏览器数据或联系支持</p>
    </div>
  </div>
{:else}
  {@render children()}
{/if}
