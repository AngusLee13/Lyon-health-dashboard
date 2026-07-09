import { SessionStore, MessageRecord, SessionRecord } from './store';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class SessionManager {
  constructor(private store: SessionStore) {}

  async getOrCreate(chatId: string, chatType?: string): Promise<SessionRecord> {
    return this.store.getOrCreateSession(chatId, chatType);
  }

  async getHistory(chatId: string, limit?: number): Promise<ChatMessage[]> {
    const maxHistory = limit || 20;
    const records = this.store.getHistory(chatId, maxHistory);
    return records.map(r => ({
      role: r.role,
      content: r.content,
    }));
  }

  async appendHistory(chatId: string, role: 'user' | 'assistant', content: string, messageId?: string): Promise<void> {
    const id = messageId || `${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.store.appendMessage(chatId, id, role, content);
    await this.store.markMessageProcessed(id);

    const maxHistory = 20;
    const count = this.store.getMessageCount(chatId);
    if (count > maxHistory * 2) {
      this.trimHistory(chatId, maxHistory);
    }
  }

  async clearChat(chatId: string): Promise<void> {
    this.store.clearChat(chatId);
  }

  async isDuplicate(messageId: string): Promise<boolean> {
    return this.store.isDuplicateMessage(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    this.store.markMessageProcessed(messageId);
  }

  async cleanupExpired(timeoutSeconds: number): Promise<number> {
    return this.store.cleanupExpiredSessions(timeoutSeconds);
  }

  private trimHistory(chatId: string, keep: number): void {
    this.store.clearChat(chatId);
  }

  close(): void {
    this.store.close();
  }
}
