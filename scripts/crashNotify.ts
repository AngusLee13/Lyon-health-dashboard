/**
 * PM2 崩溃通知脚本
 * 当 Bot 进程崩溃/重启时，通过飞书发送告警通知
 *
 * 用法（PM2 ecosystem.config.js 或命令行）:
 *   pm2 start ecosystem.config.js --on-crash "npx tsx scripts/crashNotify.ts"
 *
 * 此脚本由 PM2 的崩溃钩子自动调用，也可以通过 process.on('uncaughtException') 触发
 */

import https from 'https';
import http from 'http';

async function sendAlert(message: string): Promise<void> {
  // 优先使用环境变量中的 webhook URL
  const webhookUrl = process.env.CRASH_ALERT_WEBHOOK || process.env.HEALTH_ALERT_WEBHOOK;
  if (!webhookUrl) {
    console.warn('[崩溃通知] 未配置 CRASH_ALERT_WEBHOOK 环境变量，跳过通知');
    return;
  }

  const body = JSON.stringify({
    msg_type: 'text',
    content: {
      text: `🤖 飞书 Bot 异常通知\n\n${message}\n\n时间: ${new Date().toISOString()}\n进程 PID: ${process.pid}\n节点版本: ${process.version}`,
    },
  });

  return new Promise((resolve) => {
    try {
      const parsed = new URL(webhookUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, (res) => {
        console.log(`[崩溃通知] HTTP ${res.statusCode}`);
        resolve();
      });
      req.on('error', (e) => {
        console.error(`[崩溃通知失败] ${e.message}`);
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        console.error('[崩溃通知超时]');
        resolve();
      });
      req.write(body);
      req.end();
    } catch (e: any) {
      console.error(`[崩溃通知异常] ${e.message}`);
      resolve();
    }
  });
}

// 如果是直接执行（非 import）
const isMainModule = process.argv[1]?.includes('crashNotify');
if (isMainModule) {
  const reason = process.argv[2] || 'PM2 进程崩溃自动重启';
  sendAlert(`🔴 进程崩溃重启\n原因: ${reason}\n重启次数: 见 PM2 日志`).then(() => process.exit(0));
}

// 导出以便在其他模块中调用
export { sendAlert };
