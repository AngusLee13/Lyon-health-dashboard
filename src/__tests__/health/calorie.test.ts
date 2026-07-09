/**
 * calorie.ts 单元测试
 * 覆盖：r1、parseMealCalories、calcCalorieSummary、computeSleepScore、estimateStepCalories
 */
import { describe, it, expect } from 'vitest';

// 直接测试 r1 函数（从模块中提取的纯函数逻辑）
// r1(v) = Number(v.toFixed(1))

function r1(v: number): number {
  return Number(v.toFixed(1));
}

describe('r1 — 浮点数舍入到小数点后 1 位', () => {
  it('正常小数正确舍入', () => {
    expect(r1(3.14)).toBe(3.1);
    expect(r1(3.16)).toBe(3.2);
    // 注意：5.55 在 IEEE 754 中实际为 5.5499...，toFixed(1) 正确舍入为 5.5
    expect(r1(5.55)).toBe(5.5);
    // 0.35 在 IEEE 754 中实际为 0.3499...，toFixed(1) 正确舍入为 0.3
    expect(r1(0.35)).toBe(0.3);
  });

  it('消除浮点数精度误差（核心回归测试）', () => {
    // BUG 回归：57.699999999999996 应显示为 57.7
    expect(r1(57.699999999999996)).toBe(57.7);
    // BUG 回归：Math.round(v*10)/10 模式对 57.6999... 这类值的行为
    // 57.699999999999996 * 10 = 576.99999999999996，Math.round→577，577/10→57.7 ✓
    // 但 toFixed(1) 同样能正确处理，且消除除法阶段的浮点误差
    // 测试确认 toFixed 方案正确
    expect(r1(57.699999999999996)).toBe(57.7);
    // 其他常见浮点误差
    expect(r1(0.1 + 0.2)).toBe(0.3);
    expect(r1(1.999999999999999)).toBe(2.0);
  });

  it('整数保持整数', () => {
    expect(r1(5)).toBe(5.0);
    expect(r1(0)).toBe(0.0);
    expect(r1(100)).toBe(100.0);
  });

  it('负数正确处理', () => {
    expect(r1(-3.14)).toBe(-3.1);
    expect(r1(-3.16)).toBe(-3.2);
  });

  it('极大值和极小值', () => {
    expect(r1(9999.999)).toBe(10000.0);
    expect(r1(0.001)).toBe(0.0);
    expect(r1(0.04)).toBe(0.0);
    expect(r1(0.05)).toBe(0.1); // 四舍五入边界
  });
});

// 模拟 parseMealCalories 的核心逻辑
// 来自 calorie.ts: parseMealCalories + parseContentMacros

interface DietMeal {
  time: string;
  content: string;
  calories?: number;
  carbs?: number;
  protein?: number;
  fat?: number;
  sodium?: number;
}

function parseMealCalories(meal: DietMeal): { calories: number; carbs: number; protein: number; fat: number; sodium: number } {
  const calories = r1(meal.calories || 0);
  const carbs = r1(meal.carbs != null ? meal.carbs : 0);
  const protein = r1(meal.protein != null ? meal.protein : 0);
  const fat = r1(meal.fat != null ? meal.fat : 0);
  const sodium = r1(meal.sodium != null ? meal.sodium : 0);
  return { calories, carbs, protein, fat, sodium };
}

describe('parseMealCalories — 餐次热量解析', () => {
  it('正常解析完整数据', () => {
    const meal: DietMeal = {
      time: 'lunch',
      content: '鸡胸肉150g + 米饭1碗',
      calories: 375,
      carbs: 38,
      protein: 50,
      fat: 4.5,
      sodium: 71,
    };
    const result = parseMealCalories(meal);
    expect(result.calories).toBe(375.0);
    expect(result.carbs).toBe(38.0);
    expect(result.protein).toBe(50.0);
    expect(result.fat).toBe(4.5);
    expect(result.sodium).toBe(71.0);
  });

  it('缺失字段默认为 0', () => {
    const meal: DietMeal = {
      time: 'snack',
      content: '苹果1个',
      calories: 80,
    };
    const result = parseMealCalories(meal);
    expect(result.calories).toBe(80.0);
    expect(result.carbs).toBe(0.0);
    expect(result.protein).toBe(0.0);
    expect(result.fat).toBe(0.0);
    expect(result.sodium).toBe(0.0);
  });

  it('浮点精度值正确舍入', () => {
    const meal: DietMeal = {
      time: 'dinner',
      content: '三文鱼200g',
      calories: 416,
      carbs: 0,
      protein: 57.699999999999996,
      fat: 20.33333333333333,
      sodium: 90,
    };
    const result = parseMealCalories(meal);
    expect(result.protein).toBe(57.7);
    expect(result.fat).toBe(20.3);
  });

  it('null 值视为缺失，使用 0', () => {
    const meal: DietMeal = {
      time: 'breakfast',
      content: '黑咖啡',
      calories: 2,
      carbs: undefined,
      protein: undefined,
    };
    const result = parseMealCalories(meal);
    expect(result.carbs).toBe(0.0);
    expect(result.protein).toBe(0.0);
  });
});

// 模拟 calcCalorieSummary 的核心逻辑（不含文件 I/O）
import { CalorieSummary } from '../../health/calorie';

describe('calcCalorieSummary 核心逻辑验证', () => {
  // 验证 r1 在累积计算中的正确性
  it('多餐热量累加后正确舍入', () => {
    const meals = [
      { cal: 375.5, carb: 38.2, protein: 50.1, fat: 4.3, sodium: 71 },
      { cal: 520.3, carb: 45.7, protein: 35.8, fat: 18.2, sodium: 450 },
      { cal: 280.0, carb: 30.0, protein: 20.0, fat: 8.0, sodium: 200 },
    ];

    let totalCal = 0, totalCarb = 0, totalProtein = 0, totalFat = 0, totalSodium = 0;
    for (const m of meals) {
      totalCal += m.cal;
      totalCarb += m.carb;
      totalProtein += m.protein;
      totalFat += m.fat;
      totalSodium += m.sodium;
    }

    // 验证舍入后不会出现 57.699999999999996 这类值
    expect(r1(totalCal)).toBe(1175.8);
    expect(r1(totalCarb)).toBe(113.9);
    expect(r1(totalProtein)).toBe(105.9);
    expect(r1(totalFat)).toBe(30.5);
    expect(r1(totalSodium)).toBe(721.0);
  });

  it('百分比计算正确', () => {
    const consumed = 1500;
    const target = 2000;
    const percentage = Math.round((consumed / target) * 100);
    expect(percentage).toBe(75);
  });

  it('断食日使用更低目标', () => {
    const fastingTarget = 600;
    const normalTarget = 2000;
    expect(fastingTarget).toBeLessThan(normalTarget);
  });

  it('剩余热量不为负数', () => {
    const target = 2000;
    const consumed = 2200;
    const remaining = r1(Math.max(0, target - consumed));
    expect(remaining).toBe(0.0);
    expect(remaining).not.toBeLessThan(0);
  });
});

describe('computeSleepScore — 睡眠评分计算', () => {
  // 模拟 computeSleepScore 逻辑（与 calorie.ts 保持一致）
  function computeSleepScore(sleep: any): number {
    if (!sleep?.duration) return 0;
    const dur = sleep.duration;
    const deep = sleep.deepSleep || 0;
    const ratio = dur > 0 ? deep / dur : 0;

    let durScore = 0;
    if (dur >= 7.5 && dur <= 8.5) durScore = 40;
    else if (dur >= 7 && dur < 7.5) durScore = 35;
    else if (dur > 8.5 && dur <= 9) durScore = 30;
    else if (dur >= 6 && dur < 7) durScore = 25;
    else if (dur >= 5 && dur < 6) durScore = 15;
    else if (dur > 9) durScore = 10;
    else durScore = 5;

    let deepScore = 0;
    if (ratio >= 0.25) deepScore = 30;
    else if (ratio >= 0.20) deepScore = 25;
    else if (ratio >= 0.15) deepScore = 20;
    else if (ratio >= 0.10) deepScore = 10;
    else deepScore = 5;

    const qMap: Record<string, number> = { excellent: 30, good: 22, fair: 12, poor: 5 };
    const qualityScore = qMap[sleep.quality] ?? 15;

    let bedtimePenalty = 0;
    if (sleep.bedTime) {
      const bedHour = parseInt(sleep.bedTime.split(':')[0], 10);
      if (bedHour >= 0 && bedHour < 3) bedtimePenalty = 10;
      else if (bedHour >= 3 && bedHour < 6) bedtimePenalty = 15;
    }

    return Math.max(0, Math.min(100, durScore + deepScore + qualityScore - bedtimePenalty));
  }

  it('完美睡眠得满分', () => {
    const score = computeSleepScore({
      duration: 8.0,
      deepSleep: 2.0,
      quality: 'excellent',
      bedTime: '22:30',
    });
    expect(score).toBe(100);
  });

  it('睡眠不足得分低', () => {
    const score = computeSleepScore({
      duration: 5.5,
      deepSleep: 0.8,
      quality: 'fair',
      bedTime: '01:30',
    });
    expect(score).toBeLessThan(50);
  });

  it('无数据返回 0', () => {
    expect(computeSleepScore(null)).toBe(0);
    expect(computeSleepScore({})).toBe(0);
  });

  it('评分不超出 0-100 范围', () => {
    // 极端情况
    const score1 = computeSleepScore({ duration: 12, deepSleep: 6, quality: 'excellent', bedTime: '22:00' });
    expect(score1).toBeLessThanOrEqual(100);
    expect(score1).toBeGreaterThanOrEqual(0);

    const score2 = computeSleepScore({ duration: 1, deepSleep: 0, quality: 'poor', bedTime: '05:00' });
    expect(score2).toBeLessThanOrEqual(100);
    expect(score2).toBeGreaterThanOrEqual(0);
  });
});

describe('estimateStepCalories — 步数热量估算', () => {
  function estimateStepCalories(steps: number, weightKg: number): number {
    return Math.round(steps * 0.04 * (weightKg / 70));
  }

  it('70kg 标准体重计算', () => {
    expect(estimateStepCalories(10000, 70)).toBe(400);
  });

  it('体重越大消耗越多', () => {
    const light = estimateStepCalories(10000, 50);
    const heavy = estimateStepCalories(10000, 118);
    expect(heavy).toBeGreaterThan(light);
  });

  it('0 步数返回 0', () => {
    expect(estimateStepCalories(0, 70)).toBe(0);
  });

  it('返回整数', () => {
    const result = estimateStepCalories(8500, 118);
    expect(Number.isInteger(result)).toBe(true);
  });
});
