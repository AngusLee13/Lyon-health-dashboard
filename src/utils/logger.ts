/**
 * 结构化日志系统
 * 支持日志级别、模块标签、时间戳、耗时追踪
 *
 * 用法:
 *   import { createLogger } from '../utils/logger';
 *   const log = createLogger('模块名');
 *   log.info('消息', { extra: 'data' });
 *   log.error('错误', error);
 *   const done = log.time('操作名'); ... done(); // 输出耗时
 */

// 日志级别定义
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

// 从环境变量读取日志级别，默认 INFO
const CURRENT_LEVEL: number = (() => {
  const envLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
  return (LOG_LEVELS as any)[envLevel] ?? LOG_LEVELS.INFO;
})();

// 模块名颜色（终端中）
const MODULE_COLORS = [
  '\x1b[36m', // cyan
  '\x1b[35m', // magenta
  '\x1b[33m', // yellow
  '\x1b[34m', // blue
  '\x1b[32m', // green
  '\x1b[95m', // bright magenta
  '\x1b[96m', // bright cyan
];

// 给模块名分配稳定颜色
function moduleColor(module: string): string {
  let hash = 0;
  for (let i = 0; i < module.length; i++) {
    hash = ((hash << 5) - hash) + module.charCodeAt(i);
    hash |= 0;
  }
  return MODULE_COLORS[Math.abs(hash) % MODULE_COLORS.length];
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

/** 获取 ISO 时间戳 */
function timestamp(): string {
  return new Date().toISOString();
}

/** 格式化额外数据 */
function formatExtra(extra?: Record<string, any>): string {
  if (!extra || Object.keys(extra).length === 0) return '';
  try {
    return ' ' + JSON.stringify(extra, null, 0);
  } catch {
    return ' [无法序列化]';
  }
}

export interface Logger {
  debug: (msg: string, extra?: Record<string, any>) => void;
  info: (msg: string, extra?: Record<string, any>) => void;
  warn: (msg: string, extra?: Record<string, any>) => void;
  error: (msg: string, err?: Error | string, extra?: Record<string, any>) => void;
  /** 开始计时，返回 stop 函数。调用 stop() 时输出耗时 */
  time: (label: string) => () => void;
}

export function createLogger(module: string): Logger {
  const color = moduleColor(module);
  const prefix = `${color}[${module}]${RESET}`;

  return {
    debug(msg, extra) {
      if (CURRENT_LEVEL > LOG_LEVELS.DEBUG) return;
      console.debug(`${DIM}${timestamp()}${RESET} ${prefix} 🔍 ${msg}${formatExtra(extra)}`);
    },

    info(msg, extra) {
      if (CURRENT_LEVEL > LOG_LEVELS.INFO) return;
      console.log(`${DIM}${timestamp()}${RESET} ${prefix} ℹ️  ${msg}${formatExtra(extra)}`);
    },

    warn(msg, extra) {
      if (CURRENT_LEVEL > LOG_LEVELS.WARN) return;
      console.warn(`${DIM}${timestamp()}${RESET} ${prefix} ${YELLOW}⚠️  ${msg}${RESET}${formatExtra(extra)}`);
    },

    error(msg, err, extra) {
      if (CURRENT_LEVEL > LOG_LEVELS.ERROR) return;
      const errMsg = err
        ? (typeof err === 'string' ? err : err.message || String(err))
        : '';
      console.error(`${DIM}${timestamp()}${RESET} ${prefix} ${RED}❌ ${msg}${RESET}${errMsg ? ` — ${errMsg}` : ''}${formatExtra(extra)}`);
    },

    time(label) {
      const start = Date.now();
      const labelText = `${prefix} ⏱  ${label}`;
      if (CURRENT_LEVEL <= LOG_LEVELS.DEBUG) {
        console.debug(`${DIM}${timestamp()}${RESET} ${labelText} ...开始`);
      }
      return () => {
        const elapsed = Date.now() - start;
        const elapsedStr = elapsed >= 1000
          ? `${(elapsed / 1000).toFixed(1)}s`
          : `${elapsed}ms`;
        if (CURRENT_LEVEL <= LOG_LEVELS.INFO) {
          console.log(`${DIM}${timestamp()}${RESET} ${labelText} — 耗时 ${elapsedStr}`);
        }
      };
    },
  };
}
