import fs from 'fs';
import path from 'path';
import { ResumeData } from './pdfService';

const WORKFLOW_DIR = path.resolve(__dirname, '../../.data/career/workflow');

export type CareerPhase =
  | 'onboarding'       // 初次使用
  | 'resume_input'     // 简历录入中
  | 'resume_optimizing'// 简历优化中
  | 'job_searching'    // 职位搜索中
  | 'interviewing'     // 面试阶段
  | 'negotiating'      // 谈薪阶段
  | 'onboarded';       // 已入职

export interface WorkflowState {
  chatId: string;
  currentPhase: CareerPhase;
  lastResumeData?: ResumeData;
  activeApplicationIds: string[];
  lastAction: string;
  lastActionTime: number;
  pendingSuggestions: string[];
  updatedAt: number;
}

function filePath(chatId: string): string {
  if (!fs.existsSync(WORKFLOW_DIR)) fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
  return path.join(WORKFLOW_DIR, `${chatId.replace(/[^\w-]/g, '_')}.json`);
}

export function getWorkflowState(chatId: string): WorkflowState {
  try {
    const fp = filePath(chatId);
    if (!fs.existsSync(fp)) return defaultState(chatId);
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as WorkflowState;
  } catch {
    return defaultState(chatId);
  }
}

export function saveWorkflowState(state: WorkflowState): void {
  state.updatedAt = Date.now();
  fs.writeFileSync(filePath(state.chatId), JSON.stringify(state, null, 2), 'utf-8');
}

function defaultState(chatId: string): WorkflowState {
  return {
    chatId,
    currentPhase: 'onboarding',
    activeApplicationIds: [],
    lastAction: '',
    lastActionTime: 0,
    pendingSuggestions: [],
    updatedAt: Date.now(),
  };
}

/** 更新工作流状态并返回应提示的下一步建议 */
export function updatePhase(
  chatId: string,
  phase: CareerPhase,
  action: string,
  suggestions: string[] = [],
): WorkflowState {
  const state = getWorkflowState(chatId);
  state.currentPhase = phase;
  state.lastAction = action;
  state.lastActionTime = Date.now();
  state.pendingSuggestions = suggestions;
  saveWorkflowState(state);
  return state;
}

/** 生成欢迎回来的上下文摘要 */
export function getWelcomeBackContext(chatId: string): string | null {
  const state = getWorkflowState(chatId);
  if (state.currentPhase === 'onboarding') return null;

  const lines: string[] = ['👋 欢迎回来！当前求职进度：', ''];

  if (state.currentPhase === 'resume_input') lines.push('📝 简历还在完善中');
  if (state.currentPhase === 'resume_optimizing') lines.push('🔧 简历优化中，随时可以 `/分析简历` 查看最新评分');
  if (state.currentPhase === 'job_searching') lines.push('🔍 正在寻找机会，可以 `/职位查询` 继续搜索');
  if (state.currentPhase === 'interviewing' && state.activeApplicationIds.length > 0) {
    lines.push(`🎯 ${state.activeApplicationIds.length} 个岗位在面试流程中，输入 \`/进度\` 查看详情`);
  }
  if (state.pendingSuggestions.length > 0) {
    lines.push('', `💡 ${state.pendingSuggestions[0]}`);
  }

  return lines.join('\n');
}
