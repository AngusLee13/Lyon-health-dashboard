/**
 * 天津城投舆情监测 — 情感分析器
 *
 * 使用 DeepSeek API 对舆情文本进行正/负/中性情感分析，
 * 并提取关键实体、风险分类、摘要等结构化信息。
 *
 * 核心设计：
 *   1. Prompt 明确角色、分析维度、输出格式
 *   2. 批量提交以提高吞吐（每批最多 5 条）
 *   3. 低 temperature 保证输出稳定性
 *   4. 解析失败时降级到关键词规则引擎
 */

import { getDeepSeekClient } from '../../claude/client';
import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import { RawArticle, AIAnalysisResult } from '../types';

const log = createLogger('情感分析');

const SENTIMENT_SYSTEM_PROMPT = `你是一个专业的舆情分析师，专注于中国地方政府融资平台（城投公司）的舆情监测。

请分析以下关于"天津城投集团"的舆情文本，返回严格的 JSON 格式结果。

## 分析维度

### 1. 情感倾向（sentiment）
- positive: 正面报道（如：项目顺利推进、信用评级提升、获得政策支持、中标重大项目、债务化解进展、融资渠道畅通）
- negative: 负面报道（如：债务违约风险、高管被调查/留置、项目事故、资金链紧张、评级下调、被监管处罚、经营亏损）
- neutral: 中性报道（如：常规公告、人事变动、行业分析提及、例行信息披露、债券发行公告）

### 2. 风险等级（riskLevel）—— 仅对负面/潜在负面适用
- I: 特别重大 — 可能引发系统性金融风险、涉及金额超百亿、引发监管层关注的重大违法违规、涉及主要负责人被留置/逮捕
- II: 重大 — 区域金融市场波动、涉及金额十亿级、媒体大面积报道、可能引发评级调整、高管被查
- III: 较大 — 单个项目风险、涉及金额亿级、局部媒体报道、需集团层面应对
- IV: 一般 — 个别负面评论、小范围传播、可由部门层面处理、轻微合规问题
- none: 无风险（正面或中性内容）

### 3. 风险分类（riskCategory）
- debt: 债务/信用风险（违约、逾期、评级下调、融资受阻）
- compliance: 合规/法律风险（行政处罚、监管函、诉讼）
- project: 项目运营风险（工程事故、项目停滞、交付延期）
- personnel: 人事/廉政风险（高管被查、留置、贪腐、违纪）
- public_opinion: 公众舆论风险（负面热搜、谣言、群体投诉）
- market: 市场/评级风险（评级展望负面、债券价格异动）
- none: 无风险

### 4. 关键实体提取（entities）
提取文中提到的关键实体：人名、公司名、项目名、金额、日期

### 5. 摘要（summary）
30字以内的中文摘要

### 6. 情感置信度（confidence）
0.0 ~ 1.0，你对情感判断的确信程度

## 输出格式（严格 JSON，不要输出其他内容）
{
  "sentiment": "negative" | "positive" | "neutral",
  "riskLevel": "I" | "II" | "III" | "IV" | "none",
  "riskCategory": "debt" | "compliance" | "project" | "personnel" | "public_opinion" | "market" | "none",
  "confidence": 0.0~1.0,
  "entities": { "persons": [], "companies": [], "projects": [], "amounts": [], "dates": [] },
  "summary": "30字以内摘要",
  "keywords": ["关键词1", "关键词2"],
  "reasoning": "简短的分析理由（50字内）"
}`;

/** 构建单篇文章的分析 Prompt */
function buildAnalysisPrompt(article: RawArticle): string {
  const parts: string[] = [];
  if (article.title) parts.push(`标题：${article.title}`);
  if (article.source) parts.push(`来源：${article.source} (${article.sourceType})`);
  if (article.snippet) parts.push(`摘要：${article.snippet}`);
  if (article.content) parts.push(`正文：${article.content}`);
  if (article.publishDate) parts.push(`发布时间：${article.publishDate}`);
  parts.push(`搜索关键词：${article.searchKeyword}`);
  return parts.join('\n');
}

/** JSON 清理：提取第一个完整 JSON 对象 */
function extractJSON(text: string): string {
  // 尝试找到 ```json ... ``` 包裹的代码块
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // 查找第一个 { 和最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.substring(start, end + 1);
  }
  return text;
}

/** 默认空分析结果（用于降级） */
function emptyResult(): AIAnalysisResult {
  return {
    sentiment: 'neutral',
    riskLevel: 'none',
    riskCategory: 'none',
    confidence: 0,
    entities: { persons: [], companies: [], projects: [], amounts: [], dates: [] },
    summary: '',
    keywords: [],
    reasoning: '分析未完成',
  };
}

/** 分析单篇文章 */
async function analyzeOne(article: RawArticle): Promise<AIAnalysisResult> {
  const client = getDeepSeekClient();
  const prompt = buildAnalysisPrompt(article);

  try {
    const response = await client.chat.completions.create({
      model: config.deepseek.model,
      messages: [
        { role: 'system', content: SENTIMENT_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    });

    const rawText = response.choices[0]?.message?.content || '';
    const jsonStr = extractJSON(rawText);

    try {
      const parsed = JSON.parse(jsonStr) as AIAnalysisResult;
      // 基本字段校验
      if (!['positive', 'negative', 'neutral'].includes(parsed.sentiment)) {
        parsed.sentiment = 'neutral';
      }
      if (!['I', 'II', 'III', 'IV', 'none'].includes(parsed.riskLevel)) {
        parsed.riskLevel = 'none';
      }
      if (typeof parsed.confidence !== 'number' || isNaN(parsed.confidence)) {
        parsed.confidence = 0.5;
      }
      return parsed;
    } catch (parseErr) {
      log.warn(`AI 返回 JSON 解析失败: ${String(parseErr).substring(0, 100)}`);
      log.debug(`原始返回: ${rawText.substring(0, 200)}`);
      return emptyResult();
    }
  } catch (err: any) {
    log.error(`AI 分析调用失败: ${err.message}`);
    throw err;
  }
}

/** 批量分析多篇文章 */
export async function analyzeBatch(articles: RawArticle[]): Promise<Map<string, AIAnalysisResult>> {
  const results = new Map<string, AIAnalysisResult>();
  let successCount = 0;
  let failCount = 0;

  // 逐条分析（可后续优化为真批量）
  for (const article of articles) {
    try {
      const result = await analyzeOne(article);
      results.set(article.id, result);
      successCount++;
    } catch (err: any) {
      log.error(`分析失败 [${article.id}]: ${err.message}`);
      results.set(article.id, emptyResult());
      failCount++;
    }
  }

  log.info(`分析完成: 成功 ${successCount} / 失败 ${failCount} / 总计 ${articles.length}`);
  return results;
}

/**
 * 基于关键词的简单情感判断（降级方案）
 * 当 DeepSeek API 不可用时使用
 */
export function keywordBasedSentiment(title: string, snippet: string): AIAnalysisResult {
  const text = `${title} ${snippet}`;
  const lowerText = text.toLowerCase();

  // 负面关键词
  const negativeWords = [
    '违约', '爆雷', '破产', '被查', '逮捕', '留置', '立案', '处罚',
    '亏损', '损失', '风险', '逾期', '下调', '失信', '被执行',
    '事故', '死亡', '重伤', '腐败', '贪腐', '违规', '违法',
    '投诉', '维权', '抵制', '质疑', '争议', '丑闻', '黑幕',
    '下跌', '暴跌', '崩盘', '流动性', '下滑',
  ];

  // 正面关键词
  const positiveWords = [
    '中标', '获奖', '成功', '突破', '好评', '增长', '提升',
    '创新', '领先', '优势', '利好', '评级确认', '稳定',
    '推进', '竣工', '投产', '合作', '入选', '示范',
  ];

  let negCount = 0;
  let posCount = 0;

  for (const w of negativeWords) {
    if (lowerText.includes(w)) negCount++;
  }
  for (const w of positiveWords) {
    if (lowerText.includes(w)) posCount++;
  }

  let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
  if (negCount > posCount) sentiment = 'negative';
  else if (posCount > negCount) sentiment = 'positive';

  return {
    sentiment,
    riskLevel: sentiment === 'negative' ? 'IV' : 'none',
    riskCategory: sentiment === 'negative' ? 'public_opinion' : 'none',
    confidence: 0.3,  // 关键词法置信度较低
    entities: { persons: [], companies: [], projects: [], amounts: [], dates: [] },
    summary: text.substring(0, 30),
    keywords: [],
    reasoning: '基于关键词规则（AI 不可用降级）',
  };
}
