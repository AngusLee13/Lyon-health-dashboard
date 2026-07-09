import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(__dirname, '../../.data/career');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: any): void {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── 投递记录 ───

export interface JobApplication {
  id: string;
  company: string;
  title: string;
  status: 'applied' | 'phone_screen' | 'interview' | 'offer' | 'rejected' | 'accepted' | 'withdrawn';
  appliedDate: string;
  notes: string;
  nextFollowUp?: string;
  interviews: Interview[];
  jd?: string;
  matchScore?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Interview {
  type: string;          // phone / video / onsite / panel
  scheduledDate: string; // ISO datetime
  location?: string;
  notes?: string;
  status: 'scheduled' | 'completed' | 'cancelled';
  feedback?: string;
}

const APPS_FILE = path.join(DATA_DIR, 'applications.json');

export function getApplications(): JobApplication[] {
  return readJson<JobApplication[]>(APPS_FILE, []);
}

export function saveApplications(apps: JobApplication[]): void {
  writeJson(APPS_FILE, apps);
}

export function addApplication(app: JobApplication): void {
  const apps = getApplications();
  apps.push(app);
  saveApplications(apps);
}

export function updateApplication(id: string, updates: Partial<JobApplication>): JobApplication | null {
  const apps = getApplications();
  const idx = apps.findIndex(a => a.id === id);
  if (idx < 0) return null;
  apps[idx] = { ...apps[idx], ...updates, updatedAt: Date.now() };
  saveApplications(apps);
  return apps[idx];
}

// ─── 用户档案 ───

export interface CareerProfile {
  chatId: string;
  resumeSummary?: string;    // 简历核心摘要（用于快速匹配）
  targetRoles: string[];      // 目标岗位
  preferredLocations: string[];
  certifications: string[];   // 已有证书
  skills: string[];           // 核心技能列表
  notificationPrefs: {
    jobDigest: boolean;
    followUpReminders: boolean;
    regulatoryBriefing: boolean;
  };
  updatedAt: number;
}

const PROFILE_FILE = path.join(DATA_DIR, 'userProfile.json');

export function getProfile(): CareerProfile {
  return readJson<CareerProfile>(PROFILE_FILE, {
    chatId: '',
    targetRoles: [],
    preferredLocations: [],
    certifications: [],
    skills: [],
    notificationPrefs: { jobDigest: true, followUpReminders: true, regulatoryBriefing: true },
    updatedAt: 0,
  });
}

export function saveProfile(profile: CareerProfile): void {
  profile.updatedAt = Date.now();
  writeJson(PROFILE_FILE, profile);
}

// ─── 通用缓存 ───

export function getCache<T>(key: string, ttlMs: number): T | null {
  const filePath = path.join(DATA_DIR, `cache_${key}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > ttlMs) return null;
    return data as T;
  } catch {
    return null;
  }
}

export function setCache(key: string, data: any): void {
  const filePath = path.join(DATA_DIR, `cache_${key}.json`);
  writeJson(filePath, { data, timestamp: Date.now() });
}

// ─── 简历数据持久化 ───
// 将 ResumeData 独立存储，方便 Claude Code 直接读写，
// 不再需要通过 workflowState 间接访问。

import { ResumeData } from './pdfService';

const RESUME_FILE = path.join(DATA_DIR, 'resume.json');

/** 读取已保存的简历数据 */
export function getResumeData(): ResumeData | null {
  return readJson<ResumeData | null>(RESUME_FILE, null);
}

/** 保存简历数据（自动记录更新时间） */
export function saveResumeData(data: ResumeData): void {
  const payload = { ...data, _updatedAt: Date.now() };
  writeJson(RESUME_FILE, payload);
}
