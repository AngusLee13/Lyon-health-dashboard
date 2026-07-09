import OpenAI from 'openai';
import { config } from '../config';

let openaiClient: OpenAI | null = null;

export function getDeepSeekClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.deepseek.apiKey,
      baseURL: config.deepseek.baseUrl,
    });
  }
  return openaiClient;
}
