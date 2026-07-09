import * as Lark from '@larksuiteoapi/node-sdk';
import { BotConfig } from './types';
import { SessionStore } from '../session/store';
import { SessionManager } from '../session/manager';
import { ChatService } from '../claude/chatService';

/** 单个 Bot 实例，封装 WebSocket 连接、事件处理、对话服务 */
export class BotInstance {
  public readonly id: string;
  public readonly name: string;
  public readonly role: string;
  public readonly config: BotConfig;

  private wsClient: Lark.WSClient | null = null;
  private messageSender: MessageSender;
  public readonly sessionManager: SessionManager;
  public readonly chatService: ChatService;

  private onMessageCallback: ((botId: string, data: any) => Promise<void>) | null = null;
  private onImageCallback: ((botId: string, chatId: string, messageId: string, imageKey: string) => Promise<void>) | null = null;

  constructor(config: BotConfig, store: SessionStore) {
    this.id = config.id;
    this.name = config.name;
    this.role = config.role;
    this.config = config;

    this.sessionManager = new SessionManager(store);

    // 消息发送器：有真实凭据用自身，否则留空（走 fallback）
    this.messageSender = new MessageSender(
      config.appId,
      config.appSecret,
    );

    // 对话服务：每个 Bot 有独立的 system prompt
    this.chatService = new ChatService(
      this.sessionManager,
      this.messageSender,
      config.systemPrompt,
    );
    // 设置 Agent 信息，用于对话记忆同步到 Claude Code
    this.chatService.setAgentInfo(config.id, config.name);
  }

  get isValid(): boolean {
    return this.config.enabled
      && !this.config.appId.startsWith('cli_placeholder')
      && this.config.appSecret !== 'placeholder';
  }

  /** 启动 WebSocket 长连接（仅有效 Bot） */
  async start(
    onMessage: (botId: string, data: any) => Promise<void>,
    onImage: (botId: string, chatId: string, messageId: string, imageKey: string) => Promise<void>,
  ): Promise<void> {
    this.onMessageCallback = onMessage;
    this.onImageCallback = onImage;

    if (!this.isValid) {
      console.log(`[Bot:${this.id}] 凭据未配置，作为虚拟 Agent 运行（fallback 到主 Bot）`);
      return;
    }

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    const botId = this.id;
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: any) => {
        onMessage(botId, data).catch((err: Error) => {
          console.error(`[Bot:${botId}] 事件处理异常:`, err.message);
        });
      },
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    console.log(`[Bot:${this.id}] WebSocket 已启动（${this.name}）`);
  }

  /** 用此 Bot 身份发送文本消息 */
  async sendText(chatId: string, text: string, asBotName?: string): Promise<void> {
    const prefix = asBotName ? `【${asBotName}】\n` : '';
    await this.messageSender.sendText(chatId, prefix + text);
  }

  /** 用此 Bot 身份发送卡片消息 */
  async sendCard(chatId: string, card: object): Promise<void> {
    await this.messageSender.sendCard(chatId, card);
  }

  /** 处理文本对话（被主 Bot 路由调用） */
  async processTextMessage(params: {
    chatId: string;
    chatType: string;
    messageId: string;
    content: string;
    onComplete: (text: string) => Promise<void>;
    onError: (error: string) => Promise<void>;
  }, context?: string): Promise<void> {
    await this.chatService.processMessage(
      params,
      async () => {},
      params.onComplete,
      params.onError,
      context,
    );
  }
}

// 延迟导入避免循环依赖
import { MessageSender } from '../feishu/messageSender';
