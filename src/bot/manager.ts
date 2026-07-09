import fs from 'fs';
import path from 'path';
import { BotConfig, BotsFile, BotRole } from './types';
import { BotInstance } from './botInstance';
import { SessionStore } from '../session/store';
import { recognizeHealthImage } from '../health/imageRecognition';
import { saveRecognizedData } from '../health/imageRecognition';
import { addPendingImage, removePendingImage, updatePendingRetries, listPendingImages, dropExpiredPending, MAX_RETRIES as PENDING_MAX_RETRIES } from '../health/pendingQueue';
import { fetchAndFormatTraining, fetchHealthData, parseAndSaveHealthText } from '../health/service';
import { buildDailyReport } from '../health/reportGenerator';
import { buildDailySentinelReport } from '../sentinel/reportBuilder';
import { listFoods } from '../health/foodLibrary';
import { downloadFeishuFile, extractPdfText, extractResumeDataFromChat, generateAndSendResume } from '../career/pdfService';
import { analyzeResume, formatAnalysisCard } from '../career/analyzer';
import { searchJobs, formatJobListings, matchResumeToJob, formatMatchResult, quickResumeSummary, JobListing } from '../career/jobSearch';
import { trackApplication, updateApplicationStatus, formatApplications, getOverdueFollowUps } from '../career/tracker';
import { tailorResumeToJD, formatTailorResult } from '../career/tailor';
import { analyzeSkillsGap, formatSkillsGap } from '../career/skillsGap';
import { getWorkflowState, updatePhase, getWelcomeBackContext, saveWorkflowState } from '../career/workflowState';
import { getApplications } from '../career/store';
import { config } from '../config';
import { MessageSender, FeishuMessageItem } from '../feishu/messageSender';

/** 职位搜索结果缓存（chatId → 职位列表） */
const jobCache: Map<string, JobListing[]> = new Map();

/** 解析命令参数（按空格分割，跳过命令本身） */
function parseCommandArgs(text: string): string[] {
  const parts = text.trim().split(/\s+/);
  return parts.slice(1);
}

/** 简单字符串哈希（djb2 算法），用于内容去重 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * 内容去重缓存：防止离线消息拉取和 WebSocket 实时推送重复处理相同内容。
 * key = `${chatId}::${contentHash}`，value = 处理时间戳
 * TTL = 2 分钟（超过后认为不重复）
 */
const CONTENT_DEDUP_TTL = 120_000; // 2 分钟

/** 多 Bot 管理器：负责所有 Bot 的生命周期和消息路由 */
export class BotManager {
  private bots: Map<string, BotInstance> = new Map();
  private store: SessionStore;
  private routerBot: BotInstance | null = null;
  /** 内容级去重缓存：chatId::contentHash → 处理时间戳 */
  private recentContentCache: Map<string, number> = new Map();
  /** 内容缓存定时清理器 */
  private contentCacheCleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.store = new SessionStore(path.resolve(__dirname, '../../data/sessions.json'));
    // 每 5 分钟清理过期内容缓存
    this.contentCacheCleanupTimer = setInterval(() => {
      this.cleanupContentCache();
    }, 300_000);
  }

  /** 检查并标记内容是否最近已处理（内容级去重） */
  private checkAndMarkContent(chatId: string, textContent: string): boolean {
    // 提取内容关键词用于去重（取前 200 字符做 hash，足够区分不同消息）
    const key = textContent.trim().substring(0, 200).toLowerCase();
    const hash = `${chatId}::${simpleHash(key)}`;
    const now = Date.now();
    const lastTime = this.recentContentCache.get(hash);

    if (lastTime && (now - lastTime) < CONTENT_DEDUP_TTL) {
      console.log(`[内容去重] 相同内容 ${lastTime ? ((now - lastTime) / 1000).toFixed(1) + 's' : ''} 前已处理，跳过 chatId=${chatId} text="${key.substring(0, 50)}"`);
      return true; // 重复
    }

    this.recentContentCache.set(hash, now);
    return false; // 不重复
  }

  /** 清理过期的内容缓存条目 */
  private cleanupContentCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, timestamp] of this.recentContentCache) {
      if (now - timestamp > CONTENT_DEDUP_TTL * 2) {
        this.recentContentCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[内容去重] 清理 ${cleaned} 条过期缓存`);
    }
  }

  /** 加载配置并初始化所有 Bot */
  async initialize(): Promise<void> {
    const configPath = path.resolve(__dirname, '../../bots.json');
    let raw = fs.readFileSync(configPath, 'utf-8');
    // 去除 UTF-8 BOM（某些编辑器会在文件开头添加）
    if (raw.charCodeAt(0) === 0xFEFF) { raw = raw.slice(1); }
    const { bots } = JSON.parse(raw) as BotsFile;

    for (const cfg of bots) {
      const instance = new BotInstance(cfg, this.store);
      this.bots.set(cfg.id, instance);

      if (cfg.role === 'router' && instance.isValid) {
        this.routerBot = instance;
      }
    }

    if (!this.routerBot) {
      console.warn('[BotManager] 警告：没有有效的路由 Bot，将使用第一个可用 Bot');
      for (const bot of this.bots.values()) {
        if (bot.isValid) { this.routerBot = bot; break; }
      }
    }

    console.log(`[BotManager] 已加载 ${this.bots.size} 个 Bot 配置`);
    for (const [id, bot] of this.bots) {
      const status = bot.isValid ? '✅ 已连接' : '⏳ 虚拟Agent（等待凭据）';
      console.log(`  - ${id} (${bot.name}): ${status}`);
    }
  }

  /** 启动所有 Bot 的 WebSocket 连接 */
  async startAll(): Promise<void> {
    for (const [, bot] of this.bots) {
      if (bot.isValid) {
        await bot.start(
          (botId, data) => this.handleMessage(botId, data),
          (botId, chatId, messageId, imageKey) => this.handleImage(botId, chatId, messageId, imageKey),
        );
      }
    }
  }

  /**
   * 开机后拉取离线期间错过的消息
   * 使用飞书 REST API 拉取自上次活跃时间以来的消息并逐条处理
   *
   * 关键：飞书 im.message.list API 要求使用对应 Bot 的凭据才能拉取该 Bot 所在会话的消息。
   * 因此需要遍历所有有效 Bot，用各自凭据分别拉取，而不是只用路由 Bot 的凭据。
   *
   * 性能优化：离线消息使用异步 fire-and-forget 模式处理，不阻塞拉取循环。
   * 每条消息独立处理，并发数受 Bot 实例限制。同时通过内容去重缓存防止
   * 离线拉取和 WebSocket 实时推送重复处理相同内容的数据。
   */
  async pullOfflineMessages(): Promise<void> {
    const lastActiveAt = this.store.getLastActiveAt();
    const chatIds = this.store.getAllChatIds();

    if (chatIds.length === 0) {
      console.log('[离线拉取] 暂无已知会话，跳过离线消息拉取');
      this.store.updateLastActiveAt();
      return;
    }

    // 加 60 秒缓冲，防止时钟偏差导致漏消息
    const startTime = lastActiveAt > 0 ? lastActiveAt - 60_000 : Date.now() - 300_000;

    // 如果上次活跃时间在 5 分钟以内，说明是短暂重启，可能没有离线消息
    if (Date.now() - lastActiveAt < 300_000 && lastActiveAt > 0) {
      console.log(`[离线拉取] 上次活跃时间 ${new Date(lastActiveAt).toLocaleString('zh-CN')}，距现在不足 5 分钟，快速检查...`);
    }

    console.log(`[离线拉取] 开始拉取 ${chatIds.length} 个会话的离线消息（${new Date(startTime).toLocaleString('zh-CN')} → 现在）`);
    console.log(`[离线拉取] 有效 Bot 数量: ${[...this.bots.values()].filter(b => b.isValid).length}`);

    let totalDispatched = 0;
    // 记录已处理的 chatId，避免多个 Bot 重复拉取同一会话
    const processedChatIds = new Set<string>();

    // 遍历所有有效 Bot，用各自凭据拉取消息
    for (const [botId, bot] of this.bots) {
      if (!bot.isValid) {
        console.log(`[离线拉取] Bot「${bot.name}」(${botId}) 凭据无效，跳过`);
        continue;
      }

      const sender = new MessageSender(bot.config.appId, bot.config.appSecret);

      for (const chatId of chatIds) {
        // 如果该会话已被其他 Bot 拉取过，跳过（一个会话只属于一个 Bot）
        if (processedChatIds.has(chatId)) {
          continue;
        }

        let messages: FeishuMessageItem[] = [];
        try {
          messages = await sender.fetchMessages(chatId, startTime, 50);
        } catch (err: any) {
          // 此 Bot 可能不在该会话中，这是正常的
          console.log(`[离线拉取] Bot「${bot.name}」无法访问会话 ${chatId}（可能不属于该 Bot），尝试下一个`);
          continue;
        }

        if (messages.length === 0) {
          // 无消息可能是 Bot 不在此会话中，也可能是确实没有离线消息
          continue;
        }

        // 成功拉取到消息，说明此 Bot 在该会话中
        processedChatIds.add(chatId);
        console.log(`[离线拉取] Bot「${bot.name}」(${botId}) 会话 ${chatId}: 拉取到 ${messages.length} 条消息`);

        for (const msg of messages) {
          // 跳过已处理的消息（messageId 级别去重）
          if (this.store.isDuplicateMessage(msg.message_id)) {
            continue;
          }

          // 跳过机器人自己的消息和系统消息
          if (!msg.msg_type || msg.msg_type === 'system') {
            continue;
          }

          console.log(`[离线拉取] 派发离线消息: ${msg.message_id} type=${msg.msg_type} bot=${botId}`);

          // 跳过机器人自己发送的消息（sender_type === 'app'，用户消息为 'user'）
          if (msg.sender_type === 'app') {
            console.log(`[离线拉取] 跳过机器人消息: ${msg.message_id}`);
            // 标记为已处理防止后续重复拉取
            this.store.markMessageProcessed(msg.message_id);
            continue;
          }

          // 转换为 WebSocket 事件格式，复用现有处理逻辑
          // 保留消息的原始时间戳，用于离线数据匹配到正确的日期
          const eventData = {
            message: {
              message_id: msg.message_id,
              chat_id: msg.chat_id,
              message_type: msg.msg_type,
              chat_type: msg.chat_type || 'p2p',  // 使用 API 返回的真实 chat_type，而非硬编码
              content: msg.body?.content || '{}',
              create_time: msg.create_time,       // 原始消息时间戳（秒级字符串）
            },
          };

          // 🔥 关键优化：fire-and-forget 异步处理，不阻塞拉取循环
          // 每条离线消息独立处理，互不等待。如果某条消息已被 WebSocket 实时处理过，
          // handleMessage 内部的内容去重会跳过它。
          this.handleMessage(botId, eventData)
            .then(() => {
              console.log(`[离线拉取] 消息处理完成: ${msg.message_id}`);
            })
            .catch((err: any) => {
              console.error(`[离线拉取] 处理离线消息失败 ${msg.message_id}:`, err.message);
            });
          totalDispatched++;
        }
      }
    }

    // 报告未被任何 Bot 覆盖的会话
    const uncoveredChatIds = chatIds.filter(id => !processedChatIds.has(id));
    if (uncoveredChatIds.length > 0) {
      console.log(`[离线拉取] ⚠️ ${uncoveredChatIds.length} 个会话未被任何 Bot 覆盖: ${uncoveredChatIds.join(', ')}`);
    }

    // 拉取完成后更新活跃时间
    this.store.updateLastActiveAt();
    console.log(`[离线拉取] 完成，共派发 ${totalDispatched} 条离线消息（异步处理中），覆盖 ${processedChatIds.size}/${chatIds.length} 个会话`);
  }

  /** 从消息 create_time 推导日期字符串 YYYY-MM-DD（用于离线消息匹配正确日期） */
  private messageDate(message: any): string {
    const ts = message?.create_time;
    if (!ts) return new Date().toISOString().slice(0, 10);
    // 飞书 API 返回毫秒级字符串，WebSocket 事件可能是数字
    const ms = typeof ts === 'string' ? parseInt(ts, 10) : ts;
    // 合理性校验：时间戳必须是合理范围（2024-2030 年之间）
    const MIN_TS = 1704067200000; // 2024-01-01
    const MAX_TS = 1893456000000; // 2030-01-01
    if (isNaN(ms) || ms < MIN_TS || ms > MAX_TS) {
      return new Date().toISOString().slice(0, 10);
    }
    return new Date(ms).toISOString().slice(0, 10);
  }

  /** 处理收到的消息事件 */
  private async handleMessage(botId: string, eventData: any): Promise<void> {
    console.log(`[MSG-IN] botId=${botId} msgType=${eventData?.message?.message_type} chatType=${eventData?.message?.chat_type}`);

    const bot = this.bots.get(botId);
    if (!bot) { console.log('[MSG-IN] bot not found'); return; }

    const message = eventData.message;
    if (!message) { console.log('[MSG-IN] no message'); return; }

    const chatId = message.chat_id;
    const messageId = message.message_id;
    const chatType = message.chat_type || 'p2p';
    // 消息原始日期（离线消息用原始时间戳，实时消息回退到今天）
    const msgDate = this.messageDate(message);

    if (chatType === 'bot') { console.log('[MSG-IN] bot message ignored'); return; }

    if (await bot.sessionManager.isDuplicate(messageId)) { console.log('[MSG-IN] duplicate'); return; }
    await bot.sessionManager.markProcessed(messageId);

    // 确保会话已创建并更新活跃时间（无论消息类型，都需记录会话以便开机后拉取离线消息）
    await bot.sessionManager.getOrCreate(chatId, chatType);
    this.store.touchSession(chatId);

    // 更新服务器最后活跃时间（用于开机后离线消息拉取）
    this.store.updateLastActiveAt();

    // 图片消息
    if (message.message_type === 'image') {
      await this.handleImage(botId, chatId, messageId, message);
      return;
    }

    // 文件消息（PDF 等）
    if (message.message_type === 'file') {
      await this.handleFile(botId, chatId, messageId, message);
      return;
    }

    // 解析文本（支持 text 和 post 两种消息类型）
    let textContent = '';
    let postImageKey: string | null = null;
    try {
      const content = typeof message.content === 'string'
        ? JSON.parse(message.content)
        : message.content;

      if (message.message_type === 'post') {
        // post 类型：从富文本结构中提取所有文字和图片
        const paragraphs = content.content || [];
        const textParts: string[] = [];
        for (const paragraph of paragraphs) {
          for (const element of paragraph) {
            if (typeof element === 'object' && element !== null) {
              if (element.tag === 'text') {
                textParts.push(element.text || '');
              } else if (element.tag === 'img' && element.image_key) {
                postImageKey = element.image_key;
              }
            }
          }
        }
        textContent = textParts.join('');
      } else {
        // text 类型（也兼容其他类型）
        textContent = content.text || '';
      }
    } catch (err) {
      console.error('[DEBUG] 解析消息内容失败:', err);
      return;
    }

    // 若 post 消息中含图片，走图片处理
    if (message.message_type === 'post' && postImageKey && !textContent.trim()) {
      await this.handleImage(botId, chatId, messageId, { content: JSON.stringify({ image_key: postImageKey }) });
      return;
    }

    // post 消息中含图片+文字：先处理图片，再处理文字
    if (message.message_type === 'post' && postImageKey) {
      await this.handleImage(botId, chatId, messageId, { content: JSON.stringify({ image_key: postImageKey }) });
      // 如果附带文字为"补充："/"修正："等前缀则处理健康数据
      const capMatch = textContent.trim().match(/^(补充|修正|更正|修改)[：:]\s*/);
      const stripped = capMatch ? textContent.trim().slice(capMatch[0].length).trim() : textContent.trim();
      const isImageCorrection = capMatch ? capMatch[1] !== '补充' : false;
      if (capMatch && stripped) {
        const replyBot = bot.isValid ? bot : (this.routerBot || bot);
        const dateMatch = stripped.match(/^(\d{4}-\d{2}-\d{2})\s+/);
        let targetDate: string;
        let dataText = stripped;
        if (dateMatch) {
          targetDate = dateMatch[1];
          dataText = stripped.slice(dateMatch[0].length).trim();
        } else {
          targetDate = msgDate;
        }
        const actionText = isImageCorrection ? '修正' : '补充';
        await replyBot.sendText(chatId, `📝 正在解析${actionText}数据 → ${targetDate}...`);
        const result = await parseAndSaveHealthText(targetDate, dataText, config, { isCorrection: isImageCorrection });
        if (result.error) {
          await replyBot.sendText(chatId, `❌ ${result.error}`);
        } else {
          await replyBot.sendText(chatId, `✅ 已${actionText} ${result.savedItems.join('、')} 到 ${targetDate}`);
        }
        return;
      }
      if (!textContent.trim() || !capMatch && !stripped) return;
      // 非"补充："开头的文字，继续走下面的命令/对话流程
    }

    if (!textContent.trim()) return;

    console.log(`[MSG-TEXT] botId=${botId} text="${textContent.trim().substring(0, 80)}"`);

    // 内容级去重：防止离线拉取和 WebSocket 实时推送重复处理相同内容
    if (this.checkAndMarkContent(chatId, textContent)) {
      return; // 相同内容最近已处理过，跳过
    }

    // 系统命令（/help /reset /clear /status /chatid）
    const sysResult = await handleSystemCommand(textContent.trim(), chatId, bot);
    if (sysResult) return;

    // 健康数据补充/修正
    // 统一匹配：关键词(补充/修正/更正/修改) + 可选分隔符(冒号/空格) + 内容
    // 支持格式：补充：早餐 xxx / 修正：晚餐 xxx / 修正晚餐：xxx / 修改 晚餐 xxx
    const trimmedText = textContent.trim();
    const healthMatch = trimmedText.match(/^(补充|修正|更正|修改)\s*[：:]?\s*(.+)$/);
    console.log(`[DEBUG] 健康前缀匹配: text="${trimmedText.substring(0, 50)}" match=${healthMatch ? `keyword=${healthMatch[1]} dataText="${healthMatch[2].substring(0, 30)}"` : 'null'}`);

    if (healthMatch) {
      const keyword = healthMatch[1];
      let dataText = healthMatch[2];
      if (!dataText) return;

      // 如果是"修正"/"更正"/"修改"但没有冒号分隔，保留关键词让 AI 看到
      const isCorrection = keyword !== '补充';
      if (isCorrection && !/^[：:]/.test(healthMatch[0].replace(keyword, ''))) {
        dataText = keyword + ' ' + dataText;
      }

      const replyBot = bot.isValid ? bot : (this.routerBot || bot);
      // 解析日期：支持 YYYY-MM-DD / 6月15日 / 6.15 / 6-15 等写法
      let dateStr = dataText;
      let targetDate: string;
      // 完整 ISO：2026-06-15
      const isoMatch = dateStr.match(/^(\d{4}-\d{2}-\d{2})\s*/);
      if (isoMatch) {
        targetDate = isoMatch[1];
        dateStr = dateStr.slice(isoMatch[0].length).trim();
      } else {
        // 中文日期：6月15日 / 6月15 / 06月15日
        const cnMatch = dateStr.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*/);
        // 简写日期：6.15 / 06.15 / 6-15（允许日期后直接跟中文，如"6.16早餐"）
        const shortMatch = !cnMatch ? dateStr.match(/^(\d{1,2})[.\-](\d{1,2})\s*/) : null;
        if (cnMatch || shortMatch) {
          const m = cnMatch || shortMatch!;
          const month = parseInt(m[1], 10);
          const day = parseInt(m[2], 10);
          const now = new Date();
          const year = now.getFullYear();
          // 如果月份比当前月小很多（如当前12月，输入1月），视为明年
          const useYear = (now.getMonth() + 1 > 9 && month <= 3) ? year + 1 : year;
          targetDate = `${useYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          dateStr = dateStr.slice(m[0].length).trim();
        } else {
          // 离线消息用原始时间戳推断日期，实时消息回退到今天
          targetDate = msgDate;
        }
      }
      dataText = dateStr;

      const actionText = isCorrection ? '修正' : '补充';
      console.log(`[健康数据] 路由到 parseAndSaveHealthText keyword=${keyword} isCorrection=${isCorrection} targetDate=${targetDate} dataText="${dataText.substring(0, 60)}"`);
      await replyBot.sendText(chatId, `📝 正在解析${actionText}数据 → ${targetDate}...`);
      const result = await parseAndSaveHealthText(targetDate, dataText, config, { isCorrection });
      if (result.error) {
        await replyBot.sendText(chatId, `❌ ${result.error}`);
      } else {
        await replyBot.sendText(chatId, `✅ 已${actionText} ${result.savedItems.join('、')} 到 ${targetDate}`);
      }
      return;
    }

    // 训练数据查询（/训练 无参数、/今日训练、指定日期等）
    const trainingDate = matchTrainingQuery(textContent.trim());
    if (trainingDate !== null) {
      const replyBot = bot.isValid ? bot : (this.routerBot || bot);
      await replyBot.sendText(chatId, '🔍 正在查询训练数据...');
      const formatted = await fetchAndFormatTraining(trainingDate, config);
      await replyBot.sendText(chatId, formatted);
      return;
    }

    // 仅路由 Bot 支持命令分发
    if (bot.role === 'router') {
      const routed = await this.tryRoute(bot, chatId, chatType, messageId, textContent.trim());
      if (routed) return;
    }

    // 默认：当前 Bot 自身处理
    await this.processWithBot(bot, chatId, chatType, messageId, textContent.trim());
  }

  /** 尝试将消息路由到子 Agent */
  private async tryRoute(
    routerBot: BotInstance,
    chatId: string,
    chatType: string,
    messageId: string,
    text: string,
  ): Promise<boolean> {
    // 命令模式：/健康 内容 或 /health 内容
    const routeMap: Record<string, string> = {
      '/健康': 'health', '/health': 'health', '/教练': 'health', '/coach': 'health',
      '/饮食': 'health', '/diet': 'health',
      '/训练': 'health', '/train': 'health', '/睡眠': 'health', '/sleep': 'health',
      '/体重': 'health', '/weight': 'health',
      '/代码': 'code', '/code': 'code', '/编程': 'code', '/dev': 'code',
      '/求职': 'career', '/career': 'career', '/简历': 'career', '/resume': 'career',
      '/面试': 'career', '/interview': 'career', '/就业': 'career', '/job': 'career',
      '/风险': 'career', '/risk': 'career',
    };

    for (const [prefix, targetId] of Object.entries(routeMap)) {
      if (text.toLowerCase().startsWith(prefix.toLowerCase() + ' ') || text.toLowerCase() === prefix.toLowerCase()) {
        let content = text.slice(prefix.length).trim();
        if (!content) {
          await routerBot.sendText(chatId, `请提供内容，例如：\`${prefix} 帮我写一个排序函数\``);
          return true;
        }
        const targetBot = this.bots.get(targetId);
        if (targetBot) {
          await this.routeToBot(routerBot, targetBot, chatId, chatType, messageId, content);
          return true;
        }
      }
    }

    // 也检查仅命令词（如 /code 无参数时）
    return false;
  }

  /** 路由到目标 Bot */
  private async routeToBot(
    routerBot: BotInstance,
    targetBot: BotInstance,
    chatId: string,
    chatType: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    await routerBot.sendText(chatId, `🔀 已分发到「${targetBot.name}」处理中...`);

    if (targetBot.isValid) {
      // 子 Bot 有真实凭据，用自身身份回复
      await this.processWithBot(targetBot, chatId, chatType, messageId, content, targetBot.name);
    } else {
      // 子 Bot 无真实凭据，用主 Bot 身份回复但带名称前缀
      await this.processWithBot(targetBot, chatId, chatType, messageId, content, targetBot.name);
    }
  }

  /** 用指定 Bot 处理消息并发送回复 */
  private async processWithBot(
    bot: BotInstance,
    chatId: string,
    chatType: string,
    messageId: string,
    content: string,
    replyAsName?: string,
  ): Promise<void> {
    // 发送回复的实际 Bot：如果子 Bot 有效用子 Bot，否则用路由 Bot
    const replyBot = (bot.isValid && bot.id !== 'main') ? bot : (this.routerBot || bot);

    // 构建上下文：仅健康 Bot 注入健康数据，避免其他 Bot 串信息
    const isHealthBot = bot.id === 'health' || bot.name?.includes('健康');
    const injectContext = isHealthBot ? await buildHealthContext() : undefined;

    await bot.processTextMessage({
      chatId, chatType, messageId, content,
      onComplete: async (text: string) => {
        if (bot.isValid && bot.id !== 'main') {
          await bot.sendText(chatId, text);
        } else if (replyAsName) {
          await replyBot.sendText(chatId, text, replyAsName);
        } else {
          await replyBot.sendText(chatId, text);
        }
      },
      onError: async (error: string) => {
        await replyBot.sendText(chatId, `❌ ${error}`, replyAsName);
      },
    }, injectContext);
  }

  /** 处理文件消息（PDF 等） */
  private async handleFile(
    botId: string,
    chatId: string,
    messageId: string,
    message: any,
  ): Promise<void> {
    const bot = this.bots.get(botId) || this.routerBot;
    if (!bot) return;

    try {
      const fileContent = typeof message.content === 'string'
        ? JSON.parse(message.content)
        : message.content;
      const fileKey = fileContent.file_key;
      const fileName = fileContent.file_name || '';

      if (!fileKey) return;

      // 仅处理 PDF 文件
      if (!fileName.toLowerCase().endsWith('.pdf')) {
        const replyBot = bot.isValid ? bot : (this.routerBot || bot);
        await replyBot.sendText(chatId, '📎 暂不支持此文件类型，请发送 PDF 格式的简历文件。');
        return;
      }

      const replyBot = bot.isValid ? bot : (this.routerBot || bot);
      await replyBot.sendText(chatId, '📄 正在解析 PDF 文件...');

      console.log(`[BotManager] 下载文件: ${fileName} (fileKey=${fileKey})`);
      const { buffer } = await downloadFeishuFile(messageId, fileKey, bot.config.appId, bot.config.appSecret);
      console.log(`[BotManager] PDF 下载完成，大小: ${buffer.length} bytes`);

      const pdfText = await extractPdfText(buffer);
      console.log(`[BotManager] PDF 文本提取完成，长度: ${pdfText.length}`);

      if (!pdfText.trim()) {
        await replyBot.sendText(chatId, '❌ PDF 中未提取到文字内容，请确认文件是否为文字型 PDF（非扫描件）。');
        return;
      }

      // 将 PDF 内容路由到就业指导 Bot
      const careerBot = this.bots.get('career');
      if (careerBot) {
        const prompt = `用户上传了简历 PDF 文件「${fileName}」，以下是提取的文字内容，请帮助分析优化：\n\n${pdfText.substring(0, 6000)}`;
        await this.processWithBot(careerBot, chatId, 'p2p', messageId, prompt, careerBot.name);
      } else {
        await replyBot.sendText(chatId, '❌ 就业指导 Bot 未配置，请联系管理员。');
      }
    } catch (err: any) {
      console.error('[BotManager] PDF 处理异常:', err.message);
      const replyBot = bot.isValid ? bot : (this.routerBot || bot);
      await replyBot.sendText(chatId, `❌ PDF 处理失败: ${err.message}`);
    }
  }

  /** 处理图片消息 */
  private async handleImage(
    botId: string,
    chatId: string,
    messageId: string,
    message: any,
  ): Promise<void> {
    const bot = this.bots.get(botId) || this.routerBot;
    if (!bot) return;

    const imageContent = typeof message.content === 'string'
      ? JSON.parse(message.content)
      : message.content;
    const imageKey = imageContent.image_key;
    if (!imageKey) return;

    const replyBot = bot.isValid ? bot : (this.routerBot || bot);
    const imgDate = this.messageDate(message);

    // 🔒 防丢：OCR 开始前将图片元数据持久化到待处理队列
    // 如果处理过程中 Bot 重启，启动后会重新处理队列中的图片
    addPendingImage({
      messageId,
      imageKey,
      chatId,
      botId,
      date: imgDate,
      retries: 0,
      receivedAt: Date.now(),
    });

    try {
      console.log(`[BotManager] 开始图片识别: messageId=${messageId}, imageKey=${imageKey}`);
      const result = await recognizeHealthImage(messageId, imageKey);
      console.log(`[BotManager] 图片识别结果: success=${result.success}, nutritionLabel=${!!result.nutritionLabel}, error=${result.error || 'none'}`);

      // 营养成分表识别结果
      if (result.nutritionLabel?.success) {
        await replyBot.sendText(chatId, result.nutritionLabel.message);
        removePendingImage(messageId);  // 处理成功，移出队列
        return;
      }

      if (result.success) {
        const msg = await saveRecognizedData(imgDate, result);
        console.log(`[BotManager] 数据保存结果: ${msg} (日期=${imgDate})`);
        await replyBot.sendText(chatId, `✅ ${msg}`);
        removePendingImage(messageId);  // 处理成功，移出队列
      } else {
        // AI 返回了明确的错误（非临时性），移出队列避免无限重试
        await replyBot.sendText(chatId, `❌ ${result.error || '识别失败'}${result.nutritionLabel?.error ? '\n💡 营养成分识别也未成功：' + result.nutritionLabel.error : ''}`);
        removePendingImage(messageId);
      }
    } catch (err: any) {
      // ⚠️ 异常（网络错误/进程重启等临时故障）：保留在队列中，下次启动自动重试
      console.error(`[BotManager] 图片识别异常(将自动重试): ${err.message}`);
      const replyBot = bot.isValid ? bot : (this.routerBot || bot);
      await replyBot.sendText(chatId, `❌ 图片处理异常: ${err.message}\n💡 系统恢复后将自动重新处理`);
    }
  }

  /** 启动后处理待处理图片队列（由 index.ts 在 Bot 就绪后调用） */
  async processPendingImages(): Promise<void> {
    // 先清理超过最大重试次数的过期项
    dropExpiredPending();

    const pending = listPendingImages();
    if (pending.length === 0) {
      console.log('[待处理队列] 无待处理图片');
      return;
    }

    console.log(`[待处理队列] 📬 发现 ${pending.length} 个待处理图片，开始处理...`);

    for (const record of pending) {
      if (record.retries >= PENDING_MAX_RETRIES) {
        console.warn(`[待处理队列] 🗑 ${record.messageId} 已达最大重试次数(${PENDING_MAX_RETRIES})，丢弃`);
        removePendingImage(record.messageId);
        continue;
      }

      try {
        console.log(`[待处理队列] 🔄 处理: ${record.messageId} (第${record.retries + 1}次尝试, 日期=${record.date})`);
        const result = await recognizeHealthImage(record.messageId, record.imageKey);

        const bot = this.bots.get(record.botId) || this.routerBot;

        if (result.nutritionLabel?.success) {
          if (bot) {
            await bot.sendText(record.chatId, `🔄 ${result.nutritionLabel.message}\n_(系统重启后自动补处理)_`);
          }
          removePendingImage(record.messageId);
          continue;
        }

        if (result.success) {
          const msg = await saveRecognizedData(record.date, result);
          console.log(`[待处理队列] ✅ 补处理成功: ${record.messageId} → ${msg}`);
          if (bot) {
            await bot.sendText(record.chatId, `✅ ${msg}\n_(系统重启后自动补处理)_`);
          }
          removePendingImage(record.messageId);
        } else {
          // AI 明确返回错误（非临时性），丢弃
          console.warn(`[待处理队列] ❌ 处理失败 ${record.messageId}: ${result.error}`);
          if (bot) {
            await bot.sendText(record.chatId, `❌ 图片补处理失败: ${result.error || '识别失败'}\n_(系统重启后自动重试)_`);
          }
          removePendingImage(record.messageId);
        }
      } catch (err: any) {
        // 临时异常，递增重试次数
        console.error(`[待处理队列] ⚠️ 处理异常 ${record.messageId} (第${record.retries + 1}次): ${err.message}`);
        updatePendingRetries(record.messageId, record.retries + 1);
        // 不发送消息给用户，避免每次重启都打扰
      }
    }

    const remaining = listPendingImages();
    if (remaining.length > 0) {
      console.log(`[待处理队列] ⏳ 仍有 ${remaining.length} 个图片待下次启动重试`);
    } else {
      console.log('[待处理队列] ✨ 全部处理完毕');
    }
  }

  /** 按 ID 获取 Bot 实例 */
  getBot(id: string): BotInstance | undefined {
    return this.bots.get(id);
  }

  /** 获取路由 Bot */
  getRouter(): BotInstance | null {
    return this.routerBot;
  }

  /** 清理过期会话 */
  cleanupSessions(timeout: number): number {
    return this.store.cleanupExpiredSessions(timeout);
  }
}

/** 处理系统命令，返回 true 表示已处理 */
async function handleSystemCommand(
  text: string,
  chatId: string,
  bot: BotInstance,
): Promise<boolean> {
  const replyBot = bot.isValid ? bot : null;
  const sender = replyBot || bot;
  const lower = text.toLowerCase();

  // /热量 命令（前缀匹配）
  if (lower === '/热量' || lower.startsWith('/热量 ')) {
    const calMatch = text.match(/\/热量\s+(\d+)/);
    if (calMatch) {
      const newTarget = parseInt(calMatch[1]);
      config.health.dailyCalorieTarget = newTarget;
      await sender.sendText(chatId, `✅ 每日热量目标已修改为 ${newTarget} kcal（本次运行有效）`);
    } else {
      await sender.sendText(chatId, `当前每日热量目标：${config.health.dailyCalorieTarget} kcal\n修改：\`/热量 2000\``);
    }
    return true;
  }

  // /断食 命令：切换当天5+2轻断食状态
  if (lower === '/断食' || lower.startsWith('/断食 ') || lower === '/fasting' || lower === '/fast') {
    const today = new Date().toISOString().slice(0, 10);
    const { getDailyRecord, saveDailyRecord } = require('../health/store');
    let record = getDailyRecord(today);
    if (!record) {
      // 创建最小记录
      record = {
        date: today,
        sleep: { duration: 0, quality: 'fair' as const, bedTime: '', wakeTime: '' },
        training: null,
        diet: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    const wasFasting = !!(record as any).fastingDay;
    (record as any).fastingDay = !wasFasting;
    saveDailyRecord(record);
    const newStatus = !wasFasting ? '🍃 断食日（目标600kcal）' : '🍽 正常日（目标2000kcal）';
    await sender.sendText(chatId, `✅ 今日已切换为：${newStatus}`);
    return true;
  }

  // 前缀匹配命令（支持带参数）
  if (lower.startsWith('/日报 ') || lower.startsWith('/健康日报 ') || lower.startsWith('/今日日报 ')) {
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    const dateStr = dateMatch ? dateMatch[1] : undefined;
    try {
      await sender.sendCard(chatId, (await buildDailyReport(dateStr)).card);
    } catch (err: any) {
      await sender.sendText(chatId, `❌ 日报生成失败: ${err.message}`);
    }
    return true;
  }

  // 舆情日报命令
  if (lower === '/舆情日报' || lower.startsWith('/舆情日报 ') || lower === '/舆情' || lower.startsWith('/舆情 ')) {
    try {
      await sender.sendText(chatId, '📡 正在生成天津城投舆情日报，请稍候...');
      const report = await buildDailySentinelReport();
      await sender.sendCard(chatId, report.card);
    } catch (err: any) {
      await sender.sendText(chatId, `❌ 舆情日报生成失败: ${err.message}`);
    }
    return true;
  }

  // 自然语言"日报"关键词
  if (/^(今日|今天|生成|发送|给我|帮我).*日报$/.test(text) || /^.*日报.*(今天|今日|今日份)/.test(text)) {
    try {
      await sender.sendCard(chatId, (await buildDailyReport()).card);
    } catch (err: any) {
      await sender.sendText(chatId, `❌ 日报生成失败: ${err.message}`);
    }
    return true;
  }

  // 精确匹配命令
  switch (lower) {
    case '/help':
      await sender.sendText(chatId,
        '📋 **支持的命令**\n' +
        '• `补充：xxx` / `修正：xxx` - 补充或修正健康数据\n' +
        '• 发送截图 - 自动 OCR 识别健康数据\n' +
        '• `/训练` `/今日训练` - 拉取今日训练数据\n' +
        '• `/训练 2026-05-24` - 拉取指定日期训练\n' +
        '• `/热量 2000` - 修改每日热量目标\n' +
        '• `/chatid` - 获取当前 chat_id\n' +
        '• `/reset` `/clear` - 重置对话上下文\n' +
        '• `/status` - 查看会话状态\n' +
        '• `/食物库` - 查看已录入的食物热量库\n' +
        '• `/教练 xxx` - 健康教练咨询\n' +
        '• `/代码 xxx` - 编程技术咨询\n' +
        '\n直接发消息即可与 AI 对话。\n\n📸 发送食品营养成分表图片可自动识别并录入食物库。',
      );
      return true;

    case '/reset':
    case '/clear':
      await bot.sessionManager.clearChat(chatId);
      await sender.sendText(chatId, '✅ 会话已重置。');
      return true;

    case '/status': {
      const session = await bot.sessionManager.getOrCreate(chatId);
      const history = await bot.sessionManager.getHistory(chatId);
      await sender.sendText(chatId,
        `📊 **会话状态**\n` +
        `• 会话 ID: \`${session.chat_id}\`\n` +
        `• 类型: ${session.chat_type}\n` +
        `• 历史消息数: ${history.length}\n` +
        `• 创建时间: ${new Date(session.created_at).toLocaleString('zh-CN')}`,
      );
      return true;
    }

    case '/chatid':
      await sender.sendText(chatId,
        `📋 当前 chat_id:\n\`${chatId}\`\n\n请将此 ID 填入 .env 文件的 REPORT_CHAT_ID 配置项。`,
      );
      return true;

    case '/舆情日报':
    case '/舆情':
    case '/sentinel': {
      try {
        await sender.sendText(chatId, '📡 正在生成天津城投舆情日报，请稍候...');
        const report = await buildDailySentinelReport();
        await sender.sendCard(chatId, report.card);
      } catch (err: any) {
        await sender.sendText(chatId, `❌ 舆情日报生成失败: ${err.message}`);
      }
      return true;
    }

    case '/日报':
    case '/健康日报':
    case '/今日日报':
    case '/daily':
    case '/report': {
      try {
        await sender.sendCard(chatId, (await buildDailyReport()).card);
      } catch (err: any) {
        await sender.sendText(chatId, `❌ 日报生成失败: ${err.message}`);
      }
      return true;
    }

    case '/生成简历':
    case '/简历生成':
    case '/导出简历': {
      // 获取对话历史作为上下文
      const history = await bot.sessionManager.getHistory(chatId, 30);
      const historyText = history
        .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
        .join('\n');

      if (!historyText || historyText.length < 20) {
        await sender.sendText(chatId, '❌ 请先提供您的简历信息（工作经历、教育背景、技能等），然后使用此命令生成 PDF 简历。');
        return true;
      }

      await sender.sendText(chatId, '📄 正在生成专业简历 PDF，请稍候...');

      const resumeData = await extractResumeDataFromChat(historyText);
      if (!resumeData) {
        await sender.sendText(chatId, '❌ 未能从对话中提取到足够的简历信息，请确认已提供工作经历、教育背景等关键信息。');
        return true;
      }

      const result = await generateAndSendResume(resumeData, chatId, bot.config.appId, bot.config.appSecret);
      await sender.sendText(chatId, result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      return true;
    }

    case '/网页简历':
    case '/html简历':
    case '/web简历': {
      const history = await bot.sessionManager.getHistory(chatId, 30);
      const historyText = history
        .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
        .join('\n');

      if (!historyText || historyText.length < 50) {
        await sender.sendText(chatId, '❌ 请先提供您的简历信息，然后使用此命令生成网页简历。');
        return true;
      }

      await sender.sendText(chatId, '🌐 正在生成精美网页简历...');

      const resumeData = await extractResumeDataFromChat(historyText);
      if (!resumeData) {
        await sender.sendText(chatId, '❌ 未能从对话中提取到足够的简历信息。');
        return true;
      }

      const { saveHtmlResume } = require('../career/htmlResume');
      const filePath = saveHtmlResume(resumeData, 'navy');
      const fileName = path.basename(filePath);
      const viewUrl = `http://localhost:${config.server.port}/api/career/resume/view/${encodeURIComponent(fileName)}`;

      await sender.sendText(chatId,
        `✅ **网页简历已生成！**\n\n` +
        `📄 文件：\`${fileName}\`\n` +
        `🌐 查看：${viewUrl}\n\n` +
        `💡 提示：\n` +
        `· 浏览器打开链接即可查看精美排版\n` +
        `· 使用 \`Ctrl+P\` → 另存为 PDF 即可导出\n` +
        `· 主题可在链接后加 \`?theme=modern\` 或 \`?theme=teal\` 切换`,
      );
      return true;
    }

    case '/分析简历':
    case '/简历分析':
    case '/analyze': {
      const history = await bot.sessionManager.getHistory(chatId, 30);
      const historyText = history
        .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
        .join('\n');

      if (!historyText || historyText.length < 50) {
        await sender.sendText(chatId, '❌ 请先发送您的简历内容（文字或 PDF 文件），然后使用此命令进行分析。');
        return true;
      }

      await sender.sendText(chatId, '🔍 正在深度分析简历，请稍候...');

      const analysis = await analyzeResume(historyText);
      if (!analysis) {
        await sender.sendText(chatId, '❌ 分析失败，请确认已提供足够的简历信息。');
        return true;
      }

      await sender.sendText(chatId, formatAnalysisCard(analysis));
      return true;
    }

    case '/职位查询':
    case '/职位搜索':
    case '/jobs':
    case '/findjob': {
      const args = parseCommandArgs(text);
      const keyword = args[0] || '风险治理';
      const location = args[1] || '';

      await sender.sendText(chatId, `🔍 正在搜索「${keyword}」相关职位${location ? ` @ ${location}` : ''}...`);

      const jobs = await searchJobs({ keyword, location, industry: '风险管理/内容安全/合规', limit: 8 });
      if (jobs.length === 0) {
        await sender.sendText(chatId, `❌ 未找到与「${keyword}」相关的职位。\n💡 建议：尝试更宽泛的关键词，或使用 WebSearch 工具辅助搜索。`);
        return true;
      }

      // 缓存搜索结果供后续匹配
      jobCache.set(chatId, jobs);

      await sender.sendText(chatId, formatJobListings(jobs, keyword));
      return true;
    }

    case '/职位匹配':
    case '/匹配':
    case '/match': {
      const args = parseCommandArgs(text);
      let jobIndex = parseInt(args[0]) - 1; // 用户输入 1-based

      // 尝试从缓存的搜索结果中获取
      const cachedJobs = jobCache.get(chatId);

      let targetJob: JobListing | null = null;

      if (!isNaN(jobIndex) && cachedJobs && jobIndex >= 0 && jobIndex < cachedJobs.length) {
        targetJob = cachedJobs[jobIndex];
      }

      // 如果没有缓存的职位，尝试从命令参数中提取职位描述
      const remainingArgs = isNaN(jobIndex) ? args : args.slice(1);
      const jobDesc = remainingArgs.join(' ');

      if (!targetJob && !jobDesc) {
        await sender.sendText(chatId,
          '❌ 请指定要匹配的职位。\n\n' +
          '用法：\n' +
          '· `/职位匹配 [序号]` — 匹配上次搜索结果中的第 N 个职位\n' +
          '· `/职位匹配 [职位描述]` — 粘贴职位 JD 直接匹配\n' +
          '· 先使用 `/职位查询` 搜索职位，再用 `/职位匹配 1` 匹配第一个',
        );
        return true;
      }

      await sender.sendText(chatId, '📊 正在分析匹配度，请稍候...');

      // 获取简历文本
      const history = await bot.sessionManager.getHistory(chatId, 30);
      const resumeText = history
        .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
        .join('\n');

      if (!resumeText || resumeText.length < 50) {
        await sender.sendText(chatId, '❌ 请先提供您的简历信息，再进行职位匹配。');
        return true;
      }

      const matchTarget = targetJob
        ? `**${targetJob.title}** @ ${targetJob.company}\n${targetJob.description}\n\n要求：${targetJob.requirements.join('；')}`
        : jobDesc;

      const match = await matchResumeToJob(resumeText, matchTarget);
      if (!match) {
        await sender.sendText(chatId, '❌ 匹配分析失败，请确认简历和职位描述已提供。');
        return true;
      }

      await sender.sendText(chatId, formatMatchResult(match));
      return true;
    }

    // ─── 投递追踪 ───
    case '/投递':
    case '/track': {
      const args = parseCommandArgs(text);
      if (args.length < 2) {
        await sender.sendText(chatId, '❌ 用法：`/投递 公司名 岗位名`\n例如：`/投递 字节跳动 风险治理经理`');
        return true;
      }
      const company = args[0];
      const title = args.slice(1).join(' ');
      const app = trackApplication(chatId, company, title);
      await sender.sendText(chatId,
        `✅ 已记录投递：**${company}** — ${title}\n` +
        `\`${app.id.slice(-4)}\` · ${app.appliedDate}\n\n` +
        `💡 输入 \`/进度\` 查看所有投递\n` +
        `💡 状态有更新时输入 \`/更新 ${app.id.slice(-4)} [描述]\`（如 已约面试）`
      );
      return true;
    }

    case '/进度':
    case '/status':
    case '/applications': {
      const apps = getApplications();
      await sender.sendText(chatId, formatApplications(apps));
      return true;
    }

    case '/更新': {
      const args = parseCommandArgs(text);
      if (args.length < 2) {
        await sender.sendText(chatId, '❌ 用法：`/更新 [序号] [状态描述]`\n例如：`/更新 abc1 已约下周二下午3点视频面试`');
        return true;
      }
      const appId = args[0];
      const statusText = args.slice(1).join(' ');
      const result = await updateApplicationStatus(chatId, appId, statusText);
      if (!result) {
        await sender.sendText(chatId, `❌ 未找到投递 \`${appId}\`。输入 \`/进度\` 查看所有投递及其序号。`);
        return true;
      }
      await sender.sendText(chatId, `✅ ${result.parsed}\n\n💡 输入 \`/进度\` 查看最新状态`);
      return true;
    }

    case '/跟进':
    case '/followup': {
      const overdue = getOverdueFollowUps();
      if (!overdue.length) {
        await sender.sendText(chatId, '✅ 暂无需要跟进的投递，干得漂亮！');
        return true;
      }
      const lines = [
        `⏰ **需要跟进的投递**（${overdue.length} 个）`,
        '',
        ...overdue.map(a => `· **${a.company}** — ${a.title}（${a.appliedDate}投递，建议${a.nextFollowUp}前跟进）\n　　\`/更新 ${a.id.slice(-4)} [状态]\``),
        '',
        '跟进后记得用 `/更新` 记录最新状态！',
      ];
      await sender.sendText(chatId, lines.join('\n'));
      return true;
    }

    // ─── 简历定制 ───
    case '/定制简历':
    case '/tailor': {
      const args = parseCommandArgs(text);
      let jdText = '';

      if (args.length > 0 && !isNaN(parseInt(args[0]))) {
        // 按序号从缓存取
        const idx = parseInt(args[0]) - 1;
        const cached = jobCache.get(chatId);
        if (cached && idx >= 0 && idx < cached.length) {
          const job = cached[idx];
          jdText = `**${job.title}** @ ${job.company}\n${job.description}\n\n要求：${job.requirements.join('；')}`;
        }
      } else {
        jdText = args.join(' ');
      }

      if (!jdText) {
        await sender.sendText(chatId, '❌ 请提供目标职位的 JD。\n\n用法：\n· `/定制简历 1` — 对搜索结果第1个职位定制\n· `/定制简历 [粘贴JD]` — 直接粘贴 JD 定制');
        return true;
      }

      const history = await bot.sessionManager.getHistory(chatId, 30);
      const historyText = history.map(m => `${m.role}: ${m.content}`).join('\n');
      const resumeData = await extractResumeDataFromChat(historyText);
      if (!resumeData) {
        await sender.sendText(chatId, '❌ 请先提供简历信息。');
        return true;
      }

      await sender.sendText(chatId, '🔧 正在针对该 JD 定制简历，请稍候...');
      const result = await tailorResumeToJD(resumeData, jdText);
      if (!result) {
        await sender.sendText(chatId, '❌ 定制失败，请重试。');
        return true;
      }

      // 保存定制后的简历到 workflow state
      const wf = getWorkflowState(chatId);
      wf.lastResumeData = result.tailored;
      saveWorkflowState(wf);

      await sender.sendText(chatId, formatTailorResult(result.changes));
      return true;
    }

    // ─── 技能差距 ───
    case '/技能差距':
    case '/skillsgap': {
      const args = parseCommandArgs(text);
      const targetRole = args.join(' ') || '';

      if (!targetRole) {
        await sender.sendText(chatId, '❌ 请指定目标角色。\n例如：`/技能差距 风险治理总监`');
        return true;
      }

      const history = await bot.sessionManager.getHistory(chatId, 30);
      const historyText = history.map(m => `${m.role}: ${m.content}`).join('\n');
      const resumeData = await extractResumeDataFromChat(historyText);
      if (!resumeData) {
        await sender.sendText(chatId, '❌ 请先提供简历信息。');
        return true;
      }

      await sender.sendText(chatId, `📊 正在分析「${targetRole}」的技能差距...`);
      const report = await analyzeSkillsGap(resumeData, targetRole);
      if (!report) {
        await sender.sendText(chatId, '❌ 分析失败，请重试。');
        return true;
      }

      await sender.sendText(chatId, formatSkillsGap(report));
      return true;
    }

    case '/食物库':
    case '/foods':
    case '/foodlib': {
      const foods = listFoods();
      if (foods.length === 0) {
        await sender.sendText(chatId, '📦 食物库为空。\n\n📸 发送食品包装上的营养成分表图片，系统会自动识别并录入食物库。\n✍️ 也可通过 API 手动添加：POST /api/health/foods');
      } else {
        const categoryCounts = new Map<string, number>();
        for (const f of foods) {
          categoryCounts.set(f.category, (categoryCounts.get(f.category) || 0) + 1);
        }
        const catSummary = [...categoryCounts.entries()].map(([cat, n]) => `\`${cat}\`×${n}`).join(' ');

        const lines = foods.slice(0, 20).map((f: any) => {
          const serving = f.servingCalories ? ` (每份${f.servingCalories}kcal)` : '';
          return `· **${f.name}** ｜ \`${f.caloriesPer100g}kcal/100g\` ｜ 碳${f.carbsPer100g}g 蛋${f.proteinPer100g}g 脂${f.fatPer100g}g${serving}`;
        });

        let msg = `📦 **食物热量库**（共 ${foods.length} 种）\n${catSummary}\n\n${lines.join('\n')}`;
        if (foods.length > 20) {
          msg += `\n\n...还有 ${foods.length - 20} 种。发送 \`/食物库\` 查看，或通过 API 按分类筛选：\`GET /api/health/foods?category=零食\``;
        }
        await sender.sendText(chatId, msg);
      }
      return true;
    }
  }

  return false;
}

/** 构建当日健康数据上下文，注入 AI 对话 */
async function buildHealthContext(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { training, record } = await fetchHealthData(today, config);

    if (!record && !training) return '';

    const parts: string[] = ['以下是用户今日已记录的健康数据（你已知道这些信息，不需要再问用户要）：'];

    if (record?.sleep?.duration) {
      parts.push(`- 睡眠：${record.sleep.duration}h，${record.sleep.bedTime}→${record.sleep.wakeTime}，质量：${record.sleep.quality}`);
    }

    // 力量训练（训记优先，其次本地记录）
    const effectiveStrength = training || record?.training || null;
    if (effectiveStrength) {
      const t = effectiveStrength;
      const exList = t.exercises.map(e => `${e.name}(${e.sets}组 ${e.weight}kg×${e.reps})`).join('、');
      parts.push(`- 力量训练：${t.bodyPart}，消耗${t.calories}kcal，动作：${exList}`);
    }

    // 有氧训练（来自本地记录的 cardio 字段）
    if (record?.cardio) {
      const c = record.cardio;
      const cardioDetail = [c.duration, c.distance, c.avgHeartRate ? `avgHR ${c.avgHeartRate}` : '']
        .filter(Boolean).join(' · ');
      parts.push(`- 有氧训练：${c.bodyPart}，消耗${c.calories}kcal${cardioDetail ? '，' + cardioDetail : ''}`);
    }

    if (record?.diet) {
      const meals = (record.diet as any).meals;
      if (meals?.length) {
        const mealText = meals.map((m: any) => `${m.time}: ${m.content} (${m.calories}kcal)`).join('；');
        parts.push(`- 饮食：${mealText}`);
      }
    }

    if (record?.weight) {
      parts.push(`- 体重：${record.weight}kg`);
    }


    if (parts.length === 1) return '';
    parts.push('\n请在回答时结合以上数据进行针对性分析和建议。');
    return parts.join('\n');
  } catch {
    return '';
  }
}

/** 匹配训练数据查询命令，返回目标日期或 null */
function matchTrainingQuery(text: string): string | null {
  const today = new Date().toISOString().slice(0, 10);

  // 精确命令（无参数 = 今天）
  if (/^\/今日训练$/.test(text)) return today;
  if (/^\/训练数据$/.test(text)) return today;
  if (/^\/训练记录$/.test(text)) return today;
  if (/^\/训练$/.test(text)) return today;

  // /训练 YYYY-MM-DD 指定日期
  const dateArg = text.match(/^\/训练\s+(\d{4}-\d{2}-\d{2})$/);
  if (dateArg) return dateArg[1];

  // 自然语言查询
  if (/^(今日训练|今天的训练|训练记录|训练数据)$/.test(text)) return today;

  return null;
}
