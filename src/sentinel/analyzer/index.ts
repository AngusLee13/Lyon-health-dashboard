/**
 * 天津城投舆情监测 — 分析管道
 *
 * 管道流程：
 *   原始采集条目 → 去重 → AI 情感分析 → 硬性规则覆写 → 热度计算 → 入库
 */

import { RawArticle, AnalyzedArticle } from '../types';
import { analyzeBatch, keywordBasedSentiment } from './sentiment';
import { applyHardRules, calculateHeatScore } from './riskLevel';
import { saveArticles, getArticlesByDate } from '../store';
import { createLogger } from '../../utils/logger';

const log = createLogger('分析管道');

/** 去重：基于 URL 哈希排除已存在的文章 */
function deduplicate(articles: RawArticle[], existingIds: Set<string>): RawArticle[] {
  return articles.filter(a => !existingIds.has(a.id));
}

/** 检查 URL 是否已被今日文章覆盖（额外去重） */
function filterByUrl(articles: RawArticle[], existingUrls: Set<string>): RawArticle[] {
  return articles.filter(a => !existingUrls.has(a.url));
}

/** 主分析管道 */
export async function runAnalysisPipeline(
  rawArticles: RawArticle[],
  options?: {
    aiAvailable?: boolean;
    recentNegativeCount48h?: number;
  },
): Promise<{ analyzed: AnalyzedArticle[]; errors: string[] }> {
  const errors: string[] = [];

  if (rawArticles.length === 0) {
    log.info('无待分析文章');
    return { analyzed: [], errors: [] };
  }

  // 1. 去重：排除已入库的文章
  const today = new Date().toISOString().substring(0, 10);
  const existingArticles = getArticlesByDate(today);
  const existingUrls = new Set(existingArticles.map(a => a.url));
  const freshArticles = filterByUrl(rawArticles, existingUrls);

  if (freshArticles.length === 0) {
    log.info(`全部 ${rawArticles.length} 篇文章已存在，跳过分析`);
    return { analyzed: [], errors: [] };
  }

  log.info(`分析管道启动: 原始 ${rawArticles.length} 篇 → 去重后 ${freshArticles.length} 篇`);

  // 2. AI 情感分析（或降级方案）
  let analysisResults: Map<string, any>;
  const aiAvailable = options?.aiAvailable !== false;

  if (aiAvailable) {
    try {
      analysisResults = await analyzeBatch(freshArticles);
    } catch (err: any) {
      log.error(`AI 分析批量失败: ${err.message}，降级到关键词规则`);
      // 降级：使用关键词规则
      analysisResults = new Map();
      for (const article of freshArticles) {
        analysisResults.set(article.id, keywordBasedSentiment(article.title, article.snippet));
      }
    }
  } else {
    log.info('AI 不可用，使用关键词规则引擎');
    analysisResults = new Map();
    for (const article of freshArticles) {
      analysisResults.set(article.id, keywordBasedSentiment(article.title, article.snippet));
    }
  }

  // 3. 组装 AnalyzedArticle
  const analyzed: AnalyzedArticle[] = [];
  const now = Date.now();

  for (const raw of freshArticles) {
    const aiResult = analysisResults.get(raw.id);
    if (!aiResult) continue;

    const article: AnalyzedArticle = {
      id: raw.id,
      title: raw.title,
      url: raw.url,
      source: raw.source,
      sourceType: raw.sourceType,
      content: raw.content || raw.snippet,
      publishDate: raw.publishDate || new Date().toISOString().substring(0, 10),
      collectedAt: raw.collectedAt,
      analyzedAt: now,

      sentiment: aiResult.sentiment,
      riskLevel: aiResult.riskLevel,
      riskCategory: aiResult.riskCategory,
      confidence: aiResult.confidence,
      entities: aiResult.entities || { persons: [], companies: [], projects: [], amounts: [], dates: [] },
      summary: aiResult.summary || raw.title.substring(0, 30),
      keywords: aiResult.keywords || [],
      reasoning: aiResult.reasoning || '',

      alertSent: false,
      heatScore: calculateHeatScore({ sourceType: raw.sourceType, source: raw.source, keywords: aiResult.keywords || [] }),
    };

    // 4. 硬性规则覆写
    applyHardRules(article, {
      recentNegativeCount24h: options?.recentNegativeCount48h,
      clusterCount48h: options?.recentNegativeCount48h,
    });

    analyzed.push(article);
  }

  // 5. 入库
  if (analyzed.length > 0) {
    saveArticles(today, analyzed);
    log.info(`${analyzed.length} 篇分析结果已入库`);
  }

  return { analyzed, errors };
}
