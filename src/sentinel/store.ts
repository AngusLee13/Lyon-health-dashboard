/**
 * 天津城投舆情监测系统 — 数据持久层
 *
 * 遵循 src/health/store.ts 的文件 JSON 存储模式：
 *   - 文章按日期分文件存储（YYYY-MM-DD.json）
 *   - 预警记录按月聚合（YYYY-MM.json）
 *   - 报告缓存按日期/周存储
 *   - 采集游标状态持久化
 */

import fs from 'fs';
import path from 'path';
import { AnalyzedArticle, AlertRecord, DailySentinelReport, WeeklySentinelReport } from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('哨兵存储');

const DATA_DIR = path.resolve(__dirname, '../../.data/sentinel');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const ALERTS_DIR = path.join(DATA_DIR, 'alerts');
const REPORTS_DAILY_DIR = path.join(DATA_DIR, 'reports', 'daily');
const REPORTS_WEEKLY_DIR = path.join(DATA_DIR, 'reports', 'weekly');
const META_PATH = path.join(DATA_DIR, 'meta.json');

// ========== 目录保障 ==========

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureAllDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(ARTICLES_DIR);
  ensureDir(ALERTS_DIR);
  ensureDir(REPORTS_DAILY_DIR);
  ensureDir(REPORTS_WEEKLY_DIR);
}

// ========== 文章存储 ==========

/** 按日期获取文章文件路径 */
function articlesPath(date: string): string {
  // date 格式: YYYY-MM-DD
  const month = date.substring(0, 7); // YYYY-MM
  const dir = path.join(ARTICLES_DIR, month);
  ensureDir(dir);
  return path.join(dir, `${date}.json`);
}

/** 保存某日的分析文章（追加模式） */
export function saveArticles(date: string, articles: AnalyzedArticle[]): void {
  ensureAllDirs();
  const existing = getArticlesByDate(date);
  // 按 id 去重，新数据覆盖旧数据
  const map = new Map<string, AnalyzedArticle>();
  for (const a of existing) map.set(a.id, a);
  for (const a of articles) map.set(a.id, a);
  const merged = Array.from(map.values())
    .sort((a, b) => b.collectedAt - a.collectedAt);

  const p = articlesPath(date);
  fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf-8');
  log.info(`已保存 ${articles.length} 篇文章到 ${date}（合并后共 ${merged.length} 篇）`);
}

/** 读取某日的分析文章 */
export function getArticlesByDate(date: string): AnalyzedArticle[] {
  const p = articlesPath(date);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    if (!raw || !raw.trim()) return [];
    return JSON.parse(raw) as AnalyzedArticle[];
  } catch (err: any) {
    log.error(`读取文章失败 [${date}]`, err);
    return [];
  }
}

/** 按日期范围查询文章 */
export function queryArticles(dateFrom: string, dateTo: string): AnalyzedArticle[] {
  ensureAllDirs();
  const results: AnalyzedArticle[] = [];

  // 遍历月份目录查找
  const fromDate = new Date(dateFrom);
  const toDate = new Date(dateTo);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    log.error(`日期解析失败: dateFrom=${dateFrom}, dateTo=${dateTo}`);
    return [];
  }

  const months = getMonthDirs(ARTICLES_DIR, dateFrom, dateTo);
  for (const month of months) {
    const monthDir = path.join(ARTICLES_DIR, month);
    if (!fs.existsSync(monthDir)) continue;
    const files = fs.readdirSync(monthDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const date = file.replace('.json', '');
      if (date >= dateFrom && date <= dateTo) {
        results.push(...getArticlesByDate(date));
      }
    }
  }

  return results.sort((a, b) => b.collectedAt - a.collectedAt);
}

/** 获取月份目录列表 */
function getMonthDirs(baseDir: string, from: string, to: string): string[] {
  const months: string[] = [];
  const fromMonth = from.substring(0, 7);
  const toMonth = to.substring(0, 7);

  if (!fs.existsSync(baseDir)) return [];

  const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const dir of dirs) {
    if (dir >= fromMonth && dir <= toMonth) months.push(dir);
  }
  return months;
}

// ========== 预警记录存储 ==========

/** 按月获取预警文件路径 */
function alertsPath(month: string): string {
  // month 格式: YYYY-MM
  ensureDir(ALERTS_DIR);
  return path.join(ALERTS_DIR, `${month}.json`);
}

/** 追加预警记录 */
export function saveAlerts(month: string, alerts: AlertRecord[]): void {
  ensureAllDirs();
  const existing = getAlertsByMonth(month);
  const merged = [...existing, ...alerts];
  fs.writeFileSync(alertsPath(month), JSON.stringify(merged, null, 2), 'utf-8');
}

/** 读取某月预警记录 */
export function getAlertsByMonth(month: string): AlertRecord[] {
  const p = alertsPath(month);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as AlertRecord[];
  } catch {
    return [];
  }
}

/** 确认预警 */
export function acknowledgeAlert(alertId: string, acknowledgedBy?: string): boolean {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const alerts = getAlertsByMonth(month);
  const alert = alerts.find(a => a.id === alertId);
  if (!alert) return false;
  alert.acknowledged = true;
  alert.acknowledgedAt = Date.now();
  if (acknowledgedBy) alert.acknowledgedBy = acknowledgedBy;
  fs.writeFileSync(alertsPath(month), JSON.stringify(alerts, null, 2), 'utf-8');
  return true;
}

// ========== 报告存储 ==========

/** 保存日报 */
export function saveDailyReport(report: DailySentinelReport): void {
  ensureDir(REPORTS_DAILY_DIR);
  const p = path.join(REPORTS_DAILY_DIR, `${report.date}.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2), 'utf-8');
  log.info(`日报已保存: ${report.date}`);
}

/** 读取日报 */
export function getDailyReport(date: string): DailySentinelReport | null {
  const p = path.join(REPORTS_DAILY_DIR, `${date}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as DailySentinelReport;
  } catch {
    return null;
  }
}

/** 保存周报 */
export function saveWeeklyReport(report: WeeklySentinelReport): void {
  ensureDir(REPORTS_WEEKLY_DIR);
  const p = path.join(REPORTS_WEEKLY_DIR, `${report.weekStart}.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2), 'utf-8');
  log.info(`周报已保存: ${report.weekStart} ~ ${report.weekEnd}`);
}

/** 读取周报 */
export function getWeeklyReport(weekStart: string): WeeklySentinelReport | null {
  const p = path.join(REPORTS_WEEKLY_DIR, `${weekStart}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as WeeklySentinelReport;
  } catch {
    return null;
  }
}

// ========== 元数据 ==========

interface SentinelMeta {
  lastCollectionTime: number | null;
  lastAnalysisTime: number | null;
  lastRssFetchTimestamps: Record<string, number>;  // URL → 上次拉取时间
  lastSearchTimestamps: Record<string, number>;    // 关键词 → 上次搜索时间
  version: number;
}

const DEFAULT_META: SentinelMeta = {
  lastCollectionTime: null,
  lastAnalysisTime: null,
  lastRssFetchTimestamps: {},
  lastSearchTimestamps: {},
  version: 1,
};

export function getMeta(): SentinelMeta {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(META_PATH)) {
    fs.writeFileSync(META_PATH, JSON.stringify(DEFAULT_META, null, 2), 'utf-8');
    return DEFAULT_META;
  }
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf-8')) as SentinelMeta;
  } catch {
    return DEFAULT_META;
  }
}

export function saveMeta(updates: Partial<SentinelMeta>): void {
  const current = getMeta();
  const updated = { ...current, ...updates };
  fs.writeFileSync(META_PATH, JSON.stringify(updated, null, 2), 'utf-8');
}

// ========== 数据清理 ==========

/** 清理超过保留期的数据 */
export function cleanupOldData(retentionDays: number): number {
  ensureAllDirs();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().substring(0, 10);
  let cleaned = 0;

  // 清理文章
  if (fs.existsSync(ARTICLES_DIR)) {
    const monthDirs = fs.readdirSync(ARTICLES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const monthDir of monthDirs) {
      const monthPath = path.join(ARTICLES_DIR, monthDir.name);
      const files = fs.readdirSync(monthPath).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const date = file.replace('.json', '');
        if (date < cutoffStr) {
          fs.unlinkSync(path.join(monthPath, file));
          cleaned++;
        }
      }
    }
  }

  // 清理报告
  if (fs.existsSync(REPORTS_DAILY_DIR)) {
    const reports = fs.readdirSync(REPORTS_DAILY_DIR).filter(f => f.endsWith('.json'));
    for (const file of reports) {
      const date = file.replace('.json', '');
      if (date < cutoffStr) {
        fs.unlinkSync(path.join(REPORTS_DAILY_DIR, file));
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    log.info(`数据清理完成：移除 ${cleaned} 个过期文件（截止 ${cutoffStr}）`);
  }
  return cleaned;
}
