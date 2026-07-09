import { getOverdueFollowUps, formatApplications } from './tracker';
import { getApplications } from './store';

// ─── 主动通知引擎 ───

export interface NotificationResult {
  type: string;
  message: string;
  shouldSend: boolean;
}

/** 检查并生成投递跟进提醒 */
export function checkFollowUpReminders(): NotificationResult | null {
  const overdue = getOverdueFollowUps();
  if (!overdue.length) return null;

  const lines = [
    `⏰ **投递跟进提醒**`,
    '',
    `你有 ${overdue.length} 个投递需要跟进：`,
    '',
    ...overdue.map(a =>
      `· ${a.company} — ${a.title}（${a.appliedDate}投递，建议 ${a.nextFollowUp} 前跟进）`
    ),
    '',
    '💡 输入 `/进度` 查看详情并更新状态',
  ];

  return {
    type: 'follow_up',
    message: lines.join('\n'),
    shouldSend: true,
  };
}

/** 生成面试提醒（需提前传入应用的面试列表） */
export function checkInterviewReminders(): NotificationResult | null {
  const apps = getApplications();
  const now = new Date();
  const upcoming: { app: any; interview: any }[] = [];

  for (const app of apps) {
    for (const iv of app.interviews) {
      if (iv.status !== 'scheduled') continue;
      const ivDate = new Date(iv.scheduledDate);
      const hoursUntil = (ivDate.getTime() - now.getTime()) / 3600000;
      // 提前 24 小时提醒
      if (hoursUntil > 0 && hoursUntil <= 24) {
        upcoming.push({ app, interview: iv });
      }
    }
  }

  if (!upcoming.length) return null;

  const lines = [
    `🎯 **面试提醒**`,
    '',
    ...upcoming.map(({ app, interview }) =>
      `· **${app.company}** — ${app.title}\n　　📅 ${interview.scheduledDate}（${interview.type}）`
    ),
    '',
    '💡 输入 `/面试准备 [序号]` 获取备战资料',
  ];

  return {
    type: 'interview',
    message: lines.join('\n'),
    shouldSend: true,
  };
}

/** 生成求职周报 */
export async function generateWeeklyDigest(): Promise<string | null> {
  const apps = getApplications();
  if (!apps.length) return null;

  const byStatus: Record<string, number> = {};
  apps.forEach(a => { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });

  const thisWeek = apps.filter(a => {
    const d = new Date(a.updatedAt);
    const weekAgo = Date.now() - 7 * 86400000;
    return d.getTime() > weekAgo;
  });

  const lines = [
    `📊 **求职周报**`,
    '',
    `📋 总投递：${apps.length} 个`,
    `🆕 本周新增：${thisWeek.length} 个`,
    '',
    '**状态分布：**',
    ...Object.entries(byStatus).map(([s, n]) => {
      const map: Record<string, string> = {
        applied: '📤 已投递', phone_screen: '📞 电话面试', interview: '🎯 面试中',
        offer: '🎉 Offer', rejected: '❌ 未通过', accepted: '✅ 已接受',
      };
      return `· ${map[s] || s}：${n}`;
    }),
    '',
    '💡 输入 `/进度` 查看全部投递详情',
  ];

  return lines.join('\n');
}
