import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from '../config';

let apiClient: Lark.Client | null = null;

export function getFeishuClient(): Lark.Client {
  if (!apiClient) {
    apiClient = new Lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }
  return apiClient;
}
