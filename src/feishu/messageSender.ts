import * as Lark from '@larksuiteoapi/node-sdk';

/** 从飞书 API 返回的消息条目 */
export interface FeishuMessageItem {
  message_id: string;
  msg_type: string;
  create_time: string;
  chat_id: string;
  chat_type?: string;  // "p2p" 或 "group"
  /** 发送者类型：user（用户） | app（机器人） | tenant（租户） */
  sender_type?: string;
  body?: { content: string };
}

export class MessageSender {
  private client: Lark.Client;

  constructor(appId?: string, appSecret?: string) {
    this.client = new Lark.Client({
      appId: appId || '',
      appSecret: appSecret || '',
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  /** 发送普通文本消息 */
  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      console.error('发送文本消息失败:', err);
    }
  }

  /** 发送卡片消息 */
  async sendCard(chatId: string, cardContent: object): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(cardContent),
        },
      });
    } catch (err) {
      console.error('发送卡片消息失败:', err);
    }
  }

  /** 发送"正在思考"占位消息 */
  async sendThinkingMessage(chatId: string): Promise<string> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: '🤔 正在思考...' }),
        },
      });
      return resp?.data?.message_id || '';
    } catch (err) {
      console.error('发送占位消息失败:', err);
      return '';
    }
  }

  /**
   * 拉取指定会话的历史消息（用于开机后补录离线消息）
   * @param chatId 会话 ID
   * @param startTime 起始时间（毫秒时间戳），拉取此时间之后的消息
   * @param pageSize 每页条数（最大 50）
   *
   * 注意：此方法会抛出异常如果 Bot 无权访问该会话（不属于该 Bot 的群聊/私聊）。
   * 调用方应捕获异常以区分"无消息"（返回空数组）和"无权限"（抛出异常）。
   */
  async fetchMessages(
    chatId: string,
    startTime: number,
    pageSize: number = 50,
  ): Promise<FeishuMessageItem[]> {
    const allMessages: FeishuMessageItem[] = [];
    let pageToken: string | undefined;

    // 飞书 API 要求时间戳为秒级字符串
    const startTimeSec = Math.floor(startTime / 1000).toString();

    do {
      const resp = await this.client.im.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: startTimeSec,
          sort_type: 'ByCreateTimeAsc',
          page_size: Math.min(pageSize, 50),
          page_token: pageToken,
        },
      });

      const items = resp?.data?.items || [];
      for (const item of items) {
        if (item.message_id && item.msg_type && item.create_time) {
          allMessages.push({
            message_id: item.message_id,
            msg_type: item.msg_type,
            create_time: item.create_time,
            chat_id: item.chat_id || chatId,
            chat_type: (item as any).chat_type,  // p2p / group
            sender_type: (item as any).sender?.sender_type,  // 'user' | 'app' | 'tenant'
            body: item.body,
          });
        }
      }

      pageToken = resp?.data?.has_more
        ? resp?.data?.page_token
        : undefined;
    } while (pageToken);

    if (allMessages.length > 0) {
      console.log(`[MessageSender] 从 ${chatId} 拉取到 ${allMessages.length} 条历史消息（startTime=${startTimeSec}）`);
    }
    return allMessages;
  }
}
