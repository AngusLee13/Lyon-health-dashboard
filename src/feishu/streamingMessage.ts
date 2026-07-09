import { getFeishuClient } from './client';

/**
 * 流式消息管理器
 * 通过反复编辑消息实现打字机流式效果
 */
export class StreamingMessage {
  private client;

  constructor() {
    this.client = getFeishuClient();
  }

  /**
   * 创建一条占位消息，返回 message_id
   */
  async create(chatId: string): Promise<string> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: '⏳ 思考中...' }),
        },
      });
      return resp?.data?.message_id || '';
    } catch (err) {
      console.error('创建流式消息失败:', err);
      // 降级：返回空字符串，调用方会使用 sendText 发送最终结果
      return '';
    }
  }

  /**
   * 更新流式消息内容（通过编辑消息实现）
   */
  async update(messageId: string, text: string): Promise<void> {
    if (!messageId) return;
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text: text + ' ▌' }),
        },
      });
    } catch (err) {
      // 编辑消息可能因速率限制失败，静默忽略
    }
  }

  /**
   * 完成流式输出，更新为最终内容
   */
  async finish(messageId: string, text: string): Promise<void> {
    if (!messageId) return;
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      console.error('完成流式消息失败:', err);
    }
  }
}
