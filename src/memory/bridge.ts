/**
 * 飞书 Bot → Claude Code 记忆桥梁 v2
 *
 * 设计改进：
 *   1. 聚合记忆：每个话题类别只有 1 个文件，新对话追加到末尾，按时间累积
 *   2. 对话搜索引擎：API 端点可查询 sessions.json 完整历史
 *   3. 不再硬限制条数——老内容超过 30 天自动归档为短期摘要
 *
 * Claude Code 加载聚合记忆获得长期画像，需要具体对话时调用搜索 API。
 */

import fs from 'fs';
import path from 'path';

// ─── 配置 ───

const MEMORY_DIR = process.env.CLAUDE_MEMORY_DIR
  || path.resolve(process.env.HOME || process.env.USERPROFILE || __dirname, '../../../../.claude/projects/C--Users-WINDOWS-Downloads-fisrt-cc/memory');

const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

/** 聚合记忆文件定义 */
const AGGREGATE_MEMORIES: Record<string, { name: string; description: string; maxEntries: number }> = {
  health: {
    name: 'feishu-health-log',
    description: '飞书健康对话聚合日志',
    maxEntries: 50,  // 保留最近 50 条摘要
  },
  career: {
    name: 'feishu-career-log',
    description: '飞书求职对话聚合日志',
    maxEntries: 50,
  },
  code: {
    name: 'feishu-code-log',
    description: '飞书代码对话聚合日志',
    maxEntries: 30,
  },
  general: {
    name: 'feishu-general-log',
    description: '飞书通用对话聚合日志',
    maxEntries: 30,
  },
  preference: {
    name: 'feishu-preference',
    description: '飞书 Bot 用户偏好积累',
    maxEntries: 0,  // 偏好文件不限制条数，累积更新
  },
};

// ─── 类型 ───

export interface ConversationTurn {
  timestamp: number;
  chatId: string;
  agentId?: string;
  agentName?: string;
  userMessage: string;
  assistantReply: string;
}

interface LogEntry {
  date: string;
  time: string;
  summary: string;       // 单行摘要
  detail: string;        // 展开内容
}

// ─── 敏感过滤 ───

const SKIP_KEYWORDS = ['密码', 'password', 'token', 'secret', 'api key', 'appSecret'];

function shouldSkip(content: string): boolean {
  const lower = content.toLowerCase();
  return SKIP_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── 摘要提取 ───

/** 生成单行摘要 */
function summarize(userMsg: string, reply: string): string {
  // 截取用户消息前 80 字作为摘要
  const cleaned = userMsg.replace(/\n/g, ' ').trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80) + '…' : cleaned;
}

/** 判断对话属于哪个类别 */
function categorize(turn: ConversationTurn): string[] {
  const cats: string[] = [];
  const combined = `${turn.userMessage} ${turn.assistantReply}`;

  if (turn.agentId === 'health' || turn.agentName?.includes('健康')) cats.push('health');
  if (turn.agentId === 'career' || turn.agentName?.includes('就业') || turn.agentName?.includes('求职')) cats.push('career');
  if (turn.agentId === 'code' || turn.agentName?.includes('代码')) cats.push('code');

  // 通用分类规则
  if (/热量|kcal|碳水|蛋白质|脂肪|早餐|午餐|晚餐|吃了|训练|力量|有氧|睡眠|深睡|体重/.test(combined)) {
    if (!cats.includes('health')) cats.push('health');
  }
  if (/职位|招聘|面试|简历|求职|跳槽|JD|offer|薪资/.test(combined)) {
    if (!cats.includes('career')) cats.push('career');
  }
  if (/代码|编程|bug|报错|函数|API|npm|node|python|java|TypeScript/.test(combined)) {
    if (!cats.includes('code')) cats.push('code');
  }

  // 兜底：不属于专业类别则归入 general
  if (cats.length === 0) cats.push('general');

  return cats;
}

/** 检测用户偏好关键词 */
function detectPreference(userMsg: string): string | null {
  const patterns: [RegExp, string][] = [
    [/太长了|太啰嗦|太长|啰嗦/, '用户希望回复更简洁'],
    [/太短了|太简略|详细点|展开|多说|不够详细/, '用户希望回复更详细'],
    [/不要.*卡片|别用卡片|文字.*就行/, '用户偏好纯文本而非卡片消息'],
    [/用.*英文|English/, '用户希望用英文回复'],
    [/语气.*温柔|温暖|亲切|热情/, '用户偏好热情亲切的回复风格'],
    [/专业.*点|严肃|正式/, '用户希望回复更专业正式'],
    [/快.*点|太慢|速度/, '用户在意响应速度'],
  ];
  for (const [regex, insight] of patterns) {
    if (regex.test(userMsg)) return insight;
  }
  return null;
}

// ─── 聚合记忆文件读写 ───

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读取聚合记忆文件的现有条目 */
function readLogEntries(fileName: string): LogEntry[] {
  const filePath = path.join(MEMORY_DIR, `${fileName}.md`);
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // 从 Markdown 表格中解析条目
    const entries: LogEntry[] = [];
    const lines = content.split('\n');
    let inTable = false;
    for (const line of lines) {
      if (line.startsWith('| 日期 | 时间 | 内容 |')) { inTable = true; continue; }
      if (inTable && line.startsWith('|---')) continue;
      if (inTable && line.startsWith('| ') && line.includes(' | ')) {
        const parts = line.split('|').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 3) {
          entries.push({
            date: parts[0],
            time: parts[1],
            summary: parts[2],
            detail: '',  // detail 不存表格中
          });
        }
      }
      // 表格结束
      if (inTable && !line.startsWith('|')) break;
    }
    return entries;
  } catch {
    return [];
  }
}

/** 追加条目到聚合记忆文件 */
function appendToAggregateLog(category: string, entry: LogEntry): void {
  const config = AGGREGATE_MEMORIES[category];
  if (!config) return;

  ensureDir(MEMORY_DIR);
  const filePath = path.join(MEMORY_DIR, `${config.name}.md`);

  // 读取现有条目
  let entries = readLogEntries(config.name);
  // 去重：同日期+相似摘要跳过
  const isDuplicate = entries.some(e => e.date === entry.date && e.summary === entry.summary);
  if (isDuplicate) return;

  // 追加到开头（最新在前）
  entries.unshift(entry);

  // 限制条目数
  const max = config.maxEntries;
  if (max > 0 && entries.length > max) {
    // 老条目压缩为一条归档摘要
    const oldEntries = entries.slice(max);
    const archivedSummary = `*(共 ${oldEntries.length} 条旧记录已归档，日期范围 ${oldEntries[oldEntries.length - 1].date} ~ ${oldEntries[0].date})*`;
    entries = entries.slice(0, max);
    entries.push({
      date: '···',
      time: '',
      summary: archivedSummary,
      detail: '',
    });
  }

  // 写入文件
  const lines: string[] = [
    `---`,
    `name: ${config.name}`,
    `description: ${config.description}`,
    `metadata:`,
    `  type: reference`,
    `  source: feishu-bot`,
    `  updatedAt: ${new Date().toISOString()}`,
    `---`,
    ``,
    `# ${config.description}`,
    ``,
    `> 以下为飞书 Bot 对话的自动聚合日志。每行一条对话摘要。`,
    `> CLAUDE CODE：如果需要查看某条对话的完整内容，请调用 \`/api/memory/search\` 接口。`,
    ``,
    `| 日期 | 时间 | 内容 |`,
    `|------|------|------|`,
  ];

  for (const e of entries) {
    lines.push(`| ${e.date} | ${e.time} | ${e.summary} |`);
  }

  lines.push('');
  lines.push(`---`);
  lines.push(`*最后更新时间：${new Date().toLocaleString('zh-CN')}*`);

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  console.log(`[记忆桥梁] 已更新聚合日志: ${config.name} (${entries.length} 条)`);
}

/** 追加偏好到偏好文件（累积不覆盖） */
function appendPreference(insight: string): void {
  ensureDir(MEMORY_DIR);
  const config = AGGREGATE_MEMORIES['preference'];
  const filePath = path.join(MEMORY_DIR, `${config.name}.md`);

  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  // 去重
  if (content.includes(insight)) return;

  const newLine = `- ${new Date().toISOString().slice(0, 10)} — ${insight}`;
  if (!content) {
    // 首次创建
    content = `---
name: ${config.name}
description: ${config.description}
metadata:
  type: user
  source: feishu-bot
  updatedAt: ${new Date().toISOString()}
---

# ${config.description}

> 以下偏好从飞书 Bot 对话中自动提取，持续累积。CLAUDE CODE 在回复风格和功能设计时应参考此文件。

## 已识别的偏好

${newLine}
`;
  } else {
    // 追加到偏好列表末尾
    content = content.replace(/\n$/, '');
    content += `\n${newLine}\n`;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`[记忆桥梁] 已追加偏好: ${insight}`);
}

/** 更新 MEMORY.md 索引 */
function ensureIndexEntry(fileName: string, description: string): void {
  ensureDir(MEMORY_DIR);

  try {
    let indexContent = '';
    if (fs.existsSync(MEMORY_INDEX)) {
      indexContent = fs.readFileSync(MEMORY_INDEX, 'utf-8');
    }
    if (indexContent.includes(`${fileName}.md`)) return;
    if (!indexContent.endsWith('\n') && indexContent.length > 0) indexContent += '\n';
    indexContent += `- [${description}](${fileName}.md) — 飞书Bot自动同步\n`;
    fs.writeFileSync(MEMORY_INDEX, indexContent, 'utf-8');
  } catch (err: any) {
    console.warn(`[记忆桥梁] 更新索引失败: ${err.message}`);
  }
}

// ─── 对话搜索 ───

const SESSIONS_PATH = path.resolve(__dirname, '../../data/sessions.json');

export interface SearchResult {
  chatId: string;
  timestamp: number;
  date: string;
  role: 'user' | 'assistant';
  content: string;
}

/** 搜索历史对话 */
export function searchConversations(options: {
  keyword?: string;
  agentId?: string;
  days?: number;
  limit?: number;
}): SearchResult[] {
  const { keyword, days = 30, limit = 20 } = options;

  try {
    if (!fs.existsSync(SESSIONS_PATH)) return [];
    const raw = fs.readFileSync(SESSIONS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const messages: Record<string, any[]> = data.messages || {};

    const results: SearchResult[] = [];
    const cutoff = Date.now() - days * 86400000;

    for (const [chatId, msgs] of Object.entries(messages)) {
      if (!Array.isArray(msgs)) continue;
      for (const msg of msgs) {
        if (msg.created_at < cutoff) continue;
        if (keyword) {
          const lowerContent = (msg.content || '').toLowerCase();
          const lowerKeyword = keyword.toLowerCase();
          if (!lowerContent.includes(lowerKeyword)) continue;
        }
        results.push({
          chatId,
          timestamp: msg.created_at,
          date: new Date(msg.created_at).toISOString(),
          role: msg.role,
          content: msg.content || '',
        });
      }
    }

    // 按时间倒序，限制数量
    return results
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  } catch (err: any) {
    console.warn(`[记忆桥梁] 搜索对话失败: ${err.message}`);
    return [];
  }
}

// ─── 公开接口 ───

/** 保存一轮飞书对话（v2 聚合模式） */
export function saveConversationMemory(turn: ConversationTurn): void {
  try {
    if (turn.userMessage.length < 5 && turn.assistantReply.length < 20) return;
    if (turn.userMessage.startsWith('/')) return;
    if (shouldSkip(`${turn.userMessage}\n${turn.assistantReply}`)) return;

    const categories = categorize(turn);
    const now = new Date(turn.timestamp);
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16);
    const summary = summarize(turn.userMessage, turn.assistantReply);
    const detail = turn.userMessage.slice(0, 300);

    // 为每个匹配类别追加聚合日志
    for (const cat of categories) {
      appendToAggregateLog(cat, {
        date: dateStr,
        time: timeStr,
        summary,
        detail,
      });
      const config = AGGREGATE_MEMORIES[cat];
      if (config) ensureIndexEntry(config.name, config.description);
    }

    // 检测并追加用户偏好
    const preference = detectPreference(turn.userMessage);
    if (preference) {
      appendPreference(preference);
      const prefConfig = AGGREGATE_MEMORIES['preference'];
      ensureIndexEntry(prefConfig.name, prefConfig.description);
    }

    console.log(`[记忆桥梁] 已同步到 ${categories.join(', ')} (${summary})`);
  } catch (err: any) {
    console.warn(`[记忆桥梁] 异常: ${err.message}`);
  }
}
