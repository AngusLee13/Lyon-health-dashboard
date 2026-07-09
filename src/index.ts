import express from 'express';
import path from 'path';
import cron from 'node-cron';
import { config } from './config';
import { runStartupValidation } from './config/validate';
import { createLogger } from './utils/logger';
import { BotManager } from './bot/manager';
import { createRoutes } from './api/routes';
import { createSentinelRoutes } from './api/sentinelRoutes';
import { buildDailyReport } from './health/reportGenerator';
import { runEveningCheckin } from './health/eveningCheckin';
import { MessageSender } from './feishu/messageSender';
// 舆情相关 import 已随定时任务暂停一并移除，如需恢复定时任务请同步恢复以下导入：
// import { collectFromSearch } from './sentinel/collector/webSearch';
// import { runAnalysisPipeline } from './sentinel/analyzer';
// import { getArticlesByDate, getMeta, saveMeta, cleanupOldData } from './sentinel/store';
// import { sentinelConfig } from './sentinel/config';
// import { buildDailySentinelReport } from './sentinel/reportBuilder';

const log = createLogger('主进程');

async function main(): Promise<void> {
  log.info('飞书多 Agent Bot 系统启动中');

  // 0. 启动前安全校验
  const validationPassed = runStartupValidation();
  if (!validationPassed) {
    log.error('安全校验未通过，进程退出');
    process.exit(1);
  }

  // 1. 初始化多 Bot 管理器
  const manager = new BotManager();
  await manager.initialize();

  // 2. 启动所有 Bot 的 WebSocket 长连接
  await manager.startAll();

  // 2.5 拉取开机前错过的离线消息
  manager.pullOfflineMessages().catch((err) => {
    log.error('离线消息拉取失败', err);
  });

  // 2.6 处理因重启中断的图片（OCR 前已持久化到队列）
  manager.processPendingImages().catch((err) => {
    log.error('待处理图片队列处理失败', err);
  });

  // 3. 获取路由 Bot 的消息发送器（用于 HTTP API 和定时任务）
  const routerBot = manager.getRouter();
  const mainSender = routerBot
    ? new MessageSender(config.feishu.appId, config.feishu.appSecret)
    : new MessageSender();

  // 舆情监测 Bot 消息发送器 — 已随定时任务暂停
  // const sentinelSender = new MessageSender(
  //   'cli_aaa01523e5389cef',
  //   'fHUF1gLEgo7M7ASCa0syij7CWSedm4U7',
  // );
  // // 舆情 Bot 私聊 chat_id（用户已与舆情 Bot 建立私聊）
  // const sentinelChatId = process.env.SENTINEL_REPORT_CHAT_ID || 'oc_0bade6fc174bace6b1b822394b56cd5a';

  // 4. 启动 Express 服务器
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS（允许妙搭面板跨域访问）
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (_req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  app.use(createRoutes(mainSender));

  // 舆情监测路由
  app.use(createSentinelRoutes());

  // 舆情面板便捷路由（支持 /sentinel 和 /dashboard/sentinel 两种访问方式）
  app.get('/sentinel', (_req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard/sentinel.html'));
  });
  app.get('/dashboard/sentinel', (_req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard/sentinel.html'));
  });

  // 静态文件：健康面板（手机端访问）
  // 注意：Cursor 内置浏览器对 no-cache 响应头兼容性较差，仅对 HTML 保留 no-cache
  app.use('/dashboard', express.static(path.join(__dirname, '../dashboard'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.listen(config.server.port, () => {
    console.log(`Express 服务已启动，端口: ${config.server.port}`);
  });

  // 5. 定期清理过期会话
  setInterval(() => {
    try {
      const cleaned = manager.cleanupSessions(config.session.sessionTimeout);
      if (cleaned) {
        console.log(`已清理 ${cleaned} 个过期会话`);
      }
    } catch (err) {
      console.error('清理过期会话失败:', err);
    }
  }, 600_000);

  // 6. 定时健康日报推送
  if (config.report.targetChatId && config.report.cronTime) {
    cron.schedule(config.report.cronTime, async () => {
      try {
        console.log('⏰ 生成每日健康日报...');
        const report = await buildDailyReport();
        await mainSender.sendCard(config.report.targetChatId, report.card);
        console.log(`健康日报已推送至 ${config.report.targetChatId}`);
      } catch (err) {
        console.error('日报推送失败:', err);
      }
    });
    console.log(`健康日报定时任务已启动（${config.report.cronTime}），推送目标: ${config.report.targetChatId}`);
  } else {
    console.log('未配置 REPORT_CHAT_ID，跳过日报定时推送');
  }

  // 7. 定时晚间数据统计
  if (config.eveningCheckin.chatId && config.eveningCheckin.cronTime) {
    cron.schedule(config.eveningCheckin.cronTime, async () => {
      try {
        console.log('🌙 晚间数据统计...');
        const result = await runEveningCheckin();
        if (result.missing.length > 0) {
          await mainSender.sendText(config.eveningCheckin.chatId,
            `🌙 晚间数据统计：今日还有 **${result.missing.length}** 项健康数据未补充，请查看下方卡片并回复补录。`,
          );
        } else {
          await mainSender.sendText(config.eveningCheckin.chatId, '🎉 今日所有健康数据已记录完毕，赞！');
        }
        await mainSender.sendCard(config.eveningCheckin.chatId, result.card);
        console.log(`晚间统计已推送，缺失 ${result.missing.length} 项`);
      } catch (err) {
        console.error('晚间统计推送失败:', err);
      }
    });
    console.log(`晚间数据统计已启动（${config.eveningCheckin.cronTime}），推送目标: ${config.eveningCheckin.chatId}`);
  } else {
    console.log('未配置晚间统计 chatId，跳过晚间推送');
  }

  // 7.5 每晚自动更新静态看板并推送到 GitHub Pages（21:07）
  cron.schedule('7 21 * * *', async () => {
    try {
      console.log('🔄 自动更新静态看板...');
      const { execFile } = require('child_process');
      const result = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'node',
          ['scripts/auto-deploy.js'],
          {
            cwd: path.resolve(__dirname, '..'),
            timeout: 60000,
            env: process.env,
            windowsHide: true,
            shell: false,  // 不使用 shell，避免创建 cmd 窗口
          },
          (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
          },
        );
        // 如果进程超时被 kill，execFile 回调仍会触发
      });
      console.log(result);
    } catch (err: any) {
      console.error('自动部署失败:', err.message);
    }
  });
  console.log('静态看板自动更新已启动（每日 21:07）');

  // 8. 求职 Agent 主动通知
  const careerChatId = config.eveningCheckin.chatId || config.report.targetChatId;
  if (careerChatId) {
    // 每日 9:00 投递跟进提醒
    cron.schedule('0 9 * * *', async () => {
      try {
        const { checkFollowUpReminders, checkInterviewReminders } = require('./career/notifications');
        const reminder = checkFollowUpReminders();
        if (reminder) {
          await mainSender.sendText(careerChatId, reminder.message);
          console.log('[Career] 跟进提醒已推送');
        }
        const interview = checkInterviewReminders();
        if (interview) {
          await mainSender.sendText(careerChatId, interview.message);
          console.log('[Career] 面试提醒已推送');
        }
      } catch (err: any) {
        console.error('[Career] 通知推送失败:', err.message);
      }
    });
    console.log(`求职通知定时任务已启动（每日9:00），推送目标: ${careerChatId}`);
  }

  // 9-11. 舆情监测相关定时任务已暂停
  // 如需恢复，取消下面三段的注释即可
  console.log('舆情监测定时任务已暂停（采集/日报推送/数据清理）');

  console.log('=== 飞书多 Agent Bot 系统启动完成 ===');
}

// ─── 全局异常捕获 ───

process.on('uncaughtException', (err) => {
  log.error('未捕获异常，进程即将退出', err);
  console.error(err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  log.error('未处理的 Promise 拒绝', reason instanceof Error ? reason : String(reason));
  console.error(reason);
});

// PM2 优雅关闭信号
process.on('SIGINT', () => {
  log.info('收到 SIGINT 信号，优雅关闭中...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('收到 SIGTERM 信号，优雅关闭中...');
  process.exit(0);
});

main().catch((err) => {
  log.error('启动失败', err);
  process.exit(1);
});
