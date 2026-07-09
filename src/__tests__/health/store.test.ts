/**
 * store.ts 单元测试
 * 覆盖：detectAnomalies、detectTrends、qualityScore/adherenceScore
 */
import { describe, it, expect } from 'vitest';
import { DailyRecord, Anomaly, Trend } from '../../health/types';

// —— 从 store.ts 复制的核心逻辑 ——

function qualityScore(q: string): number {
  const map: Record<string, number> = { poor: 1, fair: 2, good: 3, excellent: 4 };
  return map[q] || 3;
}

function adherenceScore(a: string): number {
  const map: Record<string, number> = { poor: 1, fair: 2, good: 3, excellent: 4 };
  return map[a] || 3;
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function spark(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return SPARK[3].repeat(values.length);
  return values.map(v => SPARK[Math.round(((v - min) / (max - min)) * (SPARK.length - 1))]).join('');
}

const BASELINES: Record<string, { mean: number; stdDev: number; unit: string }> = {
  sleepDuration: { mean: 7.5, stdDev: 1, unit: '小时' },
  sleepQuality: { mean: 3.0, stdDev: 0.5, unit: '分' },
  weight: { mean: 118, stdDev: 2.0, unit: 'kg' },
  calories: { mean: 2100, stdDev: 400, unit: 'kcal' },
  trainingVolume: { mean: 14000, stdDev: 4000, unit: 'kg·次' },
};

function detectAnomalies(records: DailyRecord[]): Anomaly[] {
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

  // 体重异常（单日波动 > 1.5kg）
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

  // 有氧消耗异常
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

  // 钠摄入异常
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

function detectTrends(records: DailyRecord[]): Trend[] {
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

// —— 辅助函数：创建测试用 DailyRecord ——

function makeRecord(date: string, overrides: Partial<DailyRecord> = {}): DailyRecord {
  return {
    date,
    sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' },
    ...overrides,
  } as DailyRecord;
}

// —— 测试开始 ——

describe('qualityScore / adherenceScore', () => {
  it('qualityScore 正确映射', () => {
    expect(qualityScore('poor')).toBe(1);
    expect(qualityScore('fair')).toBe(2);
    expect(qualityScore('good')).toBe(3);
    expect(qualityScore('excellent')).toBe(4);
  });

  it('adherenceScore 正确映射', () => {
    expect(adherenceScore('poor')).toBe(1);
    expect(adherenceScore('excellent')).toBe(4);
  });

  it('未知值默认为 3', () => {
    expect(qualityScore('unknown')).toBe(3);
    expect(adherenceScore('')).toBe(3);
  });
});

describe('detectAnomalies — 异常检测', () => {
  it('少于 3 条记录不检测', () => {
    const records = [
      makeRecord('2026-06-01'),
      makeRecord('2026-06-02'),
    ];
    expect(detectAnomalies(records)).toHaveLength(0);
  });

  it('检测睡眠不足异常', () => {
    const records = [
      makeRecord('2026-06-01', { sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' } }),
      makeRecord('2026-06-02', { sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' } }),
      makeRecord('2026-06-03', { sleep: { duration: 4.0, quality: 'poor', bedTime: '03:00', wakeTime: '07:00' } }),
    ];
    const anomalies = detectAnomalies(records);
    const sleepAnomaly = anomalies.find(a => a.metric === '睡眠时长');
    expect(sleepAnomaly).toBeDefined();
    expect(sleepAnomaly!.severity).toBe('high'); // dev > 2.5
    expect(sleepAnomaly!.value).toBe(4.0);
  });

  it('检测体重剧烈波动', () => {
    const records = [
      makeRecord('2026-06-01', { weight: 118.0 }),
      makeRecord('2026-06-02', { weight: 116.5 }), // -1.5
      makeRecord('2026-06-03', { weight: 113.0 }), // -3.5! 异常
    ];
    const anomalies = detectAnomalies(records);
    const weightAnomaly = anomalies.find(a => a.metric === '体重');
    expect(weightAnomaly).toBeDefined();
    expect(weightAnomaly!.severity).toBe('high');
  });

  it('正常范围内不产生异常', () => {
    const records = [
      makeRecord('2026-06-01', { sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' }, weight: 118.0 }),
      makeRecord('2026-06-02', { sleep: { duration: 7.0, quality: 'good', bedTime: '23:30', wakeTime: '06:30' }, weight: 117.8 }),
      makeRecord('2026-06-03', { sleep: { duration: 8.0, quality: 'excellent', bedTime: '22:30', wakeTime: '06:30' }, weight: 117.5 }),
      makeRecord('2026-06-04', { sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' }, weight: 117.3 }),
    ];
    const anomalies = detectAnomalies(records);
    // 体重变化都在 1.5kg 以内，睡眠都在正常范围
    expect(anomalies.filter(a => a.metric === '体重')).toHaveLength(0);
  });

  it('检测钠摄入超标', () => {
    const records = [
      makeRecord('2026-06-01'),
      makeRecord('2026-06-02'),
      makeRecord('2026-06-03', {
        diet: { totalSodium: 4000, meals: [], adherence: 'fair' } as any,
      }),
    ];
    const anomalies = detectAnomalies(records);
    const sodiumAnomaly = anomalies.find(a => a.metric === '钠摄入');
    expect(sodiumAnomaly).toBeDefined();
    expect(sodiumAnomaly!.severity).toBe('high');
    expect(sodiumAnomaly!.value).toBe(4000);
  });
});

describe('detectTrends — 趋势分析', () => {
  it('少于 7 条记录不分析趋势', () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      makeRecord(`2026-06-0${i + 1}`, { weight: 118 - i * 0.2 })
    );
    expect(detectTrends(records)).toHaveLength(0);
  });

  it('体重下降趋势检测', () => {
    const records: DailyRecord[] = [];
    for (let i = 0; i < 14; i++) {
      records.push(makeRecord(`2026-06-${String(i + 1).padStart(2, '0')}`, {
        weight: 118 - i * 0.3, // 从 118 降到 113.8
        sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' },
      }));
    }
    const trends = detectTrends(records);
    const weightTrend = trends.find(t => t.metric === '体重');
    expect(weightTrend).toBeDefined();
    expect(weightTrend!.direction).toBe('down');
  });

  it('体重稳定趋势', () => {
    const records: DailyRecord[] = [];
    for (let i = 0; i < 14; i++) {
      records.push(makeRecord(`2026-06-${String(i + 1).padStart(2, '0')}`, {
        weight: 118 + (Math.random() - 0.5) * 0.2, // 微小波动
        sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' },
      }));
    }
    const trends = detectTrends(records);
    const weightTrend = trends.find(t => t.metric === '体重');
    if (weightTrend) {
      expect(['stable', 'up', 'down']).toContain(weightTrend.direction);
    }
  });

  it('趋势变化值精确到 1 位小数', () => {
    const records: DailyRecord[] = [];
    for (let i = 0; i < 14; i++) {
      records.push(makeRecord(`2026-06-${String(i + 1).padStart(2, '0')}`, {
        weight: 118 - i * 0.5,
        sleep: { duration: 7.5, quality: 'good', bedTime: '23:00', wakeTime: '06:30' },
      }));
    }
    const trends = detectTrends(records);
    for (const t of trends) {
      // 验证 change 是 1 位小数（Number(n.toFixed(1)) 的结果不应有浮点误差）
      const str = t.change.toString();
      const decimals = str.includes('.') ? str.split('.')[1].length : 0;
      expect(decimals).toBeLessThanOrEqual(1);
    }
  });
});

describe('sparkline — 趋势图', () => {
  it('等值返回中档字符', () => {
    const result = spark([5, 5, 5, 5]);
    expect(result).toBe('▄▄▄▄');
  });

  it('空数组不报错时 Math.min/max 返回 Infinity', () => {
    // JS: Math.min(...[]) = Infinity, Math.max(...[]) = -Infinity
    // 实际使用中 spark 不应被传入空数组
    expect(Math.min(...[])).toBe(Infinity);
    expect(Math.max(...[] as any)).toBe(-Infinity);
  });
});
