/**
 * 天津城投舆情监测系统 — 核心类型定义
 *
 * 覆盖采集、分析、预警、报告四层数据模型
 */

// ========== 采集层 ==========

/** 内容来源类型 */
export type SourceType = 'web_search' | 'rss' | 'news_aggregator' | 'social_media';

/** 原始采集条目（未经 AI 分析） */
export interface RawArticle {
  id: string;                    // UUID v4
  title: string;
  url: string;
  source: string;                // 来源名称，如 "第一财经""微博""百度新闻"
  sourceType: SourceType;
  snippet: string;               // 摘要片段（搜索引擎提供的）
  content?: string;              // 全文（如果有抓取到）
  publishDate?: string;          // ISO 8601
  collectedAt: number;           // 采集时间戳 ms
  searchKeyword: string;         // 通过哪个关键词搜到的
  metadata?: {
    author?: string;
    wordCount?: number;
    images?: string[];
    rawHtml?: string;            // 仅调试用
  };
}

/** 采集结果摘要 */
export interface CollectResult {
  sourceType: SourceType;
  totalFetched: number;
  newItems: number;              // 去重后新增
  skipped: number;               // 重复跳过
  errors: string[];
  timestamp: number;
}

// ========== 分析层 ==========

/** 情感倾向 */
export type Sentiment = 'positive' | 'negative' | 'neutral';

/** 风险等级（Ⅰ-Ⅳ） */
export type RiskLevel = 'I' | 'II' | 'III' | 'IV' | 'none';

/** 风险分类 */
export type RiskCategory =
  | 'debt'            // 债务/信用风险
  | 'compliance'      // 合规/法律风险
  | 'project'         // 项目运营风险
  | 'personnel'       // 人事/廉政风险
  | 'public_opinion'  // 公众舆论风险
  | 'market'          // 市场/评级风险
  | 'none';

/** 命名实体 */
export interface Entities {
  persons: string[];
  companies: string[];
  projects: string[];
  amounts: string[];
  dates: string[];
}

/** AI 分析结果（DeepSeek API 返回的原始结构） */
export interface AIAnalysisResult {
  sentiment: Sentiment;
  riskLevel: RiskLevel;
  riskCategory: RiskCategory;
  confidence: number;           // 0.0 ~ 1.0
  entities: Entities;
  summary: string;              // 30 字以内
  keywords: string[];
  reasoning: string;            // 分析理由（50 字内）
}

/** 分析后的完整文章（入库条目） */
export interface AnalyzedArticle {
  id: string;                    // 与 RawArticle 相同
  title: string;
  url: string;
  source: string;
  sourceType: SourceType;
  content: string;               // 全文或长摘要
  publishDate: string;
  collectedAt: number;
  analyzedAt: number;            // 分析完成时间戳

  // AI 分析结果
  sentiment: Sentiment;
  riskLevel: RiskLevel;
  riskCategory: RiskCategory;
  confidence: number;
  entities: Entities;
  summary: string;
  keywords: string[];
  reasoning: string;

  // 硬性规则覆盖标记
  riskOverride?: {
    originalLevel: RiskLevel;
    newLevel: RiskLevel;
    reason: string;
  };

  // 预警标记
  alertSent: boolean;
  alertSentAt?: number;
  alertLevel?: 'critical' | 'warning' | 'info';

  // 热度指标
  heatScore: number;             // 0-100，综合来源权重和提及次数
}

// ========== 预警层 ==========

/** 预警记录 */
export interface AlertRecord {
  id: string;
  articleId: string;
  title: string;
  riskLevel: RiskLevel;
  alertLevel: 'critical' | 'warning' | 'info';
  sentAt: number;
  channel: 'feishu_card' | 'feishu_text';
  recipients: string[];
  acknowledged: boolean;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
}

// ========== 报告层 ==========

/** 舆情日报 */
export interface DailySentinelReport {
  date: string;                   // YYYY-MM-DD
  summary: {
    totalArticles: number;
    positiveCount: number;
    negativeCount: number;
    neutralCount: number;
    riskBreakdown: Record<RiskLevel, number>;
    topKeywords: { word: string; count: number }[];
    topSources: { source: string; count: number }[];
  };
  highRiskArticles: AnalyzedArticle[];    // II 级及以上
  negativeArticles: AnalyzedArticle[];    // 全部负面
  alertsToday: AlertRecord[];
  trendIndicator: 'up' | 'down' | 'stable';
  heatMap: { keyword: string; heat: number }[];
}

/** 舆情周报 */
export interface WeeklySentinelReport {
  weekStart: string;
  weekEnd: string;
  dailyReports: DailySentinelReport[];
  weeklyTrends: {
    totalVsLastWeek: number;      // 百分比变化
    negativeVsLastWeek: number;
    avgHeatScore: number;
    topRiskEvent: string;
  };
  riskDistribution: { category: RiskCategory; count: number; trend: string }[];
  recommendation: string;         // AI 生成的周度建议
}

// ========== 配置层 ==========

/** 关键词组 */
export interface KeywordGroup {
  name: string;                    // 如 "集团主体""债务专项"
  keywords: string[];
  weight: number;                  // 权重，影响热度计算
}

/** 预警条件类型 */
export type AlertCondition =
  | 'risk_level_above'     // 风险等级 >= threshold
  | 'negative_cluster'     // 24h 内同类负面 >= threshold
  | 'heat_exceeds'         // 热度超过 threshold
  | 'keyword_match';       // 匹配特定高危关键词

/** 预警规则 */
export interface AlertRule {
  id: string;
  condition: AlertCondition;
  threshold: number;
  action: 'notify' | 'escalate' | 'tag';
  channels: string[];              // chatId 列表
}

/** 模块配置 */
export interface SentinelConfig {
  keywordGroups: KeywordGroup[];
  alertRules: AlertRule[];
  alertChatIds: string[];          // 默认预警推送目标
  dailyReportChatId: string;       // 日报推送目标
  weeklyReportChatId: string;      // 周报推送目标
  collectIntervalMinutes: number;   // 全量采集间隔（分钟）
  analysisBatchSize: number;       // AI 批量分析条数
  retentionDays: number;           // 数据保留天数
  rssSources: { name: string; url: string; category: string }[];
}

// ========== API 层 ==========

/** 文章查询参数 */
export interface ArticleQuery {
  sentiment?: Sentiment;
  riskLevel?: RiskLevel;
  keyword?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}

/** 分页结果 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 舆情统计摘要 */
export interface SentinelStats {
  period: { from: string; to: string };
  totalArticles: number;
  sentimentBreakdown: { positive: number; negative: number; neutral: number };
  riskBreakdown: Record<RiskLevel, number>;
  topKeywords: { word: string; count: number }[];
  dailyTrend: { date: string; total: number; negative: number; positive: number }[];
  heatMap: { hour: string; count: number }[];
  lastCollectionTime: number | null;
  pendingAlerts: number;
}

/** 系统状态 */
export interface SentinelStatus {
  lastCollectionTime: number | null;
  lastAnalysisTime: number | null;
  todayCollected: number;
  todayAnalyzed: number;
  pendingAlerts: number;
  unacknowledgedAlerts: number;
  aiAvailable: boolean;
  activeSources: { name: string; healthy: boolean; lastFetch: number | null }[];
}
