/**
 * 天津城投舆情监测系统 — 模块配置
 *
 * 包含监测关键词组、预警规则、风险阈值、数据源列表等。
 * 敏感值（API Key 等）从环境变量读取，与项目现有模式一致。
 */

import { SentinelConfig } from './types';

/**
 * 天津城投 — 全量监测关键词矩阵
 *
 * 关键词分为四组：
 *   group-a: 主体名称（全覆盖采集）
 *   group-b: 负面专项（债务/风险/违规等，高频轮询）
 *   group-c: 正面专项（中标/评级/基建，捕捉正面动态）
 *   group-d: 行业政策（城投行业系统性风险，背景监测）
 */
export const keywordGroups = [
  {
    name: 'group-a-主体名称',
    keywords: [
      '天津城投',
      '天津城投集团',
      '天津城市基础设施建设投资集团',
      '天津城市基础设施建设投资集团有限公司',
      '天津基础设施投资集团',
    ],
    weight: 10,  // 最高权重
  },
  {
    name: 'group-b-负面专项',
    keywords: [
      '天津城投 违约',
      '天津城投 债务',
      '天津城投 负债',
      '天津城投 风险',
      '天津城投 爆雷',
      '天津城投 逾期',
      '天津城投 评级下调',
      '天津城投 腐败',
      '天津城投 被查',
      '天津城投 事故',
      '天津城投 亏损',
      '天津城投 诉讼',
      '天津城投 处罚',
      '天津城投 监管',
      '天津城投 退平台',
    ],
    weight: 20,  // 负面专项权重最高，高频轮询
  },
  {
    name: 'group-c-正面专项',
    keywords: [
      '天津城投 中标',
      '天津城投 评级',
      '天津城投 基建',
      '天津城投 债券',
      '天津城投 融资',
      '天津城投 城市更新',
      '天津城投 项目',
    ],
    weight: 8,
  },
  {
    name: 'group-d-行业政策',
    keywords: [
      '城投 退平台',
      '35号文 城投',
      '隐债化解 城投',
      '城投转型',
      '一揽子化债',
      '特殊再融资债券 城投',
      '城投 监管新规',
    ],
    weight: 5,  // 行业背景，权重较低
  },
];

/** 高危关键词 — 硬性规则升级触发词 */
export const highRiskKeywords = [
  '违约', '爆雷', '破产', '被查', '逮捕', '留置',
  '立案', '停牌', '终止', '失信', '被执行', '李丹',
];

/** 权威来源 — 出现即升级（自动升至 II 级起） */
export const authoritativeSources = [
  '中央纪委国家监委',
  '银保监会',
  '证监会',
  '国家发改委',
  '财政部',
  '中国人民银行',
  '天津市纪委监委',
  '天津市国资委',
];

/** 预警规则 */
export const alertRules = [
  {
    id: 'rule-risk-level',
    condition: 'risk_level_above' as const,
    threshold: 2,  // II 级及以上触发
    action: 'notify' as const,
    channels: [],  // 由 alertChatIds 统一配置
  },
  {
    id: 'rule-negative-cluster',
    condition: 'negative_cluster' as const,
    threshold: 5,  // 24h 内同类负面 >= 5 条触发
    action: 'notify' as const,
    channels: [],
  },
  {
    id: 'rule-heat',
    condition: 'heat_exceeds' as const,
    threshold: 70,  // 热度 > 70 触发
    action: 'escalate' as const,
    channels: [],
  },
  {
    id: 'rule-high-risk-keyword',
    condition: 'keyword_match' as const,
    threshold: 1,  // 匹配任一高危关键词即触发
    action: 'escalate' as const,
    channels: [],
  },
];

/** RSS 订阅源 */
export const rssSources = [
  // 财经媒体
  { name: '第一财经', url: 'https://www.yicai.com/feed/', category: '财经媒体' },
  { name: '21世纪经济报道', url: 'https://www.21jingji.com/feed/', category: '财经媒体' },
  { name: '经济观察报', url: 'https://www.eeo.com.cn/feed/', category: '财经媒体' },
  { name: '财新网', url: 'https://www.caixin.com/feed/', category: '财经媒体' },
  // 债券/城投垂直
  { name: '中国债券信息网', url: 'https://www.chinabond.com.cn/rss/', category: '债券垂直' },
  // 天津本地
  { name: '天津日报', url: 'https://www.tianjinwe.com/rss/', category: '天津本地' },
  { name: '北方网', url: 'https://www.enorth.com.cn/rss/', category: '天津本地' },
];

/** 社交媒体搜索 URL 模板 */
export const socialSearchUrls = {
  weibo: 'https://s.weibo.com/weibo?q={keyword}&typeall=1&suball=1',
  zhihu: 'https://www.zhihu.com/search?type=content&q={keyword}',
  baiduNews: 'https://news.baidu.com/ns?word={keyword}&pn={page}&cl=1&ct=0',
} as const;

/** 模块默认配置 */
export const sentinelConfig: SentinelConfig = {
  keywordGroups,
  alertRules,
  alertChatIds: (process.env.SENTINEL_ALERT_CHAT_IDS || '')
    .split(',')
    .filter(Boolean),
  dailyReportChatId: process.env.SENTINEL_DAILY_REPORT_CHAT_ID || process.env.REPORT_CHAT_ID || '',
  weeklyReportChatId: process.env.SENTINEL_WEEKLY_REPORT_CHAT_ID || process.env.REPORT_CHAT_ID || '',
  collectIntervalMinutes: parseInt(process.env.SENTINEL_COLLECT_INTERVAL || '120', 10),
  analysisBatchSize: parseInt(process.env.SENTINEL_ANALYSIS_BATCH || '5', 10),
  retentionDays: parseInt(process.env.SENTINEL_RETENTION_DAYS || '30', 10),
  rssSources,
};
