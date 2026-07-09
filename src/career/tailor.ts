import { getDeepSeekClient } from '../claude/client';
import { ResumeData } from './pdfService';

/** 针对 JD 定制简历，返回调整后的 ResumeData */
export async function tailorResumeToJD(
  resumeData: ResumeData,
  jobDescription: string,
): Promise<{ tailored: ResumeData; changes: string[] } | null> {
  const client = getDeepSeekClient();
  const prompt = `你是简历优化专家。根据目标职位 JD 调整简历，使匹配度最大化。

规则：
1. 修改 summary，融入 JD 中的关键词和要求
2. 重新排序 skills，优先展示 JD 相关的技能类别
3. 为每段 experience 添加/改写 1-2 条与 JD 相关的 highlights（保持 STAR 法则和量化数据）
4. 不要编造不存在的经历——只能改写措辞、调整重点、重排顺序
5. 如果用户简历中确实缺少 JD 要求的核心技能，不要伪造，而是在 changes 中标注"建议补充"

返回 JSON：
{
  "tailored": { ResumeData 完整结构（与输入格式一致，只修改需要改的部分） },
  "changes": ["修改点1", "修改点2", ...]
}

原始简历：
${JSON.stringify(resumeData, null, 2)}

目标 JD：
${jobDescription}`;

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000, temperature: 0.3,
    });
    const content = response.choices[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;

    const result = JSON.parse(m[0]);
    return {
      tailored: result.tailored as ResumeData,
      changes: result.changes || [],
    };
  } catch (err: any) {
    console.error('[定制简历] 失败:', err.message);
    return null;
  }
}

/** 格式化定制结果为可读消息 */
export function formatTailorResult(changes: string[]): string {
  return [
    '🔧 **简历已针对该 JD 定制完成**',
    '',
    '**主要调整：**',
    ...changes.map((c, i) => `${i + 1}. ${c}`),
    '',
    '💡 输入 `/生成简历` 导出 PDF，或 `/网页简历` 查看 HTML 版本',
    '💡 输入 `/分析简历` 查看定制后的评分变化',
  ].join('\n');
}
