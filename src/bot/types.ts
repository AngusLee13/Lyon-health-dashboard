export type BotRole = 'router' | 'health' | 'code' | 'career' | 'general';

export interface BotConfig {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  role: BotRole;
  systemPrompt: string;
  routerPrompt?: string;
  enabled: boolean;
  fallbackToMain?: boolean;
  /** Obsidian Vault 中知识目录路径，启动时自动加载并注入 systemPrompt */
  obsidianKnowledgePaths?: string[];
}

export interface BotsFile {
  bots: BotConfig[];
}
