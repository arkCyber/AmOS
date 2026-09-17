/**
 * enterprise/logger.ts — 企业功能日志工具
 * 
 * 简化的日志记录器，用于企业功能模块
 */

export const logger = {
  debug(area: string, msg: string, data?: unknown): void {
    if (typeof window !== "undefined" && (window as any).DEBUG_MODE) {
      console.debug(`[${area}] ${msg}`, data !== undefined ? data : "");
    }
  },

  info(area: string, msg: string, data?: unknown): void {
    console.info(`[${area}] ${msg}`, data !== undefined ? data : "");
  },

  warn(area: string, msg: string, data?: unknown): void {
    console.warn(`[${area}] ${msg}`, data !== undefined ? data : "");
  },

  error(area: string, msg: string, data?: unknown): void {
    console.error(`[${area}] ${msg}`, data !== undefined ? data : "");
  },
};
