/**
 * 健康探测脚本
 * 用于外部监控系统（如 cron / Windows Task Scheduler）定期检查服务健康状态
 *
 * 用法:
 *   npx tsx scripts/healthProbe.ts
 *   npx tsx scripts/healthProbe.ts --url http://localhost:3000/api/health
 *   npx tsx scripts/healthProbe.ts --alert        # 异常时发送飞书告警
 *
 * 输出 JSON 结果到 stdout，异常时退出码非 0
 */

import https from 'https';
import http from 'http';

// 从命令行参数或环境变量读取配置
const args = process.argv.slice(2);
const BASE_URL = args.find(a => a.startsWith('--url='))?.split('=')[1]
  || process.env.HEALTH_CHECK_URL
  || 'http://localhost:3000/api/health';
const SEND_ALERT = args.includes('--alert') || process.env.HEALTH_ALERT === 'true';
const TIMEOUT_MS = parseInt(process.env.HEALTH_TIMEOUT || '10000', 10);

interface HealthResult {
  url: string;
  status: 'healthy' | 'unhealthy' | 'timeout' | 'error';
  statusCode?: number;
  responseTime: number;  // ms
  body?: any;
  error?: string;
  timestamp: string;
}

function fetchHealth(url: string): Promise<{ statusCode: number; body: any; responseTime: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, { timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseTime = Date.now() - start;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          resolve({ statusCode: res.statusCode || 0, body, responseTime });
        } catch {
          resolve({ statusCode: res.statusCode || 0, body: null, responseTime });
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (${TIMEOUT_MS}ms)`));
    });
    req.on('error', reject);
  });
}

async function probe(): Promise<void> {
  const url = BASE_URL;
  const timestamp = new Date().toISOString();

  let result: HealthResult = {
    url,
    status: 'error',
    responseTime: 0,
    timestamp,
  };

  try {
    const resp = await fetchHealth(url);
    result.responseTime = resp.responseTime;
    result.statusCode = resp.statusCode;
    result.body = resp.body;

    if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.body?.status === 'ok') {
      result.status = 'healthy';
    } else {
      result.status = 'unhealthy';
      result.error = `HTTP ${resp.statusCode}, body.status=${resp.body?.status}`;
    }
  } catch (err: any) {
    if (err.message?.includes('超时')) {
      result.status = 'timeout';
    } else {
      result.status = 'error';
    }
    result.error = err.message || String(err);
  }

  // 输出结果
  console.log(JSON.stringify(result, null, 2));

  // 异常时发送飞书告警
  if (result.status !== 'healthy' && SEND_ALERT) {
    const alertMsg = `🚨 健康检查失败\n服务: ${url}\n状态: ${result.status}\n原因: ${result.error || '未知'}\n时间: ${timestamp}\n响应时间: ${result.responseTime}ms`;
    console.error(alertMsg);

    // 如果配置了飞书 webhook，发送告警
    const webhookUrl = process.env.HEALTH_ALERT_WEBHOOK;
    if (webhookUrl) {
      try {
        const webhookBody = JSON.stringify({
          msg_type: 'text',
          content: { text: alertMsg },
        });
        const parsed = new URL(webhookUrl);
        const hClient = parsed.protocol === 'https:' ? https : http;
        const hReq = hClient.request({
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(webhookBody),
          },
        }, (res) => {
          console.error(`[告警发送] HTTP ${res.statusCode}`);
        });
        hReq.on('error', (e) => console.error(`[告警发送失败] ${e.message}`));
        hReq.write(webhookBody);
        hReq.end();
      } catch (e: any) {
        console.error(`[告警发送异常] ${e.message}`);
      }
    }
  }

  // 退出码
  process.exit(result.status === 'healthy' ? 0 : 1);
}

probe().catch((err) => {
  console.error(`探测脚本异常: ${err.message}`);
  process.exit(2);
});
