import { getDeepSeekClient } from '../claude/client';
import { ResumeData } from './pdfService';

export interface SkillsGapReport {
  targetRole: string;
  overallFit: number;           // 0-100
  matchedSkills: string[];
  gaps: SkillGap[];
  learningPath: LearningStep[];
  summary: string;
}

export interface SkillGap {
  skill: string;
  currentLevel: 'none' | 'basic' | 'intermediate' | 'advanced';
  requiredLevel: 'basic' | 'intermediate' | 'advanced' | 'expert';
  importance: 'critical' | 'important' | 'nice_to_have';
  estimatedHours: number;
  resources: string[];  // 推荐学习资源
}

export interface LearningStep {
  order: number;
  action: string;
  skills: string[];
  timeframe: string;
  rationale: string;
}

/** 分析用户简历与目标角色的技能差距 */
export async function analyzeSkillsGap(
  resumeData: ResumeData,
  targetRole: string,
): Promise<SkillsGapReport | null> {
  const client = getDeepSeekClient();
  const prompt = `你是风险治理领域的职业发展专家。分析用户简历与目标角色的技能差距。

返回 JSON：
{
  "overallFit": 65,
  "matchedSkills": ["已匹配技能1", ...],
  "gaps": [
    {
      "skill": "技能名",
      "currentLevel": "none|basic|intermediate|advanced",
      "requiredLevel": "basic|intermediate|advanced|expert",
      "importance": "critical|important|nice_to_have",
      "estimatedHours": 40,
      "resources": ["推荐课程/书籍/项目"]
    }
  ],
  "learningPath": [
    {
      "order": 1,
      "action": "具体行动",
      "skills": ["涉及技能"],
      "timeframe": "2-4周",
      "rationale": "为什么优先"
    }
  ],
  "summary": "2-3句话总体评估和建议"
}

重要：只基于用户简历中提到的技能进行评估，不要假设用户有简历中未提及的技能。

用户简历：
${JSON.stringify(resumeData, null, 2)}

目标角色：${targetRole}`;

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000, temperature: 0.3,
    });
    const content = response.choices[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) as SkillsGapReport : null;
  } catch (err: any) {
    console.error('[技能差距] 失败:', err.message);
    return null;
  }
}

/** 格式化技能差距报告 */
export function formatSkillsGap(report: SkillsGapReport): string {
  const fitEmoji = report.overallFit >= 75 ? '🟢' : report.overallFit >= 55 ? '🟡' : '🔴';
  const lines = [
    `📊 **技能差距分析：${report.targetRole}**`,
    '',
    `${fitEmoji} 整体匹配度：**${report.overallFit}/100**`,
    '',
    `✅ **已匹配技能**（${report.matchedSkills.length}项）`,
    report.matchedSkills.map(s => `· ${s}`).join('\n'),
    '',
    `⚠️ **待提升技能**（${report.gaps.length}项）`,
  ];

  const critical = report.gaps.filter(g => g.importance === 'critical');
  const important = report.gaps.filter(g => g.importance === 'important');
  const nice = report.gaps.filter(g => g.importance === 'nice_to_have');

  if (critical.length) {
    lines.push('');
    lines.push('🔴 **必须补齐**');
    critical.forEach(g => lines.push(
      `· **${g.skill}** ${g.currentLevel}→${g.requiredLevel} · 约${g.estimatedHours}h · ${g.resources[0] || ''}`
    ));
  }
  if (important.length) {
    lines.push('');
    lines.push('🟡 **建议提升**');
    important.forEach(g => lines.push(
      `· **${g.skill}** ${g.currentLevel}→${g.requiredLevel} · ${g.resources[0] || ''}`
    ));
  }

  lines.push('');
  lines.push('📚 **学习路径**');
  report.learningPath.forEach(s => lines.push(
    `**${s.order}.** ${s.action}（${s.timeframe}）\n　　${s.rationale}`
  ));

  lines.push('');
  lines.push(`💬 ${report.summary}`);
  return lines.join('\n');
}
