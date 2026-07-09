import { getDeepSeekClient } from '../claude/client';
import { ResumeData } from './pdfService';
import { JobMatchResult } from './analyzer';

// ─── 职位搜索 ───

export interface JobListing {
  title: string;
  company: string;
  location: string;
  salary?: string;
  description: string;
  requirements: string[];
  url?: string;
  source: string;
  postedDate?: string;
}

export interface JobSearchParams {
  keyword: string;           // 搜索关键词（如"风险治理"）
  location?: string;         // 工作地点
  experienceLevel?: string;  // 经验级别（初级/中级/高级）
  industry?: string;         // 行业
  limit?: number;            // 返回数量（默认5）
}

const SEARCH_PROMPT = `你是专业的职位搜索与匹配助手。根据用户的搜索条件，结合你的知识，返回最新的相关职位信息。

返回 JSON 数组格式（按匹配度排序）：
[{
  "title": "岗位名称",
  "company": "公司名称",
  "location": "工作地点",
  "salary": "薪资范围（如有）",
  "description": "岗位描述（2-3句话概述核心职责）",
  "requirements": ["要求1", "要求2", ...],
  "source": "信息来源（如Boss直聘/猎聘/LinkedIn/企业官网）",
  "postedDate": "发布时间"
}]

规则：
1. 只返回真实存在或高度可信的职位（基于你的知识库）
2. 优先返回近期发布的职位
3. 岗位描述要具体而非泛泛而谈
4. 返回 ${5} 个最匹配的职位
5. 只返回 JSON 数组，不要其他文字`;

/** 搜索职位 */
export async function searchJobs(params: JobSearchParams): Promise<JobListing[]> {
  const client = getDeepSeekClient();
  const conditions = [
    params.keyword ? `关键词：${params.keyword}` : '',
    params.location ? `地点：${params.location}` : '',
    params.experienceLevel ? `经验：${params.experienceLevel}` : '',
    params.industry ? `行业：${params.industry}` : '',
  ].filter(Boolean).join('，');

  const limit = params.limit || 5;

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `${SEARCH_PROMPT.replace('${5}', String(limit))}\n\n搜索条件：${conditions || '风险治理相关职位'}`,
      }],
      max_tokens: 3000,
      temperature: 0.4,
    });

    const content = response.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const jobs = JSON.parse(jsonMatch[0]) as JobListing[];
    return jobs.slice(0, limit);
  } catch (err: any) {
    console.error('[职位搜索] 失败:', err.message);
    return [];
  }
}

/** 格式化职位列表为飞书消息 */
export function formatJobListings(jobs: JobListing[], searchDesc: string): string {
  if (!jobs.length) return `🔍 未找到与「${searchDesc}」相关的职位，请尝试调整搜索条件。`;

  const lines = [
    `🔍 **职位搜索结果**（${searchDesc}）`,
    `共找到 ${jobs.length} 个相关职位：`,
    '',
  ];

  jobs.forEach((job, i) => {
    lines.push(
      `**${i + 1}. ${job.title}**`,
      `🏢 ${job.company}　📍 ${job.location}${job.salary ? `　💰 ${job.salary}` : ''}`,
      `📝 ${job.description}`,
      `📋 要求：${job.requirements.map(r => `\`${r}\``).join(' · ')}`,
      `${job.source}${job.postedDate ? ` · ${job.postedDate}` : ''}`,
      '',
    );
  });

  lines.push('💡 发送 `/职位匹配 [序号]` 可将你的简历与指定职位进行匹配分析');
  return lines.join('\n');
}

// ─── 职位匹配 ───

const MATCH_PROMPT = `你是资深的招聘专家。对比求职者的简历和目标职位描述，给出详细的匹配分析。

返回 JSON：
{
  "matchScore": 72,
  "jobTitle": "岗位名称",
  "company": "公司名称",
  "matchedSkills": ["匹配的技能1", "匹配的技能2"],
  "missingSkills": ["缺失的技能1", "缺失的技能2"],
  "experienceGap": "经验差距的一句话总结",
  "tailoredSuggestions": ["简历优化建议1", "建议2"],
  "interviewPrep": ["面试准备建议1", "建议2"]
}

评分标准：
- 技能匹配度（40分）
- 经验匹配度（30分）
- 学历/证书匹配（15分）
- 行业/领域匹配（15分）

建议要具体、可操作。只返回 JSON。`;

/** 将简历与职位进行匹配分析 */
export async function matchResumeToJob(
  resumeText: string,
  jobDescription: string,
): Promise<JobMatchResult | null> {
  const client = getDeepSeekClient();

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `${MATCH_PROMPT}\n\n【求职者简历】\n${resumeText.substring(0, 4000)}\n\n【目标职位】\n${jobDescription.substring(0, 2000)}`,
      }],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as JobMatchResult;
  } catch (err: any) {
    console.error('[职位匹配] 失败:', err.message);
    return null;
  }
}

/** 格式化匹配结果为飞书消息 */
export function formatMatchResult(result: JobMatchResult): string {
  const score = result.matchScore;
  const emoji = score >= 80 ? '🎉' : score >= 65 ? '👍' : score >= 50 ? '⚠️' : '🔴';
  const tag = score >= 80 ? '高度匹配' : score >= 65 ? '较为匹配' : score >= 50 ? '部分匹配' : '差距较大';

  return [
    `📊 **职位匹配分析**`,
    '',
    `**${result.jobTitle}** @ ${result.company}`,
    '',
    `${emoji} 综合匹配度：**${score}/100**（${tag}）`,
    '',
    `✅ **已匹配技能**（${result.matchedSkills.length}项）`,
    ...result.matchedSkills.map(s => `· ${s}`),
    '',
    `❌ **待提升技能**（${result.missingSkills.length}项）`,
    ...result.missingSkills.map(s => `· ${s}`),
    '',
    `📝 **经验差距**`,
    result.experienceGap,
    '',
    `🔧 **简历优化建议**`,
    ...result.tailoredSuggestions.map(s => `· ${s}`),
    '',
    `🎯 **面试准备**`,
    ...result.interviewPrep.map(s => `· ${s}`),
  ].join('\n');
}

/** 从简历文本中生成结构化摘要（用于匹配时传参） */
export function quickResumeSummary(resumeData: ResumeData): string {
  const parts: string[] = [];
  if (resumeData.name) parts.push(`姓名：${resumeData.name}`);
  if (resumeData.targetRole) parts.push(`求职意向：${resumeData.targetRole}`);
  if (resumeData.summary) parts.push(`概述：${resumeData.summary}`);
  if (resumeData.skills?.length) {
    parts.push(`技能：${resumeData.skills.map(s => `${s.category}(${s.items.join('、')})`).join('；')}`);
  }
  if (resumeData.experiences?.length) {
    parts.push(`工作经历：${resumeData.experiences.map(e =>
      `${e.company} ${e.role} (${e.period})`
    ).join('；')}`);
  }
  if (resumeData.education) {
    parts.push(`教育：${resumeData.education.school} ${resumeData.education.degree}`);
  }
  return parts.join('\n');
}
