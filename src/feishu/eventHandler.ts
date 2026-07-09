import * as Lark from '@larksuiteoapi/node-sdk';
import { SessionManager } from '../session/manager';
import { ChatService } from '../claude/chatService';
import { MessageSender } from './messageSender';
import { StreamingMessage } from './streamingMessage';
import { recognizeHealthImage, saveRecognizedData } from '../health/imageRecognition';

/**
 * 飞书事件处理器
 * 接收消息事件，路由到对应的处理逻辑
 */
export class EventHandler {
  constructor(
    private sessionManager: SessionManager,
    private chatService: ChatService,
    private messageSender: MessageSender,
    private streamingMessage: StreamingMessage,
  ) {}

  async handle(eventData: any): Promise<void> {
    // 飞书 WebSocket 长连接 v2.0 格式：message 在顶层
    const message = eventData.message;
    if (!message) {
      console.log('[DEBUG] handle: 无 message，跳过');
      return;
    }
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const chatType = message.chat_type || 'p2p';

    console.log(`[DEBUG] handle: chatId=${chatId}, chatType=${chatType}, messageId=${messageId}`);

    // 忽略机器人自己发送的消息
    if (chatType === 'bot') {
      console.log('[DEBUG] handle: bot 消息，跳过');
      return;
    }

    // 去重检查
    if (await this.sessionManager.isDuplicate(messageId)) {
      console.log('[DEBUG] handle: 重复消息，跳过');
      return;
    }
    await this.sessionManager.markProcessed(messageId);

    // 先检查消息类型——图片消息需在文本解析之前处理
    if (message.message_type === 'image') {
      await this.handleImageMessage(chatId, messageId, message);
      return;
    }

    // 解析文本消息内容
    let textContent: string;
    try {
      const content = typeof message.content === 'string'
        ? JSON.parse(message.content)
        : message.content;
      textContent = content.text || '';
    } catch {
      console.log('[DEBUG] handle: 解析内容失败，跳过');
      return;
    }

    if (!textContent.trim()) {
      console.log('[DEBUG] handle: 文本为空，跳过');
      return;
    }

    console.log(`[DEBUG] handle: 文本内容="${textContent}"`);

    // 检查是否是命令
    if (this.isCommand(textContent)) {
      await this.handleCommand(chatId, textContent.trim());
      return;
    }

    // 异步处理 AI 对话
    console.log('[DEBUG] handle: 开始异步处理 AI 对话...');
    setImmediate(() => {
      this.handleChatMessage({ chatId, chatType, messageId, content: textContent.trim() });
    });
  }

  /** 处理图片消息：下载图片并调用 AI 识别 */
  private async handleImageMessage(chatId: string, messageId: string, message: any): Promise<void> {
    try {
      const imageContent = typeof message.content === 'string'
        ? JSON.parse(message.content)
        : message.content;
      const imageKey = imageContent.image_key;
      if (!imageKey) {
        console.log('[DEBUG] handleImage: 无 image_key，跳过');
        return;
      }
      console.log(`[DEBUG] handleImage: image_key=${imageKey}`);
      await this.messageSender.sendText(chatId, '🔍 正在识别图片数据...');
      const result = await recognizeHealthImage(messageId, imageKey);
      if (result.success) {
        const today = new Date().toISOString().slice(0, 10);
        const msg = await saveRecognizedData(today, result);
        await this.messageSender.sendText(chatId, `✅ ${msg}`);
        if (result.data) {
          const summary = formatRecognizedData(result.data);
          await this.messageSender.sendText(chatId, summary);
        }
      } else {
        await this.messageSender.sendText(chatId, `❌ ${result.error || '识别失败，请尝试文字描述数据'}`);
      }
    } catch (err: any) {
      console.error('图片识别异常:', err.message);
      await this.messageSender.sendText(chatId, `❌ 图片处理异常: ${err.message}`);
    }
  }

  private isCommand(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    return ['/help', '/reset', '/clear', '/status', '/chatid'].some(cmd => trimmed.startsWith(cmd));
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    switch (text.toLowerCase()) {
      case '/help':
        await this.messageSender.sendText(chatId,
          '📋 **支持的命令**：\n' +
          '• `/help` - 显示此帮助信息\n' +
          '• `/reset` - 重置当前会话（清空上下文）\n' +
          '• `/clear` - 清空对话历史\n' +
          '• `/status` - 查看会话状态\n' +
          '• `/chatid` - 获取当前 chat_id\n\n' +
          '直接发送消息即可与 AI 对话。'
        );
        break;
      case '/reset':
      case '/clear':
        await this.sessionManager.clearChat(chatId);
        await this.messageSender.sendText(chatId, '✅ 会话已重置。');
        break;
      case '/status': {
        const session = await this.sessionManager.getOrCreate(chatId);
        const history = await this.sessionManager.getHistory(chatId);
        await this.messageSender.sendText(chatId,
          `📊 **会话状态**\n` +
          `• 会话 ID: ${session.chat_id}\n` +
          `• 类型: ${session.chat_type}\n` +
          `• 历史消息数: ${history.length}\n` +
          `• 创建时间: ${new Date(session.created_at).toLocaleString('zh-CN')}`
        );
        break;
      }
      case '/chatid':
        await this.messageSender.sendText(chatId,
          `📋 当前 chat_id:\n\`${chatId}\`\n\n请将此 ID 填入 .env 文件的 REPORT_CHAT_ID 配置项。`
        );
        break;
    }
  }

  private async handleChatMessage(params: {
    chatId: string;
    chatType: string;
    messageId: string;
    content: string;
  }): Promise<void> {
    const { chatId } = params;
    console.log(`[DEBUG] handleChatMessage: 开始, chatId=${chatId}, content="${params.content}"`);

    await this.chatService.processMessage(
      params,
      // onToken: 暂不处理（飞书文本消息不支持编辑）
      async (_text: string) => {},
      // onComplete: 发送回复
      async (fullText: string) => {
        console.log(`[DEBUG] onComplete: 最终回复, 长度=${fullText.length}`);
        await this.messageSender.sendText(chatId, fullText);
      },
      // onError: 发送错误信息
      async (error: string) => {
        console.log(`[DEBUG] onError: ${error}`);
        await this.messageSender.sendText(chatId, `❌ ${error}`);
      },
    );
  }
}

/** 格式化识别结果为用户友好的文本 */
function formatRecognizedData(data: any): string {
  const lines: string[] = ['📋 **识别结果**'];

  if (data.sleep) {
    const s = data.sleep;
    lines.push(`😴 睡眠: ${s.bedTime || '?'}→${s.wakeTime || '?'}  ${s.duration || '?'}h${s.sleepScore != null ? `  评分${s.sleepScore}分` : ''}${s.deepSleep ? `  深睡${s.deepSleep}h` : ''}`);
  }
  if (data.diet?.meals?.length) {
    const meals = data.diet.meals.map((m: any) =>
      `  ${m.time}: ${m.content}${m.calories ? ` (${m.calories}kcal)` : ''}`
    ).join('\n');
    lines.push(`🍽 饮食:\n${meals}`);
  }
  if (data.weight) {
    lines.push(`⚖️ 体重: ${data.weight}kg`);
  }
  if (data.supplements) {
    lines.push(`💊 补剂: ${data.supplements}`);
  }

  lines.push('\n数据已保存，回复文字可继续补充或修正。');
  return lines.join('\n');
}
