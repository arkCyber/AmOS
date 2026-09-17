<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "svelte-i18n";
  import { getPushPermission, requestPushPermission } from "@/lib/pushNotifications";
  import type { PushResult } from "@/lib/pushNotifications";

  /** 是否显示对话框 */
  export let open = false;

  /** 关闭回调 */
  export let onClose: (() => void) | undefined = undefined;

  /** 权限授权成功回调 */
  export let onAuthorized: (() => void) | undefined = undefined;

  /** 当前权限状态 */
  type PermissionStatus = "notdetermined" | "denied" | "authorized" | "provisional";
  let permissionStatus: PermissionStatus = "notdetermined";

  /** 当前步骤: 1=说明页, 2=请求中, 3=完成页 */
  let currentStep = 1;

  /** 请求中状态 */
  let isRequesting = false;

  /** 错误消息 */
  let errorMessage = "";

  /** 对话框元素引用 */
  let dialogElement: HTMLDivElement;

  /** 首个可聚焦元素 */
  let firstFocusable: HTMLElement;

  /** 最后一个可聚焦元素 */
  let lastFocusable: HTMLElement;

  /**
   * 加载当前权限状态
   */
  async function loadPermissionStatus() {
    try {
      const status = await getPushPermission();
      permissionStatus = status;

      // 如果已授权，直接跳到完成页
      if (status === "authorized") {
        currentStep = 3;
      }
    } catch (error) {
      console.error("Failed to load permission status:", error);
    }
  }

  /**
   * 请求推送权限
   */
  async function handleRequestPermission() {
    if (isRequesting) return;

    isRequesting = true;
    errorMessage = "";
    currentStep = 2; // 切换到请求中页面

    try {
      const result: PushResult = await requestPushPermission();

      if (result.kind === "ok") {
        // 成功，刷新状态
        const status = await getPushPermission();
        permissionStatus = status;

        if (status === "authorized" || status === "provisional") {
          currentStep = 3; // 完成页
          if (onAuthorized) {
            onAuthorized();
          }
        } else if (status === "denied") {
          currentStep = 1;
          errorMessage = $_("pushPermission.deniedError");
        }
      } else {
        // 处理错误
        currentStep = 1;
        errorMessage = result.reason || $_("pushPermission.requestError");
      }
    } catch (error) {
      console.error("Permission request failed:", error);
      currentStep = 1;
      errorMessage = String(error);
    } finally {
      isRequesting = false;
    }
  }

  /**
   * 关闭对话框
   */
  function handleClose() {
    open = false;
    if (onClose) {
      onClose();
    }
  }

  /**
   * 完成并关闭
   */
  function handleComplete() {
    handleClose();
  }

  /**
   * 暂时不要（拒绝）
   */
  function handleDeny() {
    handleClose();
  }

  /**
   * 打开系统设置
   */
  function handleOpenSettings() {
    // TODO: 调用 Tauri 命令打开系统设置
    console.log("Open system settings");
  }

  /**
   * 键盘事件处理
   */
  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;

    // Esc 关闭
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
      return;
    }

    // Tab 焦点陷阱
    if (event.key === "Tab") {
      const focusableElements = dialogElement?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );

      if (focusableElements && focusableElements.length > 0) {
        firstFocusable = focusableElements[0];
        lastFocusable = focusableElements[focusableElements.length - 1];

        if (event.shiftKey) {
          // Shift+Tab
          if (document.activeElement === firstFocusable) {
            event.preventDefault();
            lastFocusable?.focus();
          }
        } else {
          // Tab
          if (document.activeElement === lastFocusable) {
            event.preventDefault();
            firstFocusable?.focus();
          }
        }
      }
    }
  }

  // 挂载时加载状态
  onMount(() => {
    loadPermissionStatus();
  });

  // 监听打开状态变化
  $: if (open && dialogElement) {
    // 聚焦第一个可聚焦元素
    setTimeout(() => {
      const focusable = dialogElement.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      focusable?.focus();
    }, 100);
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <!-- 背景遮罩 -->
  <div
    class="push-permission-backdrop"
    on:click={handleClose}
    role="presentation"
  ></div>

  <!-- 对话框 -->
  <div
    bind:this={dialogElement}
    class="push-permission-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="push-permission-title"
    aria-describedby="push-permission-description"
  >
    {#if currentStep === 1}
      <!-- 步骤 1: 说明页 -->
      <div class="dialog-content">
        <div class="dialog-icon">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect width="64" height="64" rx="16" fill="#007AFF" />
            <path
              d="M32 20v24M20 32h24"
              stroke="white"
              stroke-width="3"
              stroke-linecap="round"
            />
          </svg>
        </div>

        <h2 id="push-permission-title" class="dialog-title">
          {$_("pushPermission.title")}
        </h2>

        <p id="push-permission-description" class="dialog-description">
          {$_("pushPermission.description")}
        </p>

        <ul class="dialog-benefits">
          {#each $_("pushPermission.benefits") as benefit}
            <li class="benefit-item">
              <span class="benefit-icon">✓</span>
              <span>{benefit}</span>
            </li>
          {/each}
        </ul>

        {#if errorMessage}
          <div class="error-message">
            <span class="error-icon">⚠️</span>
            <span>{errorMessage}</span>
          </div>
        {/if}

        {#if permissionStatus === "denied"}
          <!-- 已拒绝状态 -->
          <div class="denied-hint">
            <p>{$_("pushPermission.deniedHint")}</p>
          </div>
        {/if}

        <div class="dialog-actions">
          {#if permissionStatus === "denied"}
            <button
              class="btn btn-primary"
              on:click={handleOpenSettings}
              type="button"
            >
              {$_("pushPermission.openSettings")}
            </button>
            <button
              class="btn btn-secondary"
              on:click={handleClose}
              type="button"
            >
              {$_("pushPermission.close")}
            </button>
          {:else}
            <button
              class="btn btn-primary"
              on:click={handleRequestPermission}
              disabled={isRequesting}
              type="button"
            >
              {$_("pushPermission.request")}
            </button>
            <button
              class="btn btn-secondary"
              on:click={handleDeny}
              type="button"
            >
              {$_("pushPermission.deny")}
            </button>
          {/if}
        </div>
      </div>
    {:else if currentStep === 2}
      <!-- 步骤 2: 请求中 -->
      <div class="dialog-content dialog-loading">
        <div class="loading-spinner"></div>
        <h2 class="dialog-title">{$_("pushPermission.requesting")}</h2>
        <p class="dialog-description">{$_("pushPermission.requestingHint")}</p>
      </div>
    {:else if currentStep === 3}
      <!-- 步骤 3: 完成页 -->
      <div class="dialog-content">
        <div class="dialog-icon dialog-icon-success">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect width="64" height="64" rx="16" fill="#34C759" />
            <path
              d="M20 32l8 8 16-16"
              stroke="white"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>

        <h2 class="dialog-title">{$_("pushPermission.successTitle")}</h2>
        <p class="dialog-description">{$_("pushPermission.successDescription")}</p>

        <div class="dialog-actions">
          <button
            class="btn btn-primary btn-full"
            on:click={handleComplete}
            type="button"
          >
            {$_("pushPermission.done")}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .push-permission-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(4px);
    z-index: 9998;
    animation: fadeIn 0.2s ease;
  }

  .push-permission-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 90%;
    max-width: 480px;
    background: var(--bg-primary, #ffffff);
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
    z-index: 9999;
    animation: slideUp 0.3s ease;
  }

  @media (prefers-color-scheme: dark) {
    .push-permission-dialog {
      background: var(--bg-primary, #1c1c1e);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }
  }

  .dialog-content {
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .dialog-icon {
    margin-bottom: 16px;
    animation: scaleIn 0.4s ease;
  }

  .dialog-icon-success {
    animation: scaleIn 0.4s ease, pulse 0.6s ease 0.4s;
  }

  .dialog-title {
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 8px 0;
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .dialog-title {
      color: var(--text-primary, #ffffff);
    }
  }

  .dialog-description {
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-secondary, #666666);
    margin: 0 0 20px 0;
  }

  @media (prefers-color-scheme: dark) {
    .dialog-description {
      color: var(--text-secondary, #8e8e93);
    }
  }

  .dialog-benefits {
    list-style: none;
    padding: 0;
    margin: 0 0 24px 0;
    width: 100%;
  }

  .benefit-item {
    display: flex;
    align-items: center;
    padding: 8px 0;
    text-align: left;
    font-size: 14px;
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .benefit-item {
      color: var(--text-primary, #ffffff);
    }
  }

  .benefit-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #34c759;
    color: white;
    font-size: 12px;
    font-weight: 600;
    margin-right: 12px;
    flex-shrink: 0;
  }

  .error-message {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: rgba(255, 59, 48, 0.1);
    border: 1px solid rgba(255, 59, 48, 0.3);
    border-radius: 8px;
    color: #ff3b30;
    font-size: 14px;
    margin-bottom: 16px;
    width: 100%;
  }

  .error-icon {
    font-size: 18px;
    flex-shrink: 0;
  }

  .denied-hint {
    padding: 12px 16px;
    background: rgba(142, 142, 147, 0.1);
    border: 1px solid rgba(142, 142, 147, 0.3);
    border-radius: 8px;
    margin-bottom: 16px;
    width: 100%;
  }

  .denied-hint p {
    margin: 0;
    font-size: 14px;
    color: var(--text-secondary, #666666);
  }

  @media (prefers-color-scheme: dark) {
    .denied-hint p {
      color: var(--text-secondary, #8e8e93);
    }
  }

  .dialog-actions {
    display: flex;
    gap: 12px;
    width: 100%;
  }

  .btn {
    flex: 1;
    padding: 12px 24px;
    border: none;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    outline: none;
  }

  .btn:focus-visible {
    outline: 2px solid #007aff;
    outline-offset: 2px;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #007aff;
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: #0051d5;
  }

  .btn-primary:active:not(:disabled) {
    transform: scale(0.98);
  }

  .btn-secondary {
    background: rgba(142, 142, 147, 0.1);
    color: var(--text-primary, #000000);
  }

  @media (prefers-color-scheme: dark) {
    .btn-secondary {
      background: rgba(142, 142, 147, 0.2);
      color: var(--text-primary, #ffffff);
    }
  }

  .btn-secondary:hover:not(:disabled) {
    background: rgba(142, 142, 147, 0.2);
  }

  .btn-secondary:active:not(:disabled) {
    transform: scale(0.98);
  }

  .btn-full {
    width: 100%;
  }

  /* 加载状态 */
  .dialog-loading {
    min-height: 200px;
    justify-content: center;
  }

  .loading-spinner {
    width: 48px;
    height: 48px;
    border: 4px solid rgba(0, 122, 255, 0.2);
    border-top-color: #007aff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 16px;
  }

  /* 动画 */
  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes slideUp {
    from {
      transform: translate(-50%, -45%);
      opacity: 0;
    }
    to {
      transform: translate(-50%, -50%);
      opacity: 1;
    }
  }

  @keyframes scaleIn {
    from {
      transform: scale(0.8);
      opacity: 0;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }

  @keyframes pulse {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.05);
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  /* 响应式 */
  @media (max-width: 640px) {
    .push-permission-dialog {
      width: 95%;
      max-width: none;
    }

    .dialog-content {
      padding: 24px 16px;
    }
  }
</style>
