import { getDeepSeekClient } from '../claude/client';
import { ResumeData } from './pdfService';

// ─── 简历分析结果 ───

export interface ResumeAnalysis {
  overallScore: number;          // 0-100 综合评分
  scores: {
    content: number;             // 内容质量 0-100
    structure: number;           // 结构清晰度 0-100
    ats: number;                 // ATS 兼容性 0-100
    impact: number;              // 影响力/数据量化 0-100
    keywords: number;            // 关键词覆盖 0-100
  };
  strengths: string[];           // 优点
  weaknesses: string[];          // 待改进项
  suggestions: Suggestion[];     // 具体修改建议
  atsKeywords: { missing: string[]; present: string[] }; // ATS 关键词
  summary: string;               // AI 综合评价
}

export interface Suggestion {
  section: string;               // 简历板块（如"工作经历"、"个人概述"）
  issue: string;                 // 问题描述
  fix: string;                   // 修改建议
  example?: string;              // 改写示例
  priority: 'high' | 'medium' | 'low';
}

// ─── 职位匹配结果 ───

export interface JobMatchResult {
  matchScore: number;            // 0-100 匹配度
  jobTitle: string;
  company: string;
  matchedSkills: string[];       // 匹配的技能
  missingSkills: string[];       // 缺失的技能
  experienceGap: string;         // 经验差距分析
  tailoredSuggestions: string[]; // 针对性优化建议
  interviewPrep: string[];       // 面试准备建议
}

// ─── 简历分析 ───

const ANALYZE_PROMPT = `你是资深 HR 和简历优化专家。分析以下简历，返回 JSON 格式的详细评估。

评估维度：
1. content (内容质量): 经历描述是否充实、专业
2. structure (结构): 排版逻辑是否清晰、层次分明
3. ats (ATS兼容): 关键词布局、格式是否易于机器解析
4. impact (影响力): 是否用数据量化成果、STAR 法则应用
5. keywords (关键词): 行业关键词覆盖度

综合评分 overallScore 是以上五项的平均（四舍五入到整数）。

strengths: 3-5 条具体优点
weaknesses: 3-5 条需改进的方面
suggestions: 3-6 条具体修改建议，每条含 section/issue/fix/example/priority

atsKeywords: 基于简历内容，提取 present（已覆盖的关键词）和 missing（建议补充的关键词），各 5-8 个

summary: 2-3 句话的综合评价，指出最关键的改进方向

返回纯 JSON：
{
  "overallScore": 72,
  "scores": { "content": 70, "structure": 75, "ats": 68, "impact": 72, "keywords": 75 },
  "strengths": ["..."],
  "weaknesses": ["..."],
  "suggestions": [{ "section": "工作经历", "issue": "...", "fix": "...", "example": "...", "priority": "high" }],
  "atsKeywords": { "missing": ["..."], "present": ["..."] },
  "summary": "..."
}`;

/** 分析简历内容，返回详细评分和改进建议 */
export async function analyzeResume(resumeText: string): Promise<ResumeAnalysis | null> {
  const client = getDeepSeekClient();
  const prompt = `${ANALYZE_PROMPT}\n\n简历内容：\n${resumeText.substring(0, 8000)}`;

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as ResumeAnalysis;
  } catch (err: any) {
    console.error('[分析器] 简历分析失败:', err.message);
    return null;
  }
}

/** 将分析结果格式化为飞书 Markdown 消息 */
export function formatAnalysisCard(analysis: ResumeAnalysis, resumeName?: string): string {
  const name = resumeName ? `「${resumeName}」` : '简历';
  const sc = analysis.scores;

  const scoreColor = (s: number) => s >= 80 ? '🟢' : s >= 65 ? '🟡' : '🔴';
  const bar = (s: number) => {
    const filled = Math.round(s / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  return [
    `📊 **${name} 分析报告**`,
    '',
    `🎯 **综合评分：${analysis.overallScore}/100**`,
    '',
    '**各维度评分：**',
    `${scoreColor(sc.content)} 内容质量　\`${sc.content}\`　${bar(sc.content)}`,
    `${scoreColor(sc.structure)} 结构清晰　\`${sc.structure}\`　${bar(sc.structure)}`,
    `${scoreColor(sc.ats)} ATS 兼容　\`${sc.ats}\`　${bar(sc.ats)}`,
    `${scoreColor(sc.impact)} 数据量化　\`${sc.impact}\`　${bar(sc.impact)}`,
    `${scoreColor(sc.keywords)} 关键词　　\`${sc.keywords}\`　${bar(sc.keywords)}`,
    '',
    `✅ **优点**`,
    ...analysis.strengths.map(s => `· ${s}`),
    '',
    `⚠️ **待改进**`,
    ...analysis.weaknesses.map(w => `· ${w}`),
    '',
    `🔧 **修改建议**`,
    ...analysis.suggestions.map(s =>
      `· **${s.section}** \`${s.priority === 'high' ? '🔴 优先' : s.priority === 'medium' ? '🟡 建议' : '🟢 可选'}\`\n` +
      `  问题：${s.issue}\n` +
      `  建议：${s.fix}\n` +
      (s.example ? `  示例：\`${s.example}\`\n` : '')
    ),
    '',
    `🏷 **关键词分析**`,
    `✅ 已覆盖：${analysis.atsKeywords.present.map(k => `\`${k}\``).join(' ')}`,
    `❌ 建议补充：${analysis.atsKeywords.missing.map(k => `\`${k}\``).join(' ')}`,
    '',
    `💬 **综合评价**`,
    analysis.summary,
  ].join('\n');
}
