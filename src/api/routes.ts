import { Router, Request, Response } from 'express';
import os from 'os';
import { MessageSender } from '../feishu/messageSender';
import { config } from '../config';
import { fetchTrains, upsertTrains } from '../xunji/client';
import { fetchHealthData, generateHealthAnalysis } from '../health/service';
import { getDeepSeekClient } from '../claude/client';
import { calcCalorieSummary } from '../health/calorie';
import { buildDailyReport } from '../health/reportGenerator';
import { runEveningCheckin } from '../health/eveningCheckin';
import { analyzeImageBuffer } from '../health/imageRecognition';
import { listFoods, addFood, deleteFood, lookupPackagedFood } from '../health/foodLibrary';
import { searchConversations } from '../memory/bridge';

// ─── 监控指标收集 ───

/** 请求计数器 */
const metrics = {
  totalRequests: 0,
  activeRequests: 0,
  errors5xx: 0,
  errors4xx: 0,
  lastError: null as { time: number; message: string } | null,
  startTime: Date.now(),
};

/** 请求计数中间件 */
function metricsMiddleware(req: Request, res: Response, next: () => void) {
  metrics.totalRequests++;
  metrics.activeRequests++;
  const start = Date.now();

  // 记录响应
  const origEnd = res.end;
  res.end = function (this: typeof res, ...args: any[]): typeof res {
    metrics.activeRequests--;
    const duration = Date.now() - start;

    // 记录错误
    if (res.statusCode >= 500) {
      metrics.errors5xx++;
      metrics.lastError = { time: Date.now(), message: `${req.method} ${req.path} → ${res.statusCode}` };
    } else if (res.statusCode >= 400) {
      metrics.errors4xx++;
    }

    // 慢请求告警（>3s）
    if (duration > 3000) {
      console.warn(`[性能告警] 慢请求: ${req.method} ${req.path} — ${duration}ms`);
    }

    return (origEnd as Function).apply(this, args) as typeof res;
  } as any;

  next();
}

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024 * 10) / 10,        // MB
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,  // MB
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10, // MB
    external: Math.round(mem.external / 1024 / 1024 * 10) / 10,   // MB
  };
}

export function createRoutes(messageSender: MessageSender): Router {
  const router = Router();

  // 全局请求计数中间件
  router.use(metricsMiddleware);

  // ─── 增强健康检查端点 ───
  router.get('/api/health', (_req: Request, res: Response) => {
    const uptimeSec = process.uptime();
    const uptimeStr = uptimeSec >= 86400
      ? `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h`
      : uptimeSec >= 3600
      ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
      : `${Math.floor(uptimeSec / 60)}m ${Math.floor(uptimeSec % 60)}s`;

    res.json({
      status: 'ok',
      version: '1.0.0',
      uptime: uptimeSec,
      uptimeFormatted: uptimeStr,
      timestamp: Date.now(),
      node: {
        version: process.version,
        pid: process.pid,
        platform: process.platform,
      },
      system: {
        cpuLoad: os.loadavg().map(v => Number(v.toFixed(2))),
        totalMemory: Math.round(os.totalmem() / 1024 / 1024),  // MB
        freeMemory: Math.round(os.freemem() / 1024 / 1024),     // MB
        cpus: os.cpus().length,
      },
      process: {
        memory: getMemoryUsage(),
        uptime: uptimeSec,
      },
      metrics: {
        totalRequests: metrics.totalRequests,
        activeRequests: metrics.activeRequests,
        errors4xx: metrics.errors4xx,
        errors5xx: metrics.errors5xx,
        lastError: metrics.lastError,
        uptimeMinutes: Math.round((Date.now() - metrics.startTime) / 60000 * 10) / 10,
      },
    });
  });

  // ─── 轻量存活检查（用于外部探针，开销最小）───
  router.get('/api/health/liveness', (_req: Request, res: Response) => {
    res.status(200).send('OK');
  });

  // ─── 就绪检查（检查关键依赖是否就绪）───
  router.get('/api/health/readiness', (_req: Request, res: Response) => {
    const checks: { name: string; ok: boolean; detail?: string }[] = [
      { name: 'feishu', ok: !!(config.feishu.appId && config.feishu.appSecret) },
      { name: 'deepseek', ok: !!(config.deepseek.apiKey) },
    ];

    const allOk = checks.every(c => c.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ready' : 'not_ready',
      checks,
    });
  });

  // ─── 飞书对话搜索（供 Claude Code 查询历史对话）───
  router.get('/api/memory/search', (req: Request, res: Response) => {
    try {
      const keyword = req.query.q as string | undefined;
      const days = parseInt((req.query.days as string) || '30', 10);
      const limit = parseInt((req.query.limit as string) || '20', 10);

      if (days > 365) {
        res.status(400).json({ error: 'days 不能超过 365' });
        return;
      }
      if (limit > 100) {
        res.status(400).json({ error: 'limit 不能超过 100' });
        return;
      }

      // 简单的本地鉴权（仅 Claude Code 能调用）
      const token = req.headers.authorization?.replace('Bearer ', '') || '';
      const expected = process.env.MEMORY_SEARCH_TOKEN || process.env.SYNC_TOKEN || 'health-sync-secret';
      if (token && token !== expected) {
        // token 存在但不匹配 → 拒绝
        // token 不存在 → 允许（兼容本地开发）
        if (token) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
      }

      const results = searchConversations({ keyword, days, limit });
      res.json({
        query: { keyword, days, limit },
        total: results.length,
        results,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 推送文本消息到指定聊天
  router.post('/api/push/text', async (req: Request, res: Response) => {
    try {
      const { chatId, text } = req.body;

      if (!chatId || !text) {
        res.status(400).json({ error: '缺少 chatId 或 text 参数' });
        return;
      }

      await messageSender.sendText(chatId, text);
      res.json({ success: true });
    } catch (err: any) {
      console.error('推送消息失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 推送卡片消息到指定聊天
  router.post('/api/push/card', async (req: Request, res: Response) => {
    try {
      const { chatId, title, content } = req.body;

      if (!chatId || !title || !content) {
        res.status(400).json({ error: '缺少 chatId、title 或 content 参数' });
        return;
      }

      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
        },
        elements: [
          {
            tag: 'markdown',
            content,
          },
        ],
      };

      await messageSender.sendCard(chatId, card);
      res.json({ success: true });
    } catch (err: any) {
      console.error('推送卡片失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 获取训记训练数据
  router.get('/api/xunji/trains', async (req: Request, res: Response) => {
    try {
      const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      const forceRefresh = req.query.refresh === '1';

      // 校验日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({ error: '日期格式错误，请使用 YYYY-MM-DD' });
        return;
      }

      const result = await fetchTrains(dateStr, config.xunji, forceRefresh);
      res.json(result);
    } catch (err: any) {
      console.error('获取训记数据失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 列出已缓存的训记日期
  router.get('/api/xunji/cache', (_req: Request, res: Response) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const cacheDir = path.resolve(__dirname, '../../.cache/xunji');
      if (!fs.existsSync(cacheDir)) {
        res.json({ files: [] });
        return;
      }
      const files = fs.readdirSync(cacheDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => f.replace('.json', ''));
      res.json({ files });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ——— 训记数据回写 ———

  // 按训练 ID 做 upsert 写回训记
  router.post('/api/xunji/trains/upsert', async (req: Request, res: Response) => {
    try {
      const { res: trainLines } = req.body;

      if (!trainLines || !Array.isArray(trainLines) || trainLines.length === 0) {
        res.status(400).json({ error: '缺少 res 参数或 res 不是非空数组' });
        return;
      }

      const result = await upsertTrains(trainLines, config.xunji);
      res.json(result);
    } catch (err: any) {
      console.error('训记 upsert 失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ——— 健康数据 API ———

  // 拉取某天的完整健康数据（训练 + 已存储的日报）
  router.get('/api/health/daily', async (req: Request, res: Response) => {
    try {
      const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({ error: '日期格式错误，请使用 YYYY-MM-DD' });
        return;
      }
      const data = await fetchHealthData(dateStr, config);
      const calorieSummary = calcCalorieSummary(data.record);
      // 对 record 中的数值取整，防止历史数据中的浮点数（如 14.299999999999999）污染显示
      const cleanRecord = roundDietResult(data.record);
      res.json({ ...data, record: cleanRecord, calorieSummary });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 保存/更新睡眠 + 饮食数据（训练数据来自训记，只存睡眠和饮食）
  router.post('/api/health/daily', async (req: Request, res: Response) => {
    try {
      const { date, sleep, diet, weight, notes } = req.body;
      const dateStr = date || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({ error: '日期格式错误' });
        return;
      }

      // 获取训练数据并生成日报
      const record = await generateHealthAnalysis(dateStr, config, { sleep, diet, weight, notes });
      const calorieSummary = calcCalorieSummary(record);
      res.json({ ...record, calorieSummary });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 周报
  router.get('/api/health/weekly', async (req: Request, res: Response) => {
    try {
      const { generateWeeklyReport } = require('../health/store');
      const endDate = (req.query.end as string) || new Date().toISOString().slice(0, 10);
      const d = new Date(endDate);
      d.setDate(d.getDate() - 6);
      const startDate = d.toISOString().slice(0, 10);
      const report = generateWeeklyReport(startDate, endDate);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 月报
  router.get('/api/health/monthly', async (req: Request, res: Response) => {
    try {
      const { generateMonthlyReport } = require('../health/store');
      const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) {
        res.status(400).json({ error: '月份格式错误，请使用 YYYY-MM' });
        return;
      }
      const report = generateMonthlyReport(month);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 列出所有健康记录日期
  router.get('/api/health/dates', (_req: Request, res: Response) => {
    try {
      const { listRecordDates } = require('../health/store');
      res.json({ dates: listRecordDates() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── 食物热量库 API ───

  // 列出食物库（支持按分类筛选）
  router.get('/api/health/foods', (_req: Request, res: Response) => {
    try {
      const category = _req.query.category as string | undefined;
      const foods = listFoods(category as string | undefined);
      res.json({ foods, total: foods.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 手动添加/更新食物
  router.post('/api/health/foods', (req: Request, res: Response) => {
    try {
      const { name, category, caloriesPer100g, carbsPer100g, proteinPer100g, fatPer100g, sodiumPer100g, servingSize, servingCalories } = req.body;
      if (!name || !category || caloriesPer100g == null) {
        res.status(400).json({ error: '缺少必填字段: name, category, caloriesPer100g' });
        return;
      }
      const food = addFood({
        name,
        category,
        caloriesPer100g: Number(caloriesPer100g),
        carbsPer100g: Number(carbsPer100g || 0),
        proteinPer100g: Number(proteinPer100g || 0),
        fatPer100g: Number(fatPer100g || 0),
        sodiumPer100g: sodiumPer100g != null ? Number(sodiumPer100g) : undefined,
        servingSize: servingSize != null ? Number(servingSize) : undefined,
        servingCalories: servingCalories != null ? Number(servingCalories) : undefined,
        source: 'manual',
      });
      res.json({ success: true, food });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 按名删除食物
  router.delete('/api/health/foods/:name', (req: Request, res: Response) => {
    try {
      const name = decodeURIComponent(req.params.name as string);
      const deleted = deleteFood(name);
      if (!deleted) {
        res.status(404).json({ error: `未找到食物: ${name}` });
        return;
      }
      res.json({ success: true, name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // AI 查询品牌包装食物营养成分
  router.post('/api/health/foods/lookup', async (req: Request, res: Response) => {
    try {
      const { query } = req.body as { query: string };
      if (!query) {
        res.status(400).json({ error: '请提供品牌+商品名' });
        return;
      }
      const result = await lookupPackagedFood(query);
      if (!result.success) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 查看某天的备份列表
  router.get('/api/health/backups', (req: Request, res: Response) => {
    try {
      const { listBackups } = require('../health/store');
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      res.json({ date, backups: listBackups(date) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 从备份恢复某天数据
  router.post('/api/health/backups/restore', (req: Request, res: Response) => {
    try {
      const { restoreFromBackup } = require('../health/store');
      const { date, backupFile } = req.body;
      if (!date || !backupFile) {
        res.status(400).json({ error: '缺少 date 或 backupFile 参数' });
        return;
      }
      const record = restoreFromBackup(date, backupFile);
      if (!record) {
        res.status(404).json({ error: '备份文件不存在' });
        return;
      }
      res.json({ success: true, date, message: `已从 ${backupFile} 恢复 ${date} 的数据` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取前一日健康日报（JSON + 卡片内容）
  router.get('/api/health/report', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || undefined;
      const report = await buildDailyReport(date);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 推送日报到飞书
  router.post('/api/health/report/push', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || undefined;
      const chatId = req.body.chatId || config.report.targetChatId;

      if (!chatId) {
        res.status(400).json({ error: '缺少 chatId，请在请求体传入或配置 REPORT_CHAT_ID' });
        return;
      }

      const report = await buildDailyReport(date);
      await messageSender.sendCard(chatId, report.card);
      res.json({ success: true, date: report.date, chatId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 晚间数据统计（获取缺失项列表）
  router.get('/api/health/checkin', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || undefined;
      const result = await runEveningCheckin(date);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ——— 健康数据同步（手表/外部数据源）———

  router.post('/api/health/sync', async (req: Request, res: Response) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '') || '';
      const expected = process.env.SYNC_TOKEN || 'health-sync-secret';
      if (token !== expected) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const { date, steps, sleep, weight } = req.body;
      const dateStr = date || new Date().toISOString().slice(0, 10);

      const record = await generateHealthAnalysis(dateStr, config, {
        steps: steps ? parseInt(String(steps), 10) : undefined,
        sleep: sleep as any,
        weight: weight ? parseFloat(String(weight)) : undefined,
      });

      res.json({ success: true, date: dateStr, saved: { steps: record.steps, sleep: !!sleep, weight: record.weight } });
    } catch (err: any) {
      console.error('健康数据同步失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ——— 饮食 AI 分析 ———

  const DIET_ANALYZE_PROMPT = `你是饮食营养分析助手。根据用户描述的食物，返回 JSON 格式的分析结果。

规则：
1. 将食物分配到餐次：breakfast/lunch/dinner/snack
2. 每个食物估算：calories(热量kcal)、carbs(碳水g)、protein(蛋白质g)、fat(脂肪g)、sodium(钠mg)
3. 参考营养数据（优先使用下表中的精确值；表中未列出的食物，基于同类食物合理推断）：

——— 基础食材（每100g或每份）———
| 食物 | 热量 | 碳水 | 蛋白 | 脂肪 | 钠mg |
|------|------|------|------|------|------|
| 米饭(100g) | 116 | 26 | 2.6 | 0.3 | 3 |
| 馒头(个) | 220 | 44 | 7 | 1 | 165 |
| 面条(100g) | 110 | 24 | 4 | 0.5 | 120 |
| 包子(个) | 220 | 28 | 8 | 9 | 200 |
| 油条(根) | 250 | 30 | 5 | 13 | 220 |
| 豆腐脑(碗) | 150 | 4 | 8 | 8 | 200 |
| 鸡蛋(个) | 70 | 0.5 | 6 | 5 | 130 |
| 鸡胸肉(100g) | 133 | 0 | 22 | 5 | 44 |
| 猪肉(100g) | 240 | 0 | 17 | 20 | 57 |
| 牛肉(100g) | 125 | 0 | 22 | 4 | 53 |
| 鱼(100g) | 105 | 0 | 22 | 1.5 | 40 |
| 虾(100g) | 93 | 0 | 20 | 0.5 | 150 |
| 青菜/叶菜(200g) | 50 | 8 | 4 | 0.5 | 140 |
| 西兰花(100g) | 34 | 7 | 3 | 0.5 | 27 |
| 牛奶(250ml) | 135 | 11 | 8 | 5 | 112 |
| 蒸饺(笼) | 350 | 40 | 15 | 12 | 350 |
| 煎饼果子(个) | 350 | 45 | 8 | 16 | 400 |

——— 麦当劳/快餐（官方营养数据，优先使用）———
| 食物 | 热量 | 碳水 | 蛋白 | 脂肪 | 钠mg |
|------|------|------|------|------|------|
| 双层吉士汉堡 | 440 | 34 | 26 | 23 | 1050 |
| 巨无霸 | 550 | 45 | 27 | 30 | 1010 |
| 麦辣鸡腿堡 | 520 | 48 | 24 | 26 | 1200 |
| 麦香鱼 | 390 | 39 | 16 | 19 | 590 |
| 麦香鸡 | 410 | 43 | 16 | 19 | 770 |
| 中薯条 | 340 | 42 | 4 | 17 | 260 |
| 大薯条 | 440 | 56 | 5 | 22 | 340 |
| 小玉米杯 | 70 | 17 | 3 | 0.5 | 0 |
| 薯饼(个) | 150 | 15 | 1 | 9 | 270 |
| 麦乐鸡(5块) | 230 | 13 | 12 | 14 | 500 |
| 麦旋风(杯) | 340 | 47 | 8 | 12 | 160 |
| 圆筒冰淇淋 | 150 | 22 | 4 | 5 | 80 |
| 可口可乐(中杯) | 150 | 39 | 0 | 0 | 10 |

——— 中餐家常菜/外卖（每份约300-600g，含油盐调味）———
| 食物 | 热量 | 碳水 | 蛋白 | 脂肪 | 钠mg |
|------|------|------|------|------|------|
| 宫保鸡丁 | 550 | 25 | 35 | 30 | 800 |
| 鱼香肉丝 | 500 | 30 | 25 | 28 | 900 |
| 溜肉段 | 600 | 40 | 30 | 35 | 1000 |
| 回锅肉 | 650 | 15 | 30 | 50 | 1100 |
| 西红柿炒鸡蛋 | 280 | 15 | 14 | 16 | 400 |
| 麻婆豆腐 | 350 | 12 | 18 | 22 | 900 |
| 地三鲜 | 420 | 35 | 6 | 28 | 700 |
| 干煸四季豆 | 350 | 18 | 8 | 25 | 600 |
| 尖椒炒鸡蛋 | 250 | 10 | 14 | 16 | 400 |
| 酸辣土豆丝 | 220 | 30 | 3 | 10 | 500 |
| 蛋炒饭 | 500 | 65 | 15 | 18 | 600 |
| 炒刀削面 | 550 | 70 | 18 | 20 | 700 |
| 麻辣香锅(含肉) | 700 | 20 | 40 | 45 | 1500 |
| 麻辣香锅(素) | 400 | 30 | 12 | 25 | 1000 |
| 黄焖鸡 | 500 | 20 | 40 | 28 | 900 |
| 木须肉 | 400 | 18 | 25 | 22 | 700 |
| 烧茄子 | 380 | 28 | 5 | 28 | 600 |
| 炒饼/焖饼 | 500 | 60 | 15 | 20 | 650 |

——— 钠估算指南（重要）———
- 用户口味偏淡，不喜欢重调料。默认按家常/低盐标准估算钠含量
- 对于描述中含「不辣」「少盐」「清淡」「清炒」「白灼」「蒸」等关键词的菜品，钠取同类下限或下调20-30%
- 当用户明确标注「咸」「偏咸」「重口」「酱香」「红烧」「卤」「腊」「腌」等关键词时，钠适当上调30-50%
- 家常自制菜：钠通常 200-600mg/份（约0.5-1.5g盐）
- 普通外卖/餐厅：钠通常 500-1200mg/份（约1.25-3g盐）
- 火锅/麻辣香锅/卤味等重口味：钠可能 1200-2000mg/份
- 纯肉类原料（牛肉/鸡肉/鱼等未腌制）：钠按原料值，不要擅自加高
- 汤品类：清汤 100-300mg，浓汤/料包汤 400-800mg
- 腌制/加工食品（培根/火腿/酸黄瓜/腊肉等）：钠按 800-1500mg/100g

4. 计算全天总量：totalCalories、totalCarbs、totalProtein、totalFat、totalSodium
5. 返回 JSON：
{"meals":[{"time":"breakfast","items":[{"name":"食物名","amount":"份量","calories":数字,"carbs":数字,"protein":数字,"fat":数字,"sodium":数字}]}],"totalCalories":数字,"totalCarbs":数字,"totalProtein":数字,"totalFat":数字,"totalSodium":数字}
6. 如果用户描述不包含食物信息，返回：{"error":"未识别到食物"}`;

  router.post('/api/health/diet/analyze', async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string') {
        res.status(400).json({ error: '缺少 text 参数' });
        return;
      }

      const client = getDeepSeekClient();
      const response = await client.chat.completions.create({
        model: config.deepseek.healthModel,
        messages: [{ role: 'user', content: `${DIET_ANALYZE_PROMPT}\n\n用户描述：${text}` }],
        max_tokens: 2000,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        res.json({ meals: [], totalCalories: 0, raw: content });
        return;
      }

      const result = JSON.parse(jsonMatch[0]);
      if (result.error) {
        res.json({ meals: [], totalCalories: 0, error: result.error });
        return;
      }
      // 对所有数值四舍五入到小数点后1位，消除浮点数 3.9999999
      res.json(roundDietResult(result));
    } catch (err: any) {
      console.error('饮食分析失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ——— 图片健康数据分析 ———

  router.post('/api/health/image/analyze', async (req: Request, res: Response) => {
    try {
      const { image } = req.body; // base64 data URL 或纯 base64
      if (!image) { res.status(400).json({ error: '缺少 image 参数' }); return; }

      const base64 = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 10 * 1024 * 1024) { res.status(400).json({ error: '图片大小不能超过 10MB' }); return; }

      const result = await analyzeImageBuffer(buffer);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ——— 历史趋势（分析页用）———

  router.get('/api/health/trends', async (req: Request, res: Response) => {
    try {
      const days = parseInt((req.query.days as string) || '14', 10);
      const endDate = (req.query.end as string) || new Date().toISOString().slice(0, 10);
      const d = new Date(endDate);
      d.setDate(d.getDate() - days + 1);
      const startDate = d.toISOString().slice(0, 10);

      const { getDailyRecords } = require('../health/store');
      const records: any[] = getDailyRecords(startDate, endDate);

      const trends = records.map((r: any) => {
        try {
          if (!r || typeof r !== 'object') return null;
          const cal = calcCalorieSummary(r);
          const weight = r.weight || 118;
          // 根据生日 1994-12-15 计算实足年龄
          const birth = new Date('1994-12-15');
          const rd = new Date(r.date);
          let age = rd.getFullYear() - birth.getFullYear();
          const m = rd.getMonth() - birth.getMonth();
          if (m < 0 || (m === 0 && rd.getDate() < birth.getDate())) age--;
          const bmr = Math.round(10 * weight + 6.25 * 181 - 5 * age + 5);
          const steps = r.steps || 0;
          const rawStepCal = steps > 0 ? Math.round(steps * 0.04 * (weight / 70)) : 0;
          const WALKING = ['徒步', '户外步行', '快走', '室内步行'];
          const walkCardio = (r.cardio && WALKING.indexOf(r.cardio.bodyPart) >= 0) ? r.cardio.calories : 0;
          const stepCal = walkCardio > 0 ? Math.max(rawStepCal, walkCardio) : rawStepCal;
          const trainCal = (r.training?.calories || 0) + (r.cardio?.calories || 0);
          // TDEE = 久坐基线(BMR×1.2) + 步数 + 训练，避免PAL乘数叠加高估
          const tdee = Math.round(bmr * 1.2 + stepCal + trainCal);
          const deficit = cal.consumed > 0 ? Number((tdee - cal.consumed).toFixed(1)) : null;

          const bedtimeRaw = r.sleep?.bedTime;
          const bedtimeHour = bedtimeRaw
            ? parseFloat(bedtimeRaw.split(':')[0]) + parseFloat(bedtimeRaw.split(':')[1]) / 60
            : null;
          return {
            date: r.date,
            consumed: cal.consumed,
            target: cal.target,
            tdee,
            trainCal,
            deficit,
            carbs: cal.carbs || 0,
            protein: cal.protein || 0,
            fat: cal.fat || 0,
            steps: r.steps || 0,
            sleepDuration: r.sleep?.duration || 0,
            deepSleep: r.sleep?.deepSleep || 0,
            lightSleep: r.sleep?.lightSleep || r.sleep?.coreSleep || 0,
            remSleep: r.sleep?.remSleep || 0,
            awakeTime: r.sleep?.awakeTime || 0,
            awakeCount: r.sleep?.awakeCount ?? null,
            sleepScore: r.sleep?.sleepScore ?? null,
            bedtimeHour,
            bedTime: bedtimeRaw || null,
            weight: r.weight || null,
            sodium: cal.sodium || 0,
            sodiumTarget: cal.sodiumTarget || 2000,
            fastingDay: !!(r as any).fastingDay || false,
          };
        } catch (recordErr: any) {
          console.warn(`[趋势] 跳过异常记录 ${r?.date || '?'}: ${recordErr.message}`);
          return null;
        }
      }).filter(Boolean);

      // ── 反推校准 TDEE：用体重变化 + 摄入反算真实总消耗 ──
      // 7天滚动窗口：实际TDEE = 窗口日均摄入 + (窗口初体重 - 窗口末体重) × 7700 / 窗口天数
      const WINDOW = 7;
      for (let i = 0; i < trends.length; i++) {
        const t = trends[i] as any;
        // 找包含当前日在内的前 WINDOW 天
        const windowEnd = i;
        const windowStart = Math.max(0, i - WINDOW + 1);
        const windowItems = trends.slice(windowStart, windowEnd + 1).filter(
          (x: any) => x && x.weight > 0 && x.consumed > 0
        );
        if (windowItems.length >= 3) {
          const first: any = windowItems[0];
          const last: any = windowItems[windowItems.length - 1];
          if (first && last && first.weight > 0 && last.weight > 0) {
            const firstW = first.weight;
            const lastW = last.weight;
            const actualDays = windowItems.length;
            const avgIntake = windowItems.reduce((s: number, x: any) => s + x.consumed, 0) / actualDays;
            // 体重下降 = 正缺口；体重上升 = 负缺口
            const weightDelta = firstW - lastW;
            const impliedDeficit = (weightDelta * 7700) / actualDays;
            const calibratedTdee = Math.round(avgIntake + impliedDeficit);
            t.tdeeCalibrated = calibratedTdee;
            // NEAT = 校准TDEE - BMR - 步数消耗 - 训练消耗
            const bmrEst = Math.round(10 * (t.weight || 118) + 6.25 * 181 - 5 * 31 + 5);
            const stepEst = Math.round((t.steps || 0) * 0.04 * ((t.weight || 118) / 70));
            const trainEst = t.trainCal || 0;
            t.neat = Math.round(calibratedTdee - bmrEst - stepEst - trainEst);
            t.calibrationDays = actualDays;
          } else {
            t.tdeeCalibrated = null;
            t.neat = null;
            t.calibrationDays = 0;
          }
        } else {
          t.tdeeCalibrated = null;
          t.neat = null;
          t.calibrationDays = 0;
        }
      }

      res.json({ startDate, endDate, trends });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 推送晚间数据统计到飞书
  router.post('/api/health/checkin/push', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || undefined;
      const chatId = req.body.chatId || config.eveningCheckin.chatId;

      if (!chatId) {
        res.status(400).json({ error: '缺少 chatId' });
        return;
      }

      const result = await runEveningCheckin(date);
      await messageSender.sendCard(chatId, result.card);
      res.json({ success: true, date: result.date, missingCount: result.missing.length, chatId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5+2轻断食：一键切换当天断食状态
  router.post('/api/health/fasting/toggle', (req: Request, res: Response) => {
    try {
      const dateStr = req.body.date || new Date().toISOString().slice(0, 10);
      const { getDailyRecord, saveDailyRecord } = require('../health/store');
      let record = getDailyRecord(dateStr);
      if (!record) {
        record = {
          date: dateStr,
          sleep: { duration: 0, quality: 'fair' as const, bedTime: '', wakeTime: '' },
          training: null,
          diet: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      const wasFasting = !!(record as any).fastingDay;
      (record as any).fastingDay = !wasFasting;
      saveDailyRecord(record);
      res.json({ success: true, date: dateStr, fastingDay: !wasFasting, message: !wasFasting ? '已设为断食日（目标600kcal）' : '已恢复为正常日（目标2000kcal）' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ——— 求职/简历 API ———

  // 查看已生成的 HTML 网页简历
  router.get('/api/career/resume/view/:file', (req: Request, res: Response) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const tmpDir = path.resolve(__dirname, '../../.data/tmp');
      const filePath = path.join(tmpDir, req.params.file as string);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: '文件不存在或已过期' });
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.sendFile(filePath);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/** 递归取整饮食分析结果中的所有数值到小数点后1位 */
function roundDietResult(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number') {
    if (Number.isInteger(obj)) return obj;
    return Number(obj.toFixed(1));
  }
  if (Array.isArray(obj)) return obj.map(roundDietResult);
  if (typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = roundDietResult(v);
    }
    return out;
  }
  return obj;
}
