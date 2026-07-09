/**
 * 天津城投舆情监测 — 日报卡片生成器
 *
 * 每日 12:00 生成过去 24 小时的舆情总结，
 * 以飞书卡片消息格式发送到指定群聊。
 */

import { queryArticles, getArticlesByDate, saveDailyReport } from './store';
import { AnalyzedArticle, DailySentinelReport, RiskLevel } from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('日报生成');

/** 今天日期 */
function today(): string {
  return new Date().toISOString().substring(0, 10);
}

/** 昨天日期 */
function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().substring(0, 10);
}

/** 按风险等级取图标 */
function riskEmoji(level: RiskLevel): string {
  switch (level) {
    case 'I': return '🔴';
    case 'II': return '🟠';
    case 'III': return '🟡';
    case 'IV': return '🔵';
    default: return '⚪';
  }
}

/** 按情感取图标 */
function sentimentEmoji(s: string): string {
  switch (s) {
    case 'positive': return '🟢';
    case 'negative': return '🔴';
    default: return '⚪';
  }
}

/** 风险等级中文 */
function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'I': return 'Ⅰ级·特别重大';
    case 'II': return 'Ⅱ级·重大';
    case 'III': return 'Ⅲ级·较大';
    case 'IV': return 'Ⅳ级·一般';
    default: return '无风险';
  }
}

/** 趋势指示 */
function trendArrow(current: number, previous: number): string {
  if (previous === 0) return '';
  if (current > previous) return '↑';
  if (current < previous) return '↓';
  return '→';
}

// ========== 主入口 ==========

export interface SentinelCardReport {
  date: string;
  card: object;
  summary: DailySentinelReport;
}

/**
 * 构建舆情日报
 * @param dateStr 可选，指定日期，默认今天
 * @param lookbackHours 回看小时数，默认 24
 */
export async function buildDailySentinelReport(
  dateStr?: string,
  lookbackHours = 24,
): Promise<SentinelCardReport> {
  const date = dateStr || today();
  const yday = yesterday();

  // 1. 获取数据
  const todayArticles = getArticlesByDate(date);
  const yesterdayArticles = getArticlesByDate(yday);

  // 2. 如果今天数据不足，合并昨天的最近 24h 数据
  const cutoff = Date.now() - lookbackHours * 3600 * 1000;
  const recentToday = todayArticles.filter(a => a.collectedAt >= cutoff);

  const articles = recentToday.length >= 1 ? recentToday : todayArticles;

  // 3. 统计分析
  const positiveArticles = articles.filter(a => a.sentiment === 'positive');
  const negativeArticles = articles.filter(a => a.sentiment === 'negative');
  const neutralArticles = articles.filter(a => a.sentiment === 'neutral');

  const highRiskArticles = articles.filter(
    a => a.riskLevel === 'I' || a.riskLevel === 'II',
  );
  const mediumRiskArticles = articles.filter(
    a => a.riskLevel === 'III',
  );

  // 风险分布
  const riskBreakdown: Record<RiskLevel, number> = {
    I: 0, II: 0, III: 0, IV: 0, none: 0,
  };
  for (const a of articles) {
    riskBreakdown[a.riskLevel]++;
  }

  // 热词 TOP 10
  const keywordFreq = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords || []) {
      keywordFreq.set(kw, (keywordFreq.get(kw) || 0) + 1);
    }
  }
  const topKeywords = Array.from(keywordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));

  // 趋势对比
  const yesterdayNegCount = yesterdayArticles.filter(a => a.sentiment === 'negative').length;
  const trendNeg = trendArrow(negativeArticles.length, yesterdayNegCount);

  // 4. 构建日报对象
  const report: DailySentinelReport = {
    date,
    summary: {
      totalArticles: articles.length,
      positiveCount: positiveArticles.length,
      negativeCount: negativeArticles.length,
      neutralCount: neutralArticles.length,
      riskBreakdown,
      topKeywords,
      topSources: getTopSources(articles),
    },
    highRiskArticles,
    negativeArticles,
    alertsToday: [],
    trendIndicator: articles.length > yesterdayArticles.length ? 'up'
      : articles.length < yesterdayArticles.length ? 'down' : 'stable',
    heatMap: topKeywords.map(k => ({ keyword: k.word, heat: k.count })),
  };

  // 5. 保存日报
  saveDailyReport(report);

  // 6. 构建飞书卡片
  const card = buildCard(report, yesterdayNegCount);

  return { date, card, summary: report };
}

// ========== 卡片构建 ==========

function buildCard(report: DailySentinelReport, yesterdayNegCount: number): object {
  const { summary, highRiskArticles, negativeArticles } = report;
  const elements: object[] = [];

  // ── 标题 ──
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][new Date(report.date).getDay()];
  elements.push({
    tag: 'markdown',
    content: `**📡 天津城投 · 舆情日报**\n${report.date} 周${weekDay}  ·  过去24小时监测`,
  });

  // ── 总览指标卡 ──
  const negPct = summary.totalArticles > 0
    ? ((summary.negativeCount / summary.totalArticles) * 100).toFixed(1)
    : '0';
  const riskCount = highRiskArticles.length + summary.riskBreakdown.III;
  const riskColor = riskCount > 2 ? 'red'
    : riskCount > 0 ? 'yellow'
    : 'green';

  elements.push({
    tag: 'column_set',
    flex_mode: 'bisect',
    background_style: 'grey',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'markdown',
          content: `📰 **采集**  \n\`${summary.totalArticles}\` 篇`,
        }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'markdown',
          content: `📊 **情感**  \n🟢${summary.positiveCount}  🔴${summary.negativeCount}  ⚪${summary.neutralCount}`,
        }],
      },
    ],
  });

  elements.push({
    tag: 'column_set',
    flex_mode: 'bisect',
    background_style: 'grey',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'markdown',
          content: `⚠️ **风险**  \n${riskEmoji('I')}${summary.riskBreakdown.I}  ${riskEmoji('II')}${summary.riskBreakdown.II}  ${riskEmoji('III')}${summary.riskBreakdown.III}  ${riskEmoji('IV')}${summary.riskBreakdown.IV}`,
        }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'markdown',
          content: `📉 **趋势**  \n负面 ${summary.negativeCount} 条  ${yesterdayNegCount > 0 ? `昨 ${yesterdayNegCount} ${summary.negativeCount > yesterdayNegCount ? '↑' : '↓'}` : ''}`,
        }],
      },
    ],
  });

  // ── 热词 ──
  if (summary.topKeywords.length > 0) {
    const kwTags = summary.topKeywords
      .slice(0, 8)
      .map(k => `\`${k.word}\``)
      .join('  ');
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**🏷️ 热词**  \n${kwTags}`,
    });
  }

  // ── 重点关注（Ⅱ级以上） ──
  if (highRiskArticles.length > 0 || summary.riskBreakdown.III > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**🚨 重点关注** ${riskColor === 'red' ? '🔴' : riskColor === 'yellow' ? '🟡' : ''}`,
    });

    // 高危文章
    for (const a of highRiskArticles) {
      elements.push({
        tag: 'markdown',
        content: [
          `${riskEmoji(a.riskLevel)} **${a.title.substring(0, 50)}**`,
          `来源：${a.source}  ·  热度：\`${a.heatScore}\`  ·  置信度 \`${(a.confidence * 100).toFixed(0)}%\``,
          a.summary ? `> ${a.summary}` : '',
          a.reasoning ? `分析：${a.reasoning}` : '',
        ].filter(Boolean).join('  \n'),
      });
    }

    // Ⅲ级精简列表
    const IIIArticles = negativeArticles
      .filter(a => a.riskLevel === 'III')
      .slice(0, 3);
    for (const a of IIIArticles) {
      if (!highRiskArticles.find(h => h.id === a.id)) {
        elements.push({
          tag: 'markdown',
          content: `${riskEmoji(a.riskLevel)} ${a.title.substring(0, 45)}  — ${a.source}`,
        });
      }
    }
  } else {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**✅ 无高危预警**  ·  过去24小时未监测到Ⅱ级及以上风险舆情`,
    });
  }

  // ── 负面舆情摘要 ──
  if (negativeArticles.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**📋 负面舆情汇总**（共 ${negativeArticles.length} 条）`,
    });

    for (const a of negativeArticles.slice(0, 5)) {
      elements.push({
        tag: 'markdown',
        content: [
          `${riskEmoji(a.riskLevel)} ${a.title.substring(0, 55)}`,
          `> ${a.source}  ·  ${a.summary || '无摘要'}`,
        ].join('  \n'),
      });
    }

    if (negativeArticles.length > 5) {
      elements.push({
        tag: 'markdown',
        content: `*…还有 ${negativeArticles.length - 5} 条负面舆情，详见监控面板*`,
      });
    }
  }

  // ── 正面亮点 ──
  const positiveArticles = report.negativeArticles
    ? [] : [];
  const allPositives = [
    ...(report.summary as any)?.topKeywords ? [] : [],
  ];

  // ── 底部信息 ──
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `📡 实时监控中  ·  关键词 \`天津城投\` \`天津城投集团\` 等 34 组  ·  下期日报 明日 12:00`,
  });

  elements.push({
    tag: 'note',
    elements: [{
      tag: 'plain_text',
      content: '天津城投舆情监测系统 · 自动生成',
    }],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📡 天津城投舆情日报 ${report.date}` },
      template: 'blue',
    },
    elements,
  };
}

// ========== 辅助函数 ==========

function getTopSources(articles: AnalyzedArticle[]): { source: string; count: number }[] {
  const map = new Map<string, number>();
  for (const a of articles) {
    map.set(a.source, (map.get(a.source) || 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({ source, count }));
}
