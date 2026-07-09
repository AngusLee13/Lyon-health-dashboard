/**
 * 天津城投舆情监测 — 风险评估引擎
 *
 * 双轨制风险分级：
 *   1. AI 判断（情感分析器中已给出初步风险等级）
 *   2. 硬性规则覆写（关键词命中、来源权威度、聚类效应等）
 *
 * 规则优先级：硬性规则 > AI 判断，升级方向：只能升级不能降级
 */

import { AnalyzedArticle, RiskLevel } from '../types';
import { highRiskKeywords, authoritativeSources } from '../config';
import { createLogger } from '../../utils/logger';

const log = createLogger('风险评估');

/** 风险等级数值映射（用于比较） */
const RISK_ORDER: Record<RiskLevel, number> = {
  'I': 4,
  'II': 3,
  'III': 2,
  'IV': 1,
  'none': 0,
};

/** 比较两个风险等级，返回较高的 */
export function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** 检查文本中是否包含高危关键词 */
function containsHighRiskKeyword(text: string): { matched: boolean; keyword: string } {
  for (const keyword of highRiskKeywords) {
    if (text.includes(keyword)) {
      return { matched: true, keyword };
    }
  }
  return { matched: false, keyword: '' };
}

/** 检查来源是否为权威机构 */
function isAuthoritativeSource(source: string): boolean {
  return authoritativeSources.some(s => source.includes(s));
}

/** 应用硬性规则覆写 */
export function applyHardRules(
  article: AnalyzedArticle,
  context?: { recentNegativeCount24h?: number; clusterCount48h?: number },
): AnalyzedArticle {
  let originalLevel = article.riskLevel;
  let newLevel = article.riskLevel;
  let reason = '';

  // 规则 1：高危关键词触发 → 至少 II 级
  const keywordCheck = containsHighRiskKeyword(
    `${article.title} ${article.content}`
  );
  if (keywordCheck.matched) {
    newLevel = higherRisk(newLevel, 'II');
    reason = `命中文中含高危关键词"${keywordCheck.keyword}"，自动升至 ${newLevel} 级`;
    log.info(`规则触发 [高危关键词]: ${article.id} "${keywordCheck.keyword}" → ${newLevel}`);
  }

  // 规则 2：权威来源 → 至少 II 级
  if (isAuthoritativeSource(article.source)) {
    newLevel = higherRisk(newLevel, 'II');
    reason = `${reason ? reason + '；' : ''}来源为权威机构"${article.source}"，自动升至 ${newLevel} 级`;
    log.info(`规则触发 [权威来源]: ${article.id} ${article.source} → ${newLevel}`);
  }

  // 规则 3：大 V 来源 → III 级起步（微博大 V 权重）
  if (
    article.sourceType === 'social_media' &&
    article.source.includes('微博') &&
    article.heatScore > 50
  ) {
    newLevel = higherRisk(newLevel, 'III');
    reason = `${reason ? reason + '；' : ''}高热度社交媒体来源，自动升至 ${newLevel} 级`;
    log.info(`规则触发 [社交高热]: ${article.id} heat=${article.heatScore} → ${newLevel}`);
  }

  // 规则 4：48h 内同类负面聚集 → 自动升一档
  if (
    context?.clusterCount48h &&
    context.clusterCount48h >= 5 &&
    article.sentiment === 'negative'
  ) {
    const levels: RiskLevel[] = ['none', 'I', 'II', 'III', 'IV'];
    const currentIdx = levels.indexOf(newLevel);
    if (currentIdx < levels.length - 1) {
      newLevel = levels[currentIdx + 1];
      reason = `${reason ? reason + '；' : ''}48h内同类负面达 ${context.clusterCount48h} 条，自动升至 ${newLevel} 级`;
      log.info(`规则触发 [负面聚集]: ${article.id} cluster=${context.clusterCount48h} → ${newLevel}`);
    }
  }

  // 5. 热度超高 → 升一档
  if (article.heatScore >= 80 && article.sentiment === 'negative') {
    const levels: RiskLevel[] = ['none', 'I', 'II', 'III', 'IV'];
    const currentIdx = levels.indexOf(newLevel);
    if (currentIdx < levels.length - 1) {
      newLevel = levels[currentIdx + 1];
      reason = `${reason ? reason + '；' : ''}热度极高 (${article.heatScore})，自动升至 ${newLevel} 级`;
    }
  }

  // 如果规则生效，写入覆写标记
  if (newLevel !== originalLevel) {
    article.riskOverride = {
      originalLevel,
      newLevel,
      reason,
    };
    article.riskLevel = newLevel;
  }

  return article;
}

/** 计算热度分数（0-100） */
export function calculateHeatScore(
  article: { sourceType: string; source: string; keywords: string[] },
  mentionCount?: number,
): number {
  let score = 0;

  // 来源权重
  switch (article.sourceType) {
    case 'social_media':
      score += 25;
      // 微博大 V 加成
      if (article.source.includes('微博')) score += 10;
      break;
    case 'news_aggregator':
      score += 20;
      break;
    case 'web_search':
      score += 15;
      break;
    case 'rss':
      score += 10;
      break;
    default:
      score += 10;
  }

  // 关键词权重加成（负面专项关键词权重更高）
  for (const keyword of article.keywords) {
    if (
      keyword.includes('违约') || keyword.includes('风险') ||
      keyword.includes('腐败') || keyword.includes('被查')
    ) {
      score += 10;
    }
  }

  // 提及次数加成
  if (mentionCount && mentionCount > 1) {
    score += Math.min(mentionCount * 2, 20);
  }

  return Math.min(score, 100);
}

/** 根据风险等级映射预警级别 */
export function riskToAlertLevel(riskLevel: RiskLevel): 'critical' | 'warning' | 'info' | null {
  switch (riskLevel) {
    case 'I':
      return 'critical';
    case 'II':
      return 'critical';
    case 'III':
      return 'warning';
    case 'IV':
      return 'info';
    default:
      return null;
  }
}
