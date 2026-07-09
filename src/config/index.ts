import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  deepseek: {
    apiKey: string;
    model: string;
    healthModel: string;
    maxTokens: number;
    baseUrl: string;
  };
  xunji: {
    apiKey: string;
    baseUrl: string;
  };
  server: {
    port: number;
  };
  session: {
    maxHistoryLength: number;
    sessionTimeout: number;
  };
  health: {
    dailyCalorieTarget: number;
    dailySodiumTarget: number;
    fastingCalorieTarget: number;
    fastingProteinTarget: number;
  };
  report: {
    targetChatId: string;
    cronTime: string;
  };
  eveningCheckin: {
    chatId: string;
    cronTime: string;
  };
}

function loadConfig(): AppConfig {
  const feishuAppId = process.env.FEISHU_APP_ID;
  const feishuAppSecret = process.env.FEISHU_APP_SECRET;
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

  if (!feishuAppId || feishuAppId === 'cli_xxxxxxxxxxxx') {
    throw new Error('请在 .env 文件中配置 FEISHU_APP_ID');
  }
  if (!feishuAppSecret || feishuAppSecret === 'xxxxxxxxxxxxxxxxxxxxxxxxxx') {
    throw new Error('请在 .env 文件中配置 FEISHU_APP_SECRET');
  }
  if (!deepseekApiKey || deepseekApiKey === 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx') {
    throw new Error('请在 .env 文件中配置 DEEPSEEK_API_KEY');
  }

  return {
    feishu: {
      appId: feishuAppId,
      appSecret: feishuAppSecret,
    },
    deepseek: {
      apiKey: deepseekApiKey,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      healthModel: process.env.DEEPSEEK_HEALTH_MODEL || 'deepseek-v4-pro',
      maxTokens: parseInt(process.env.DEEPSEEK_MAX_TOKENS || '4096', 10),
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    },
    xunji: {
      apiKey: process.env.XUNJI_API_KEY || 'xjllm_896dad2c78aa02f91f75ae43fda4cda66a751a7bc57640f7',
      baseUrl: process.env.XUNJI_BASE_URL || 'https://trains.xunjiapp.cn',
    },
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
    },
    session: {
      maxHistoryLength: parseInt(process.env.SESSION_MAX_HISTORY || '20', 10),
      sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '3600', 10),
    },
    health: {
      dailyCalorieTarget: parseInt(process.env.DAILY_CALORIE_TARGET || '2000', 10),
      dailySodiumTarget: parseInt(process.env.DAILY_SODIUM_TARGET || '2000', 10),
      // 5+2轻断食：断食日600kcal，蛋白质≥60g防肌肉流失
      fastingCalorieTarget: parseInt(process.env.FASTING_CALORIE_TARGET || '600', 10),
      fastingProteinTarget: parseInt(process.env.FASTING_PROTEIN_TARGET || '60', 10),
    },
    report: {
      targetChatId: process.env.REPORT_CHAT_ID || '',
      cronTime: process.env.REPORT_CRON || '0 9 * * *',
    },
    eveningCheckin: {
      chatId: process.env.EVENING_CHECKIN_CHAT_ID || process.env.REPORT_CHAT_ID || '',
      cronTime: process.env.EVENING_CHECKIN_CRON || '0 22 * * *',
    },
  };
}

export const config = loadConfig();
