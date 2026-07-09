import fs from 'fs';
import path from 'path';
import { DailyRecord, WeeklyReport, MonthlyReport, Anomaly, Trend } from './types';

const DATA_DIR = path.resolve(__dirname, '../../.data/health');

// —— sparkline 微趋势（与 reportGenerator 保持一致的实现）——
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function spark(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return SPARK[3].repeat(values.length);
  return values.map(v => SPARK[Math.round(((v - min) / (max - min)) * (SPARK.length - 1))]).join('');
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function recordPath(date: string): string {
  return path.join(DATA_DIR, `${date}.json`);
}

const BACKUP_DIR = path.resolve(__dirname, '../../.data/health/.backup');

function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/** 保存或更新某天的日报（写入前自动备份旧文件） */
export function saveDailyRecord(record: DailyRecord): void {
  ensureDir();
  const p = recordPath(record.date);
  // 写入前备份旧文件（保留最近 10 个版本）
  if (fs.existsSync(p)) {
    ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${record.date}__${ts}.json`;
    fs.copyFileSync(p, path.join(BACKUP_DIR, backupName));
    // 清理该日期的旧备份，只保留最近 10 个
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(record.date + '__'))
      .sort()
      .reverse();
    for (const old of backups.slice(10)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
  }
  fs.writeFileSync(p, JSON.stringify(record, null, 2), 'utf-8');
}

/** 获取某天日报的所有备份版本 */
export function listBackups(date: string): string[] {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(date + '__'))
    .sort()
    .reverse();
}

/** 从备份恢复某天日报 */
export function restoreFromBackup(date: string, backupFile: string): DailyRecord | null {
  const p = path.join(BACKUP_DIR, backupFile);
  if (!fs.existsSync(p)) return null;
  const record = JSON.parse(fs.readFileSync(p, 'utf-8'));
  saveDailyRecord(record);
  return record;
}

/** 读取某天日报（损坏文件自动返回 null，不会抛异常） */
export function getDailyRecord(date: string): DailyRecord | null {
  const p = recordPath(date);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    if (!raw || !raw.trim()) {
      console.warn(`[健康存储] ${date} 数据文件为空，忽略`);
      return null;
    }
    const parsed = JSON.parse(raw);
    // 验证基本结构
    if (!parsed || typeof parsed !== 'object' || !parsed.date) {
      console.warn(`[健康存储] ${date} 数据文件结构异常: ${typeof parsed}`);
      return null;
    }
    return parsed;
  } catch (err: any) {
    console.error(`[健康存储] 读取 ${date} 数据失败: ${err.message}`);
    return null;
  }
}

/** 按日期范围读取日报列表（损坏文件跳过，不影响整体查询） */
export function getDailyRecords(startDate: string, endDate: string): DailyRecord[] {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const records: DailyRecord[] = [];
  for (const f of files) {
    const d = f.replace('.json', '');
    if (d >= startDate && d <= endDate) {
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && parsed.date) {
            records.push(parsed);
          }
        }
      } catch (err: any) {
        console.warn(`[健康存储] 跳过损坏文件 ${f}: ${err.message}`);
      }
    }
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

/** 列出所有有记录的日期 */
export function listRecordDates(): string[] {
  ensureDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
}

// ——— 异常检测 ———

const BASELINES: Record<string, { mean: number; stdDev: number; unit: string }> = {
  sleepDuration: { mean: 7.5, stdDev: 1, unit: '小时' },
  sleepQuality:  { mean: 3.0, stdDev: 0.5, unit: '分' },   // 1-4
  weight:         { mean: 118, stdDev: 2.0, unit: 'kg' },
  calories:       { mean: 2100, stdDev: 400, unit: 'kcal' },
  trainingVolume: { mean: 14000, stdDev: 4000, unit: 'kg·次' },
};

function qualityScore(q: string): number {
  const map: Record<string, number> = { poor: 1, fair: 2, good: 3, excellent: 4 };
  return map[q] || 3;
}

function adherenceScore(a: string): number {
  const map: Record<string, number> = { poor: 1, fair: 2, good: 3, excellent: 4 };
  return map[a] || 3;
}

export function detectAnomalies(records: DailyRecord[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  if (records.length < 3) return anomalies;

  // 睡眠时长异常
  for (const r of records) {
    const dur = r.sleep.duration;
    const base = BASELINES.sleepDuration;
    const dev = Math.abs(dur - base.mean) / base.stdDev;
    if (dev > 2) {
      anomalies.push({
        metric: '睡眠时长', date: r.date, value: dur, baseline: base.mean,
        deviation: Math.round(((dur - base.mean) / base.mean) * 100),
        severity: dev > 2.5 ? 'high' : dev > 2 ? 'medium' : 'low',
        suggestion: dur < base.mean
          ? '睡眠不足，建议提前入睡时间或减少睡前屏幕使用'
          : '睡眠偏长，检查睡眠质量是否因深睡不足而需要补时长',
      });
    }
  }

  // 体重异常（单日波动 > 1.5kg 且不是连续趋势）
  const weights = records.filter(r => r.weight != null);
  for (let i = 1; i < weights.length; i++) {
    const prev = weights[i - 1].weight!;
    const curr = weights[i].weight!;
    const change = Math.abs(curr - prev);
    if (change > 1.5) {
      anomalies.push({
        metric: '体重', date: weights[i].date, value: curr, baseline: prev,
        deviation: Math.round(((curr - prev) / prev) * 100),
        severity: change > 2.5 ? 'high' : 'medium',
        suggestion: change > 0
          ? '体重突然上升，可能是水肿或饮食过量，检查钠摄入和碳水'
          : '体重突然下降，可能脱水或热量缺口偏大，检查水分和蛋白质摄入',
      });
    }
  }

  // 力量训练容量异常
  for (const r of records) {
    if (!r.training) continue;
    const vol = r.training.exercises.reduce((sum, e) => sum + e.sets * e.reps * e.weight, 0);
    const base = BASELINES.trainingVolume;
    const dev = (vol - base.mean) / base.stdDev;
    if (dev > 2) {
      anomalies.push({
        metric: '训练容量', date: r.date, value: vol, baseline: base.mean,
        deviation: Math.round(((vol - base.mean) / base.mean) * 100),
        severity: dev > 3 ? 'high' : 'medium',
        suggestion: '单日训练容量异常偏高，注意恢复，避免过度训练导致皮质醇升高阻碍减脂',
      });
    }
  }

  // 有氧消耗异常（>800kcal 偏高）
  for (const r of records) {
    const cardioCal = r.cardio?.calories || 0;
    if (cardioCal > 800) {
      anomalies.push({
        metric: '有氧消耗', date: r.date, value: cardioCal, baseline: 400,
        deviation: Math.round(((cardioCal - 400) / 400) * 100),
        severity: cardioCal > 1200 ? 'high' : 'medium',
        suggestion: '有氧消耗偏高，注意补充碳水和电解质避免肌肉流失',
      });
    }
  }

  // 钠摄入异常（单日 >2500mg 或 >目标 150%）
  for (const r of records) {
    const diet = r.diet as any;
    const sodium = diet?.totalSodium || 0;
    if (sodium > 2500) {
      anomalies.push({
        metric: '钠摄入', date: r.date, value: sodium, baseline: 2000,
        deviation: Math.round(((sodium - 2000) / 2000) * 100),
        severity: sodium > 3500 ? 'high' : 'medium',
        suggestion: sodium > 3500
          ? '钠摄入严重超标，可能导致水肿/血压升高，明日严格控制加工食品和调味品用量'
          : '钠摄入偏高，注意减少外卖/加工食品，多用天然香料替代盐和酱油',
      });
    }
  }

  return anomalies;
}

// ——— 趋势分析 ———

export function detectTrends(records: DailyRecord[]): Trend[] {
  const trends: Trend[] = [];
  if (records.length < 7) return trends;

  const half = Math.floor(records.length / 2);
  const firstHalf = records.slice(0, half);
  const secondHalf = records.slice(half);

  function avg(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  // 体重趋势
  const w1 = firstHalf.filter(r => r.weight).map(r => r.weight!);
  const w2 = secondHalf.filter(r => r.weight).map(r => r.weight!);
  if (w1.length >= 2 && w2.length >= 2) {
    const a1 = avg(w1), a2 = avg(w2);
    const pct = ((a2 - a1) / a1) * 100;
    trends.push({
      metric: '体重', direction: pct < -0.5 ? 'down' : pct > 0.5 ? 'up' : 'stable',
      change: Number(pct.toFixed(1)),
      interpretation: pct < -0.5 ? '体重在下降趋势中，继续当前方案' : pct > 0.5 ? '体重上升趋势，需调整饮食或增加有氧' : '体重保持稳定',
    });
  }

  // 睡眠趋势
  const s1 = avg(firstHalf.map(r => r.sleep.duration));
  const s2 = avg(secondHalf.map(r => r.sleep.duration));
  const sleepPct = ((s2 - s1) / s1) * 100;
  trends.push({
    metric: '睡眠时长', direction: Math.abs(sleepPct) < 2 ? 'stable' : sleepPct > 0 ? 'up' : 'down',
    change: Number(sleepPct.toFixed(1)),
    interpretation: sleepPct > 3 ? '睡眠在改善' : sleepPct < -3 ? '睡眠在下滑，需关注' : '睡眠保持稳定',
  });

  return trends;
}

// ——— 报告生成 ———

function summarySleep(records: DailyRecord[]): string {
  const avgDur = records.reduce((s, r) => s + r.sleep.duration, 0) / records.length;
  const avgQ = records.reduce((s, r) => s + qualityScore(r.sleep.quality), 0) / records.length;
  const lateCount = records.filter(r => {
    const h = parseInt(r.sleep.bedTime.split(':')[0]);
    return h >= 24 || h <= 1;
  }).length;
  let s = `平均睡眠 ${avgDur.toFixed(1)}h`;
  if (lateCount > records.length * 0.3) s += `，${lateCount}天凌晨后入睡需改善`;
  return s;
}

function summaryTraining(records: DailyRecord[]): string {
  const strengthDays = records.filter(r => r.training).length;
  const cardioDays = records.filter(r => r.cardio).length;
  const anyTrain = records.filter(r => r.training || r.cardio);
  const totalCal = anyTrain.reduce((s, r) =>
    s + (r.training?.calories || 0) + (r.cardio?.calories || 0), 0);
  const parts = [`${anyTrain.length}/${records.length} 天训练`];
  if (strengthDays > 0 && cardioDays > 0) {
    parts.push(`（力量${strengthDays}天 + 有氧${cardioDays}天）`);
  }
  parts.push(`，总消耗 ${totalCal} kcal`);
  return parts.join('');
}

function summaryDiet(records: DailyRecord[]): string {
  const withDiet = records.filter(r => r.diet);
  if (!withDiet.length) return '无饮食记录';
  const avgAdh = withDiet.reduce((s, r) => s + adherenceScore(r.diet!.adherence), 0) / withDiet.length;
  const label = avgAdh >= 3.5 ? '优秀' : avgAdh >= 2.5 ? '良好' : avgAdh >= 1.5 ? '一般' : '差';
  return `饮食依从度: ${label}`;
}

/** 提取记录的每日热量和体重数组，生成趋势摘要 */
function summaryTrends(records: DailyRecord[]): string {
  if (records.length < 3) return '';
  const sorted = records.sort((a, b) => a.date.localeCompare(b.date));
  const calories: number[] = [];
  const weights: number[] = [];

  for (const r of sorted) {
    if (r.diet) {
      let total = 0;
      for (const m of r.diet.meals || []) {
        total += m.calories || 0;
      }
      if (r.diet.totalCalories && r.diet.totalCalories > total) total = r.diet.totalCalories;
      calories.push(total > 0 ? total : 0);
    } else {
      calories.push(0);
    }
    weights.push(r.weight || 0);
  }

  const parts: string[] = [];
  const hasCal = calories.some(v => v > 0);
  const hasWt = weights.some(v => v > 0);
  if (hasCal) parts.push(`热量 ${spark(calories)}`);
  if (hasWt) parts.push(`体重 ${spark(weights)}`);
  return parts.join('  ');
}

export function generateWeeklyReport(startDate: string, endDate: string): WeeklyReport {
  const records = getDailyRecords(startDate, endDate);
  const withTraining = records.filter(r => r.training || r.cardio);
  const withDiet = records.filter(r => r.diet);
  const withWeight = records.filter(r => r.weight);

  const anomalies = detectAnomalies(records);

  const totalTrainCals = withTraining.reduce((s, r) =>
    s + (r.training?.calories || 0) + (r.cardio?.calories || 0), 0);

  const report: WeeklyReport = {
    weekStart: startDate,
    weekEnd: endDate,
    days: records,
    averages: {
      sleepDuration: Math.round((records.reduce((s, r) => s + r.sleep.duration, 0) / records.length) * 10) / 10 || 0,
      sleepQuality: Math.round((records.reduce((s, r) => s + qualityScore(r.sleep.quality), 0) / records.length) * 10) / 10 || 0,
      trainingCalories: withTraining.length ? Math.round(totalTrainCals / withTraining.length) : 0,
      trainingDays: withTraining.length,
      weight: withWeight.length ? Math.round(withWeight.reduce((s, r) => s + r.weight!, 0) / withWeight.length * 10) / 10 : undefined,
      dietAdherence: withDiet.length ? Math.round((withDiet.reduce((s, r) => s + adherenceScore(r.diet!.adherence), 0) / withDiet.length) * 10) / 10 : 0,
    },
    anomalies,
    summary: `${summarySleep(records)}；${summaryTraining(records)}；${summaryDiet(records)}。${summaryTrends(records)}`,
  };

  return report;
}

export function generateMonthlyReport(month: string): MonthlyReport {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const startDate = `${month}-01`;
  const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;
  const records = getDailyRecords(startDate, endDate);

  // 按周拆分
  const weeks: WeeklyReport[] = [];
  let wStart = startDate;
  while (wStart <= endDate) {
    const d = new Date(wStart);
    d.setDate(d.getDate() + 6);
    const wEnd = d.toISOString().slice(0, 10);
    const weekRecords = records.filter(r => r.date >= wStart && r.date <= (wEnd > endDate ? endDate : wEnd));
    if (weekRecords.length) {
      weeks.push(generateWeeklyReport(wStart, wEnd > endDate ? endDate : wEnd));
    }
    d.setDate(d.getDate() + 1);
    wStart = d.toISOString().slice(0, 10);
  }

  const withTraining = records.filter(r => r.training || r.cardio);
  const withDiet = records.filter(r => r.diet);
  const withWeight = records.filter(r => r.weight);
  const anomalies = detectAnomalies(records);
  const trends = detectTrends(records);

  const totalTrainCalsMonth = withTraining.reduce((s, r) =>
    s + (r.training?.calories || 0) + (r.cardio?.calories || 0), 0);

  return {
    month,
    weeks,
    averages: {
      sleepDuration: Math.round((records.reduce((s, r) => s + r.sleep.duration, 0) / records.length) * 10) / 10 || 0,
      sleepQuality: Math.round((records.reduce((s, r) => s + qualityScore(r.sleep.quality), 0) / records.length) * 10) / 10 || 0,
      trainingCalories: withTraining.length ? Math.round(totalTrainCalsMonth / withTraining.length) : 0,
      trainingDays: withTraining.length,
      weight: withWeight.length ? Math.round(withWeight.reduce((s, r) => s + r.weight!, 0) / withWeight.length * 10) / 10 : undefined,
      dietAdherence: withDiet.length ? Math.round((withDiet.reduce((s, r) => s + adherenceScore(r.diet!.adherence), 0) / withDiet.length) * 10) / 10 : 0,
    },
    trends,
    anomalies,
    summary: `${summarySleep(records)}；${summaryTraining(records)}；${summaryDiet(records)}。${summaryTrends(records)}`,
  };
}
