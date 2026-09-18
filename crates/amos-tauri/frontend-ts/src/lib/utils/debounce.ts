/**
 * debounce.ts — 防抖工具函数
 * 
 * 延迟执行函数，直到调用停止一段时间后才执行。
 * 常用于优化高频触发的事件（如搜索输入、窗口调整）。
 */

/**
 * 创建一个防抖函数
 * 
 * @param fn - 要防抖的函数
 * @param delay - 延迟时间（毫秒）
 * @returns 防抖后的函数
 * 
 * @example
 * ```typescript
 * const search = debounce((query: string) => {
 *   console.log('Searching:', query);
 * }, 300);
 * 
 * search('hello'); // 不会立即执行
 * search('world'); // 取消上一次，重新计时
 * // 300ms 后执行: Searching: world
 * ```
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = function (this: any, ...args: Parameters<T>) {
    // 清除之前的定时器
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    // 设置新的定时器
    timeoutId = setTimeout(() => {
      fn.apply(this, args);
      timeoutId = null;
    }, delay);
  };

  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}

/**
 * 创建一个可取消的防抖函数
 * 
 * @param fn - 要防抖的函数
 * @param delay - 延迟时间（毫秒）
 * @returns 包含 `execute` 和 `cancel` 方法的对象
 * 
 * @example
 * ```typescript
 * const { execute, cancel } = debounceCancellable((query: string) => {
 *   console.log('Searching:', query);
 * }, 300);
 * 
 * execute('hello');
 * cancel(); // 取消执行
 * ```
 */
export function debounceCancellable<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): {
  execute: (...args: Parameters<T>) => void;
  cancel: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const execute = function (this: any, ...args: Parameters<T>) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      fn.apply(this, args);
      timeoutId = null;
    }, delay);
  };

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return { execute, cancel };
}

/**
 * 创建一个立即执行的防抖函数（首次调用立即执行，后续调用防抖）
 * 
 * @param fn - 要防抖的函数
 * @param delay - 延迟时间（毫秒）
 * @returns 防抖后的函数
 * 
 * @example
 * ```typescript
 * const log = debounceLeading((msg: string) => {
 *   console.log(msg);
 * }, 300);
 * 
 * log('first');  // 立即执行
 * log('second'); // 被防抖
 * log('third');  // 被防抖
 * // 300ms 后可以再次立即执行
 * ```
 */
export function debounceLeading<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastExecuted = 0;

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now();

    if (now - lastExecuted >= delay) {
      // 距离上次执行已经超过延迟，立即执行
      fn.apply(this, args);
      lastExecuted = now;
    } else {
      // 否则防抖
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        fn.apply(this, args);
        lastExecuted = Date.now();
        timeoutId = null;
      }, delay - (now - lastExecuted));
    }
  };
}
