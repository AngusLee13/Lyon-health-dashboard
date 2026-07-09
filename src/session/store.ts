import fs from 'fs';
import path from 'path';

export interface MessageRecord {
  id: string;
  chat_id: string;
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

export interface SessionRecord {
  chat_id: string;
  chat_type: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

interface StoreData {
  sessions: Record<string, SessionRecord>;
  messages: Record<string, MessageRecord[]>;
  processedMessages: Record<string, number>;
  /** 服务器最后活跃时间戳（毫秒），用于开机后拉取离线消息 */
  lastActiveAt: number;
}

export class SessionStore {
  private data: StoreData;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dbPath?: string) {
    this.filePath = dbPath || path.resolve(__dirname, '../../data/sessions.json');
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.data = this.loadData();
  }

  private loadData(): StoreData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const data: StoreData = {
          sessions: parsed.sessions || {},
          messages: parsed.messages || {},
          processedMessages: parsed.processedMessages || {},
          lastActiveAt: parsed.lastActiveAt || 0,
        };

        // 一次性恢复：从 processedMessages 的合成 ID 中解析 chat_id 并创建会话
        // 合成 ID 格式: <chat_id>-<timestamp>-<random_6_chars>
        // 例如: oc_3519094aee1a6ae05c4480888c1f8acf-1779689132710-7ydf59
        if (Object.keys(data.sessions).length === 0 && Object.keys(data.processedMessages).length > 0) {
          const recoveredChatIds = new Set<string>();
          for (const msgId of Object.keys(data.processedMessages)) {
            // 只处理合成 ID（包含 chat_id + 时间戳 + 随机串的格式）
            const parts = msgId.split('-');
            // chat_id 通常以 oc_ 开头，合成 ID 至少有3段（chat_id, timestamp, random）
            if (parts.length >= 3 && (parts[0].startsWith('oc_') || parts[0].startsWith('om_'))) {
              // 重构 chat_id：chat_id 可能包含多个 '-' 分隔的部分
              // 格式: <chat_id>-<timestamp>-<random>，其中 timestamp 是13位数字
              // 从后往前找：最后一段是 random（非纯数字），倒数第二段是 timestamp（13位纯数字）
              const last = parts[parts.length - 1];
              const secondLast = parts[parts.length - 2];
              if (/^\d{13}$/.test(secondLast) && !/^\d+$/.test(last)) {
                const chatId = parts.slice(0, -2).join('-');
                if (chatId) {
                  recoveredChatIds.add(chatId);
                }
              }
            }
          }

          for (const chatId of recoveredChatIds) {
            const now = Date.now();
            data.sessions[chatId] = {
              chat_id: chatId,
              chat_type: 'p2p',
              created_at: now,
              updated_at: now,
              message_count: 0,
            };
            data.messages[chatId] = [];
            console.log(`[SessionStore] 已从 processedMessages 恢复会话: ${chatId}`);
          }

          if (recoveredChatIds.size > 0) {
            console.log(`[SessionStore] 共恢复 ${recoveredChatIds.size} 个会话（之前 sessions 为空）`);
            // 立即持久化恢复的会话，防止进程重启丢失
            try {
              const saveData = { ...data, sessions: data.sessions, messages: data.messages };
              fs.writeFileSync(this.filePath, JSON.stringify(saveData, null, 2), 'utf-8');
              console.log(`[SessionStore] 已持久化恢复的会话到 ${this.filePath}`);
            } catch (err) {
              console.error('[SessionStore] 持久化恢复会话失败:', err);
            }
          }
        }

        return data;
      }
    } catch (err) {
      console.error('加载存储文件失败，使用空数据:', err);
    }
    return { sessions: {}, messages: {}, processedMessages: {}, lastActiveAt: 0 };
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch (err) {
        console.error('保存数据失败:', err);
      }
    }, 500);
  }

  private saveSync(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('保存数据失败:', err);
    }
  }

  isDuplicateMessage(messageId: string): boolean {
    return messageId in this.data.processedMessages;
  }

  markMessageProcessed(messageId: string): void {
    this.data.processedMessages[messageId] = Date.now();
    this.scheduleSave();
  }

  getOrCreateSession(chatId: string, chatType: string = 'p2p'): SessionRecord {
    if (this.data.sessions[chatId]) {
      return this.data.sessions[chatId];
    }

    const now = Date.now();
    const session: SessionRecord = {
      chat_id: chatId,
      chat_type: chatType,
      created_at: now,
      updated_at: now,
      message_count: 0,
    };
    this.data.sessions[chatId] = session;
    this.data.messages[chatId] = [];
    // 新建会话时立即持久化，防止进程重启丢失会话记录
    this.saveSync();
    return session;
  }

  getHistory(chatId: string, limit: number = 20): MessageRecord[] {
    const msgs = this.data.messages[chatId] || [];
    return msgs.slice(-limit);
  }

  appendMessage(chatId: string, messageId: string, role: 'user' | 'assistant', content: string): void {
    if (!this.data.messages[chatId]) {
      this.data.messages[chatId] = [];
    }

    const exists = this.data.messages[chatId].some(m => m.message_id === messageId);
    if (exists) return;

    const now = Date.now();
    const record: MessageRecord = {
      id: `${chatId}-${now}-${Math.random().toString(36).slice(2, 6)}`,
      chat_id: chatId,
      message_id: messageId,
      role,
      content,
      created_at: now,
    };
    this.data.messages[chatId].push(record);

    if (this.data.sessions[chatId]) {
      this.data.sessions[chatId].updated_at = now;
      this.data.sessions[chatId].message_count = this.data.messages[chatId].length;
    }

    this.scheduleSave();
  }

  clearChat(chatId: string): void {
    delete this.data.sessions[chatId];
    delete this.data.messages[chatId];
    this.scheduleSave();
  }

  getMessageCount(chatId: string): number {
    return (this.data.messages[chatId] || []).length;
  }

  cleanupExpiredSessions(timeoutSeconds: number): number {
    const cutoff = Date.now() - timeoutSeconds * 1000;
    let count = 0;

    for (const [chatId, session] of Object.entries(this.data.sessions)) {
      if (session.updated_at < cutoff) {
        delete this.data.sessions[chatId];
        delete this.data.messages[chatId];
        count++;
      }
    }

    if (count > 0) {
      this.scheduleSave();
    }
    return count;
  }

  /** 获取服务器最后活跃时间（毫秒时间戳），用于判断离线消息的起始时间 */
  getLastActiveAt(): number {
    return this.data.lastActiveAt || 0;
  }

  /** 更新服务器最后活跃时间 */
  updateLastActiveAt(timestamp?: number): void {
    this.data.lastActiveAt = timestamp || Date.now();
    this.scheduleSave();
  }

  /** 更新会话的最后活跃时间（不创建新会话） */
  touchSession(chatId: string): void {
    if (this.data.sessions[chatId]) {
      this.data.sessions[chatId].updated_at = Date.now();
      this.scheduleSave();
    }
  }

  /** 获取所有已知的 chat_id 列表 */
  getAllChatIds(): string[] {
    return Object.keys(this.data.sessions);
  }

  /** 立即持久化到磁盘（用于关键状态变更，如会话创建） */
  forceSave(): void {
    this.saveSync();
  }

  close(): void {
    this.saveSync();
  }
}
