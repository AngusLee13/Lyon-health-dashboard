import { getDailyRecord } from './store';
import { fetchTrains } from '../xunji/client';
import { config } from '../config';
import { DailyRecord } from './types';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface MissingData {
  category: string;
  icon: string;
  items: string[];
  prompt: string;
  canScreenshot: boolean;
}

export interface CheckinResult {
  date: string;
  hasData: boolean;
  missing: MissingData[];
  card: object;
}

export async function runEveningCheckin(dateStr?: string): Promise<CheckinResult> {
  const date = dateStr || today();
  const record = getDailyRecord(date);

  // 检查训记数据
  let hasXunji = false;
  try {
    const result = await fetchTrains(date, config.xunji, true);
    hasXunji = result.items.length > 0;
  } catch { /* 忽略 */ }

  const missing: MissingData[] = [];

  // 睡眠
  const sleep = record?.sleep;
  if (!sleep || !sleep.duration || !sleep.bedTime) {
    missing.push({
      category: '睡眠',
      icon: '😴',
      items: ['入睡时间', '醒来时间', '睡眠质量（差/一般/良好/优秀）', '深睡时长（如有）'],
      prompt: '回复格式：入睡23:30 醒来7:00 质量良好 深睡1.5h',
      canScreenshot: true,
    });
  }

  // 训练（训记无数据时提示）
  if (!hasXunji && !record?.training && !record?.cardio) {
    missing.push({
      category: '训练',
      icon: '🏃',
      items: ['训练部位', '动作+组数+重量+次数', '训练时长/热量'],
      prompt: '截图训记训练记录，或文字描述训练内容',
      canScreenshot: true,
    });
  }

  // 饮食
  const diet = record?.diet;
  const hasMeals = diet && (diet as any).meals?.length > 0;
  const hasDayTotal = diet && (diet as any).dayTotalSoFar?.calories != null;
  if (!hasMeals && !hasDayTotal) {
    missing.push({
      category: '饮食',
      icon: '🍽',
      items: [`早餐 · 午餐 · 晚餐 · 加餐（每餐食物+份量）`],
      prompt: '回复格式：早餐 豆腐脑1碗 鸡蛋1个；午餐 米饭200g 鸡胸150g...\n或截图饮食记录APP',
      canScreenshot: true,
    });
  }

  // 体重
  if (!record?.weight) {
    missing.push({
      category: '体重',
      icon: '⚖️',
      items: ['今日体重（kg）'],
      prompt: '回复格式：体重118.5',
      canScreenshot: false,
    });
  }

  // 步数
  if (!record?.steps) {
    missing.push({
      category: '步数',
      icon: '👣',
      items: ['今日总步数'],
      prompt: '回复格式：步数8500 或直接截图步数APP',
      canScreenshot: true,
    });
  }

  return {
    date,
    hasData: record !== null,
    missing,
    card: buildCheckinCard(date, missing),
  };
}

function buildCheckinCard(date: string, missing: MissingData[]): object {
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][new Date(date).getDay()];

  if (missing.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `✅ ${date} 周${weekDay} 数据已齐全` },
        template: 'green',
      },
      elements: [
        { tag: 'markdown', content: '🎉 今日所有健康数据已记录完毕，明日早9点将推送完整日报。' },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '如有遗漏，随时发送消息补充数据' }] },
      ],
    };
  }

  const sections = missing.map(m => {
    const items = m.items.map(i => `  · ${i}`).join('\n');
    const hint = m.canScreenshot
      ? `📸 可截图识别  ·  ✍️ 可文字回复\n*${m.prompt}*`
      : `✍️ 文字回复\n*${m.prompt}*`;
    return `${m.icon} **${m.category}**\n${items}\n${hint}`;
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 ${date} 周${weekDay} 数据统计` },
      template: 'wathet',
    },
    elements: [
      {
        tag: 'markdown',
        content: `以下 **${missing.length}** 项数据待补充，请逐一回复或直接发送截图：`,
      },
      { tag: 'hr' },
      ...sections.map(s => ({ tag: 'markdown' as const, content: s })),
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: '💡 **提示**：发送训记/睡眠APP截图可自动识别数据；也可直接文字回复，格式不限。',
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `每晚 ${config.eveningCheckin.cronTime.split(' ')[1]}:00 自动统计 · 回复即可补录` }],
      },
    ],
  };
}
