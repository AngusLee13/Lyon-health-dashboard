import { getDeepSeekClient } from '../claude/client';
import { ResumeData } from './pdfService';
import { getApplications, addApplication, updateApplication, JobApplication } from './store';
import { updatePhase } from './workflowState';

// ─── 投递追踪 ───

/** 记录新的投递 */
export function trackApplication(
  chatId: string,
  company: string,
  title: string,
  jd?: string,
): JobApplication {
  const id = `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const app: JobApplication = {
    id,
    company,
    title,
    status: 'applied',
    appliedDate: new Date().toISOString().slice(0, 10),
    notes: '',
    interviews: [],
    jd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  addApplication(app);
  updatePhase(chatId, 'job_searching', 'track_application', [
    '输入 `/进度` 随时查看所有投递状态',
    '输入 `/更新 ' + id.slice(-4) + ' 已约面试` 更新进度',
  ]);
  return app;
}

/** 用自然语言更新投递状态（AI 解析） */
export async function updateApplicationStatus(
  chatId: string,
  appId: string,
  naturalLanguage: string,
): Promise<{ app: JobApplication; parsed: string } | null> {
  const apps = getApplications();
  const app = apps.find(a => a.id.endsWith(appId));
  if (!app) return null;

  const parsed = await parseStatusUpdate(naturalLanguage, app);
  if (parsed.status) app.status = parsed.status;
  if (parsed.notes) app.notes = (app.notes ? app.notes + '\n' : '') + parsed.notes;
  if (parsed.nextFollowUp) app.nextFollowUp = parsed.nextFollowUp;
  if (parsed.interview) app.interviews.push(parsed.interview);
  app.updatedAt = Date.now();

  updateApplication(app.id, app);

  if (app.status === 'interview') {
    updatePhase(chatId, 'interviewing', 'update_status', [
      '输入 `/面试准备 ' + app.id.slice(-4) + '` 获取备战资料',
    ]);
  }

  return { app, parsed: parsed.summary };
}

async function parseStatusUpdate(text: string, app: JobApplication): Promise<{
  status?: JobApplication['status'];
  notes?: string;
  nextFollowUp?: string;
  interview?: any;
  summary: string;
}> {
  const client = getDeepSeekClient();
  const prompt = `解析用户的投递状态更新，提取结构化信息。当前投递：${app.company} ${app.title}，状态：${app.status}

返回 JSON：
{
  "status": "applied|phone_screen|interview|offer|rejected|accepted|withdrawn 或 null(不变)",
  "notes": "备注文本",
  "nextFollowUp": "YYYY-MM-DD 下次跟进日期 或 null",
  "interview": { "type": "phone|video|onsite|panel", "scheduledDate": "2026-06-15T14:00" } 或 null,
  "summary": "一句话确认你理解了用户的更新"
}
用户更新：${text}`;

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500, temperature: 0.1,
    });
    const content = response.choices[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { summary: '已更新' };
  } catch {
    return { summary: '已更新' };
  }
}

/** 格式化投递列表 */
export function formatApplications(apps: JobApplication[]): string {
  if (!apps.length) return '📋 暂无投递记录。\n\n输入 `/投递 公司名 岗位名` 开始记录。';

  const statusEmoji: Record<string, string> = {
    applied: '📤', phone_screen: '📞', interview: '🎯',
    offer: '🎉', rejected: '❌', accepted: '✅', withdrawn: '↩️',
  };
  const statusText: Record<string, string> = {
    applied: '已投递', phone_screen: '电话面试', interview: '面试中',
    offer: '已获Offer', rejected: '未通过', accepted: '已接受', withdrawn: '已撤回',
  };

  const lines = [`📋 **投递追踪**（共 ${apps.length} 个）`, ''];

  apps.sort((a, b) => b.updatedAt - a.updatedAt).forEach((app, i) => {
    const shortId = app.id.slice(-4);
    const emoji = statusEmoji[app.status] || '📌';
    const st = statusText[app.status] || app.status;
    lines.push(
      `**${i + 1}.** ${emoji} ${app.company} — ${app.title}`,
      `　　\`${shortId}\` ${st} · ${app.appliedDate}`,
    );
    if (app.interviews.length > 0) {
      const next = app.interviews.find(iv => iv.status === 'scheduled');
      if (next) lines.push(`　　📅 下次面试：${next.scheduledDate} (${next.type})`);
    }
    if (app.nextFollowUp) lines.push(`　　⏰ 建议跟进：${app.nextFollowUp}`);
    lines.push('');
  });

  lines.push('💡 输入 `/更新 [序号] [状态描述]` 更新进度（如 `/更新 1 已约下周二视频面试`）');
  return lines.join('\n');
}

/** 获取逾期未跟进的投递 */
export function getOverdueFollowUps(): JobApplication[] {
  const today = new Date().toISOString().slice(0, 10);
  return getApplications().filter(a => a.nextFollowUp && a.nextFollowUp <= today && a.status !== 'rejected' && a.status !== 'accepted');
}
