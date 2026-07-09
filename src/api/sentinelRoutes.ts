/**
 * 天津城投舆情监测 — API 路由
 *
 * 提供舆情文章查询、预警管理、报告获取、统计数据和手动触发采集等接口。
 * 所有路由以 /api/sentinel 为前缀，注册到主 Router。
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../utils/logger';
import { queryArticles, getArticlesByDate, getAlertsByMonth, acknowledgeAlert, getDailyReport, getWeeklyReport, getMeta } from '../sentinel/store';
import { collectFromSearch } from '../sentinel/collector/webSearch';
import { runAnalysisPipeline } from '../sentinel/analyzer';
import { ArticleQuery, PaginatedResult, SentinelStats, SentinelStatus, RawArticle } from '../sentinel/types';

const log = createLogger('哨兵路由');

export function createSentinelRoutes(): Router {
  const router = Router();

  // ========== 系统状态 ==========

  router.get('/api/sentinel/status', async (_req: Request, res: Response) => {
    try {
      const meta = getMeta();
      const today = new Date().toISOString().substring(0, 10);
      const todayArticles = getArticlesByDate(today);
      const month = today.substring(0, 7);
      const alerts = getAlertsByMonth(month);

      const status: SentinelStatus = {
        lastCollectionTime: meta.lastCollectionTime,
        lastAnalysisTime: meta.lastAnalysisTime,
        todayCollected: todayArticles.length,
        todayAnalyzed: todayArticles.filter(a => a.analyzedAt > 0).length,
        pendingAlerts: alerts.length,
        unacknowledgedAlerts: alerts.filter(a => !a.acknowledged).length,
        aiAvailable: true, // 由调用方按需探测
        activeSources: [
          { name: '搜索引擎', healthy: true, lastFetch: meta.lastCollectionTime },
        ],
      };

      res.json(status);
    } catch (err: any) {
      log.error('获取状态失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 文章列表（带过滤 + 分页） ==========

  router.get('/api/sentinel/articles', async (req: Request, res: Response) => {
    try {
      const {
        sentiment, riskLevel, keyword,
        dateFrom, dateTo,
        page: pageStr, pageSize: pageSizeStr,
      } = req.query;

      const query: ArticleQuery = {
        sentiment: sentiment as any,
        riskLevel: riskLevel as any,
        keyword: keyword as string,
        dateFrom: (dateFrom as string) || new Date(Date.now() - 7 * 86400000).toISOString().substring(0, 10),
        dateTo: (dateTo as string) || new Date().toISOString().substring(0, 10),
        page: Math.max(1, parseInt(pageStr as string || '1', 10)),
        pageSize: Math.min(100, Math.max(1, parseInt(pageSizeStr as string || '20', 10))),
      };

      // 查询
      let all = queryArticles(query.dateFrom!, query.dateTo!);

      // 过滤
      if (query.sentiment) {
        all = all.filter(a => a.sentiment === query.sentiment);
      }
      if (query.riskLevel) {
        all = all.filter(a => a.riskLevel === query.riskLevel);
      }
      if (query.keyword) {
        const kw = query.keyword.toLowerCase();
        all = all.filter(a =>
          a.title.toLowerCase().includes(kw) ||
          a.summary.toLowerCase().includes(kw) ||
          a.keywords.some(k => k.toLowerCase().includes(kw))
        );
      }

      // 分页
      const total = all.length;
      const totalPages = Math.ceil(total / query.pageSize);
      const start = (query.page - 1) * query.pageSize;
      const items = all.slice(start, start + query.pageSize);

      const result: PaginatedResult<typeof items[0]> = {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages,
      };

      res.json(result);
    } catch (err: any) {
      log.error('查询文章失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 单篇文章详情 ==========

  router.get('/api/sentinel/articles/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const today = new Date().toISOString().substring(0, 10);
      const articles = getArticlesByDate(today);
      const article = articles.find(a => a.id === id);

      if (!article) {
        // 也尝试昨天
        const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);
        const yesterdayArticles = getArticlesByDate(yesterday);
        const yesterdayArticle = yesterdayArticles.find(a => a.id === id);
        if (!yesterdayArticle) {
          res.status(404).json({ error: '文章不存在' });
          return;
        }
        res.json(yesterdayArticle);
        return;
      }

      res.json(article);
    } catch (err: any) {
      log.error('获取文章详情失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 预警列表 ==========

  router.get('/api/sentinel/alerts', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().substring(0, 7);
      const month = date.substring(0, 7);
      const all = getAlertsByMonth(month);

      const acknowledged = req.query.acknowledged as string;
      let filtered = all;
      if (acknowledged === 'true') filtered = all.filter(a => a.acknowledged);
      else if (acknowledged === 'false') filtered = all.filter(a => !a.acknowledged);

      const page = Math.max(1, parseInt(req.query.page as string || '1', 10));
      const pageSize = Math.min(100, parseInt(req.query.pageSize as string || '20', 10));
      const total = filtered.length;
      const start = (page - 1) * pageSize;

      res.json({
        items: filtered.slice(start, start + pageSize),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    } catch (err: any) {
      log.error('获取预警列表失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 确认预警 ==========

  router.post('/api/sentinel/alerts/:id/ack', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const ok = acknowledgeAlert(id, 'api-user');
      if (!ok) {
        res.status(404).json({ error: '预警记录不存在或已确认' });
        return;
      }
      res.json({ success: true });
    } catch (err: any) {
      log.error('确认预警失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 统计数据 ==========

  router.get('/api/sentinel/stats', async (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days as string || '7', 10)));
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - days * 86400000);

      const dateFrom = fromDate.toISOString().substring(0, 10);
      const dateTo = toDate.toISOString().substring(0, 10);

      const articles = queryArticles(dateFrom, dateTo);

      const stats: SentinelStats = {
        period: { from: dateFrom, to: dateTo },
        totalArticles: articles.length,
        sentimentBreakdown: {
          positive: articles.filter(a => a.sentiment === 'positive').length,
          negative: articles.filter(a => a.sentiment === 'negative').length,
          neutral: articles.filter(a => a.sentiment === 'neutral').length,
        },
        riskBreakdown: {
          I: articles.filter(a => a.riskLevel === 'I').length,
          II: articles.filter(a => a.riskLevel === 'II').length,
          III: articles.filter(a => a.riskLevel === 'III').length,
          IV: articles.filter(a => a.riskLevel === 'IV').length,
          none: articles.filter(a => a.riskLevel === 'none').length,
        },
        topKeywords: getTopKeywords(articles, 15),
        dailyTrend: getDailyTrend(articles, fromDate, toDate),
        heatMap: getHeatMap(articles),
        lastCollectionTime: getMeta().lastCollectionTime,
        pendingAlerts: getAlertsByMonth(toDate.toISOString().substring(0, 7))
          .filter(a => !a.acknowledged).length,
      };

      res.json(stats);
    } catch (err: any) {
      log.error('获取统计数据失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 趋势数据 ==========

  router.get('/api/sentinel/trends', async (req: Request, res: Response) => {
    try {
      const days = Math.min(60, Math.max(1, parseInt(req.query.days as string || '30', 10)));
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - days * 86400000);

      const articles = queryArticles(
        fromDate.toISOString().substring(0, 10),
        toDate.toISOString().substring(0, 10),
      );

      const trend = getDailyTrend(articles, fromDate, toDate);
      res.json(trend);
    } catch (err: any) {
      log.error('获取趋势失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 手动触发采集 ==========

  router.post('/api/sentinel/collect/trigger', async (_req: Request, res: Response) => {
    // 立即返回 202，在后台异步执行采集 + 分析
    res.status(202).json({
      success: true,
      message: '采集任务已提交，后台执行中...',
    });

    // 后台异步采集 + 分析
    try {
      log.info('手动触发全量采集（异步）...');
      const { result, articles } = await collectFromSearch();
      log.info(`采集完成: 获取 ${result.totalFetched} 条，新增 ${result.newItems} 条`);

      if (articles.length > 0) {
        const { analyzed, errors } = await runAnalysisPipeline(articles);
        log.info(`分析完成: ${analyzed.length} 篇入库`);
        if (errors.length > 0) {
          log.warn(`分析错误: ${errors.join('; ')}`);
        }
      }
    } catch (err: any) {
      log.error('后台采集失败', err);
    }
  });

  // ========== 种子数据注入（用于演示和手动添加） ==========

  router.post('/api/sentinel/articles/seed', async (req: Request, res: Response) => {
    try {
      const { articles } = req.body as { articles: RawArticle[] };
      if (!articles || !Array.isArray(articles) || articles.length === 0) {
        res.status(400).json({ error: '请提供 articles 数组' });
        return;
      }

      log.info(`种子数据注入: ${articles.length} 篇待分析`);

      // 运行分析管道
      const { analyzed, errors } = await runAnalysisPipeline(articles);

      res.json({
        success: true,
        message: `分析完成: ${analyzed.length} 篇入库，${errors.length} 个错误`,
        analyzed: analyzed.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err: any) {
      log.error('种子注入失败', err);
      res.status(500).json({ error: err.message, success: false });
    }
  });

  // ========== 手动推送日报 ==========

  router.post('/api/sentinel/report/daily/push', async (req: Request, res: Response) => {
    try {
      const { buildDailySentinelReport } = await import('../sentinel/reportBuilder');
      const { MessageSender } = await import('../feishu/messageSender');

      const report = await buildDailySentinelReport();

      // 使用舆情 Bot 凭据
      const chatId = (req.body?.chatId as string) || process.env.SENTINEL_REPORT_CHAT_ID || process.env.REPORT_CHAT_ID;
      if (!chatId) {
        res.status(400).json({ error: '未配置推送目标 chatId（请在请求体提供或设置环境变量 SENTINEL_REPORT_CHAT_ID）' });
        return;
      }

      // 使用舆情 Bot 自身凭据发送
      const sender = new MessageSender('cli_aaa01523e5389cef', 'fHUF1gLEgo7M7ASCa0syij7CWSedm4U7');
      await sender.sendCard(chatId, report.card);

      log.info(`日报已手动推送至 ${chatId}`);
      res.json({
        success: true,
        message: `日报已推送至 ${chatId}`,
        summary: {
          total: report.summary.summary.totalArticles,
          positive: report.summary.summary.positiveCount,
          negative: report.summary.summary.negativeCount,
          highRisk: report.summary.highRiskArticles.length,
        },
      });
    } catch (err: any) {
      log.error('手动推送日报失败', err);
      res.status(500).json({ error: err.message, success: false });
    }
  });

  // ========== 日报 ==========

  router.get('/api/sentinel/report/daily', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
      const report = getDailyReport(date);

      if (!report) {
        res.status(404).json({ error: `日报 ${date} 不存在` });
        return;
      }
      res.json(report);
    } catch (err: any) {
      log.error('获取日报失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========== 周报 ==========

  router.get('/api/sentinel/report/weekly', async (req: Request, res: Response) => {
    try {
      // 计算本周 ISO 周起始日
      const now = new Date();
      const dayOfWeek = now.getDay();
      const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diffToMonday);
      const weekStart = monday.toISOString().substring(0, 10);

      const report = getWeeklyReport(req.query.weekStart as string || weekStart);
      if (!report) {
        res.status(404).json({ error: `周报 ${weekStart} 不存在` });
        return;
      }
      res.json(report);
    } catch (err: any) {
      log.error('获取周报失败', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ========== 辅助函数 ==========

function getTopKeywords(articles: { keywords: string[] }[], limit: number): { word: string; count: number }[] {
  const freq = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords || []) {
      freq.set(kw, (freq.get(kw) || 0) + 1);
    }
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

function getDailyTrend(
  articles: { publishDate: string; sentiment: string }[],
  fromDate: Date,
  toDate: Date,
): { date: string; total: number; negative: number; positive: number }[] {
  const map = new Map<string, { total: number; negative: number; positive: number }>();

  // 初始化日期范围
  for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().substring(0, 10);
    map.set(ds, { total: 0, negative: 0, positive: 0 });
  }

  for (const a of articles) {
    const ds = a.publishDate?.substring(0, 10);
    if (!ds) continue;
    const entry = map.get(ds);
    if (!entry) continue;
    entry.total++;
    if (a.sentiment === 'negative') entry.negative++;
    if (a.sentiment === 'positive') entry.positive++;
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

function getHeatMap(articles: { collectedAt: number }[]): { hour: string; count: number }[] {
  const hours = new Map<string, number>();
  for (let h = 0; h < 24; h++) {
    hours.set(String(h).padStart(2, '0'), 0);
  }
  for (const a of articles) {
    const h = new Date(a.collectedAt).getHours();
    const key = String(h).padStart(2, '0');
    hours.set(key, (hours.get(key) || 0) + 1);
  }
  return Array.from(hours.entries())
    .map(([hour, count]) => ({ hour, count }));
}
