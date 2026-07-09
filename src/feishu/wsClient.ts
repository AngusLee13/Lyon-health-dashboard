import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from '../config';
import { EventHandler } from './eventHandler';

/**
 * 飞书 WebSocket 长连接客户端
 * 使用长连接模式接收飞书事件推送
 */
export class FeishuWSClient {
  private wsClient: Lark.WSClient;
  private eventHandler: EventHandler;

  constructor(eventHandler: EventHandler) {
    this.eventHandler = eventHandler;

    this.wsClient = new Lark.WSClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  async start(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: any) => {
        console.log('[DEBUG] 收到 im.message.receive_v1 事件:', JSON.stringify(data).slice(0, 300));
        this.eventHandler.handle(data).catch((err: Error) => {
          console.error('事件处理异常:', err.message);
        });
      },
    });

    this.wsClient.start({ eventDispatcher: dispatcher });

    console.log('飞书 WebSocket 客户端已启动，等待消息事件...');
  }
}
