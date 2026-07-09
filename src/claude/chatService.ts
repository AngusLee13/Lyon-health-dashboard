import OpenAI from 'openai';
import { getDeepSeekClient } from './client';
import { config } from '../config';
import { SessionManager, ChatMessage } from '../session/manager';
import { MessageSender } from '../feishu/messageSender';
import { saveConversationMemory } from '../memory/bridge';

export interface ProcessMessageParams {
  chatId: string;
  chatType: string;
  messageId: string;
  content: string;
  /** 当前对话使用的 Agent 信息（用于记忆分类） */
  agentId?: string;
  agentName?: string;
}

const DEFAULT_SYSTEM_PROMPT = `你是 AI 助手，通过飞书机器人与用户交流。请遵循以下原则：
- 使用中文回答用户问题
- 回答简洁明了，避免不必要的冗长
- 保持友好和专业的语气
- 如不确定答案，诚实告知用户`;

export class ChatService {
  private client: OpenAI;
  private sessionManager: SessionManager;
  private messageSender: MessageSender;
  private systemPrompt: string;
  /** 当前对话的 Agent 信息 */
  private currentAgentId?: string;
  private currentAgentName?: string;

  constructor(sessionManager: SessionManager, messageSender: MessageSender, systemPrompt?: string) {
    this.client = getDeepSeekClient();
    this.sessionManager = sessionManager;
    this.messageSender = messageSender;
    this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  /** 设置当前对话的 Agent 信息（用于记忆同步时标注来源） */
  setAgentInfo(agentId?: string, agentName?: string): void {
    this.currentAgentId = agentId;
    this.currentAgentName = agentName;
  }

  async processMessage(
    params: ProcessMessageParams,
    onToken: (text: string) => Promise<void>,
    onComplete: (fullText: string) => Promise<void>,
    onError: (error: string) => Promise<void>,
    context?: string,
  ): Promise<void> {
    const { chatId, chatType, messageId, content } = params;

    try {
      await this.sessionManager.getOrCreate(chatId, chatType);

      const history = await this.sessionManager.getHistory(chatId, config.session.maxHistoryLength);

      await this.sessionManager.appendHistory(chatId, 'user', content, messageId);

      const messages = this.buildMessages(history, content, context);

      const stream = await this.client.chat.completions.create({
        model: config.deepseek.model,
        max_tokens: config.deepseek.maxTokens,
        messages,
        stream: true,
      });

      let fullText = '';
      let lastUpdateTime = Date.now();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullText += delta;

          const now = Date.now();
          if (now - lastUpdateTime >= 200) {
            await onToken(fullText);
            lastUpdateTime = now;
          }
        }
      }

      if (fullText) {
        await onToken(fullText);
        await onComplete(fullText);

        await this.sessionManager.appendHistory(chatId, 'assistant', fullText);

        // ── 同步对话到 Claude Code 记忆系统 ──
        saveConversationMemory({
          timestamp: Date.now(),
          chatId,
          agentId: this.currentAgentId,
          agentName: this.currentAgentName,
          userMessage: content,
          assistantReply: fullText,
        });
      } else {
        await onError('未收到有效回复');
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.error('DeepSeek API 调用失败:', errorMsg);
      await onError(`调用失败: ${errorMsg}`);
    }
  }

  private buildMessages(history: ChatMessage[], currentContent: string, context?: string): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt },
    ];

    if (context) {
      result.push({ role: 'system', content: context });
    }

    for (const msg of history) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    }

    result.push({ role: 'user', content: currentContent });
    return result;
  }
}
