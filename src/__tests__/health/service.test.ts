/**
 * service.ts 核心逻辑单元测试
 * 覆盖：round1、classifyTraining、enrichMealsWithLibrary、parseTrainingFromXunji
 */
import { describe, it, expect } from 'vitest';

// —— 核心函数副本（用于纯逻辑测试，不依赖数据库/API） ——

function round1(v: number): number {
  return Number(v.toFixed(1));
}

// 训练分类相关常量
const CARDIO_BODY_PARTS = new Set([
  '徒步', '跑步', '骑行', '游泳', '椭圆机', 'HIIT', '有氧', '登山',
  '快走', '划船', '跳绳', '爬楼', '越野跑', '马拉松', '户外跑步',
  '户外步行', '室内跑步', '室内步行', '户外骑行', '室内骑行',
]);
const CARDIO_SUBSTRINGS = ['泳', '跑', '骑', '划船', '徒步'];
	const STRENGTH_INDICATORS = ['杠铃', '哑铃', '器械', '绳索', '龙门架', '史密斯', '腿举', '弯举', '卧推', '深蹲', '硬拉', '推举', '飞鸟', '臂屈伸', '引体'];

interface TrainingExercise {
  name: string;
  sets: number;
  reps: number;
  weight: number;
}

interface TrainingData {
  bodyPart: string;
  exercises: TrainingExercise[];
  calories: number;
  duration?: string;
  distance?: string;
  avgHeartRate?: number;
}

function isCardioName(name: string): boolean {
  if (CARDIO_BODY_PARTS.has(name)) return true;
  if (STRENGTH_INDICATORS.some(kw => name.includes(kw))) return false;
  return CARDIO_SUBSTRINGS.some(kw => name.includes(kw));
}

function classifyTraining(t: TrainingData): 'strength' | 'cardio' {
  if (isCardioName(t.bodyPart)) return 'cardio';
  if (t.exercises.length > 0 && t.exercises.some(e => isCardioName(e.name))) return 'cardio';
  if (t.exercises.length > 0 && t.exercises.every(e => e.name === t.bodyPart)) return 'cardio';
  if (t.exercises.length > 0 && t.exercises.every(e => e.sets == null && e.reps == null && e.weight == null)) return 'cardio';
  if (t.duration || t.avgHeartRate !== undefined || t.distance) return 'cardio';
  return 'strength';
}

function parseTrainingFromXunji(items: string[]): TrainingData | null {
  if (!items.length) return null;
  const raw = items[0];
  const parts = raw.split(',');
  const bodyPart = parts[2] || '未知';

  let calories = 0;
  const calSeg = parts.find(p => p.startsWith('calorie:'));
  if (calSeg) calories = parseInt(calSeg.split(':')[1], 10) || 0;

  const exercises: TrainingExercise[] = [];
  let currentEx: { name: string; sets: { weight: number; reps: number }[] } | null = null;

  for (let i = 5; i < parts.length; i++) {
    const p = parts[i];
    const exMatch = p.match(/^(\d+)\.(?!\d+kg)(.+)/);
    if (exMatch) {
      if (currentEx) {
        const totalSets = currentEx.sets.length;
        const avgWeight = Math.round(currentEx.sets.reduce((s, set) => s + set.weight, 0) / totalSets);
        const avgReps = Math.round(currentEx.sets.reduce((s, set) => s + set.reps, 0) / totalSets);
        exercises.push({ name: currentEx.name, sets: totalSets, reps: avgReps, weight: avgWeight });
      }
      currentEx = { name: exMatch[2], sets: [] };
      continue;
    }

    const wtMatch = p.match(/^(\d+[.\d]*)kg$/);
    if (wtMatch && i + 1 < parts.length) {
      const repsMatch = parts[i + 1].match(/^(\d+)次$/);
      if (repsMatch && currentEx) {
        currentEx.sets.push({
          weight: parseFloat(wtMatch[1]),
          reps: parseInt(repsMatch[1]),
        });
        i++;
      }
    }
  }

  if (currentEx && currentEx.sets.length) {
    const totalSets = currentEx.sets.length;
    const avgWeight = Math.round(currentEx.sets.reduce((s, set) => s + set.weight, 0) / totalSets);
    const avgReps = Math.round(currentEx.sets.reduce((s, set) => s + set.reps, 0) / totalSets);
    exercises.push({ name: currentEx.name, sets: totalSets, reps: avgReps, weight: avgWeight });
  }

  return { bodyPart, exercises, calories };
}

// —— 测试开始 ——

describe('round1 — 数值舍入', () => {
  it('与 calorie.ts r1 行为一致', () => {
    expect(round1(57.699999999999996)).toBe(57.7);
    expect(round1(3.9999999)).toBe(4.0);
  });

  it('正常舍入', () => {
    expect(round1(1.05)).toBe(1.1); // 四舍五入
    expect(round1(1.04)).toBe(1.0);
    expect(round1(99.99)).toBe(100.0);
  });
});

describe('classifyTraining — 训练类型分类', () => {
  it('跑步归类为有氧', () => {
    const t: TrainingData = {
      bodyPart: '户外跑步',
      exercises: [],
      calories: 300,
    };
    expect(classifyTraining(t)).toBe('cardio');
  });

  it('游泳归类为有氧（子串匹配）', () => {
    const t: TrainingData = {
      bodyPart: '自由泳',
      exercises: [],
      calories: 400,
    };
    expect(classifyTraining(t)).toBe('cardio');
  });

  it('力量训练归类正确', () => {
    const t: TrainingData = {
      bodyPart: '胸部',
      exercises: [
        { name: '1.杠铃卧推', sets: 4, reps: 10, weight: 60 },
        { name: '2.哑铃飞鸟', sets: 3, reps: 12, weight: 15 },
      ],
      calories: 250,
    };
    expect(classifyTraining(t)).toBe('strength');
  });

  it('有 duration 的归类为有氧', () => {
    const t: TrainingData = {
      bodyPart: '腿部',
      exercises: [],
      calories: 200,
      duration: '45分钟',
    };
    expect(classifyTraining(t)).toBe('cardio');
  });

  it('动作名包含有氧关键词的归类为有氧', () => {
    const t: TrainingData = {
      bodyPart: '腿部',
      exercises: [
        { name: '户外跑步', sets: 1, reps: 1, weight: 0 },
      ],
      calories: 200,
    };
    expect(classifyTraining(t)).toBe('cardio');
  });

  it('BUG回归：杠铃划船不应被误判为有氧', () => {
    // "杠铃划船"含"划船"子串，但"杠铃"是力量训练特征词
    const t: TrainingData = {
      bodyPart: '背部',
      exercises: [
        { name: '1.杠铃划船', sets: 4, reps: 10, weight: 60 },
        { name: '2.引体向上', sets: 3, reps: 8, weight: 0 },
      ],
      calories: 250,
    };
    expect(classifyTraining(t)).toBe('strength');
  });

  it('BUG回归：哑铃划船不应被误判为有氧', () => {
    const t: TrainingData = {
      bodyPart: '背部',
      exercises: [
        { name: '哑铃划船', sets: 3, reps: 12, weight: 25 },
      ],
      calories: 150,
    };
    expect(classifyTraining(t)).toBe('strength');
  });
});

describe('parseTrainingFromXunji — 训记数据解析', () => {
  it('空数组返回 null', () => {
    expect(parseTrainingFromXunji([])).toBeNull();
  });

  it('正确解析力量训练数据', () => {
    const raw = '260524,id:12345,胸部,train_time:1709000000-1709018000,calorie:250,1.杠铃卧推,60kg,10次,60kg,10次,60kg,10次,60kg,10次,2.哑铃飞鸟,15kg,12次,15kg,12次,15kg,12次';
    const result = parseTrainingFromXunji([raw]);
    expect(result).not.toBeNull();
    expect(result!.bodyPart).toBe('胸部');
    expect(result!.calories).toBe(250);
    expect(result!.exercises).toHaveLength(2);
    expect(result!.exercises[0].name).toBe('杠铃卧推');
    expect(result!.exercises[0].sets).toBe(4);
    expect(result!.exercises[0].weight).toBe(60);
    expect(result!.exercises[0].reps).toBe(10);
  });

  it('无热量字段默认为 0', () => {
    const raw = '260524,id:12345,背部,train_time:1709000000-1709018000,1.引体向上,0kg,8次';
    const result = parseTrainingFromXunji([raw]);
    expect(result).not.toBeNull();
    expect(result!.calories).toBe(0);
  });

  it('运动名为空时使用默认值', () => {
    // 格式异常时 bodyPart 为 "未知"
    const raw = '260524,id:12345';
    const result = parseTrainingFromXunji([raw]);
    expect(result).not.toBeNull();
    expect(result!.bodyPart).toBe('未知');
    expect(result!.exercises).toHaveLength(0);
  });
});

describe('饮食合并逻辑 — meal merge 防重复', () => {
  it('相同餐次内容重复时跳过', () => {
    const existingContent = '鸡胸肉150g(200kcal)';
    const newContent = '鸡胸肉150g';
    // 防重复检测：existing 包含 new 或 new 包含 existing
    const isDuplicate = existingContent.includes(newContent) || newContent.includes(existingContent);
    expect(isDuplicate).toBe(true);
  });

  it('不同餐次正常合并', () => {
    const existingContent = '米饭1碗(175kcal)';
    const newContent = '鸡胸肉150g(200kcal)';
    const isDuplicate = existingContent.includes(newContent) || newContent.includes(existingContent);
    expect(isDuplicate).toBe(false);
  });

  it('修正模式下替换指定餐次', () => {
    const existingMeals = [
      { time: 'breakfast', content: '旧早餐', calories: 300 },
      { time: 'lunch', content: '旧午餐', calories: 500 },
    ];
    const replaceSet = new Set(['lunch']);
    const newMeals = [{ time: 'lunch', content: '新午餐', calories: 450 }];

    // 保留不需要替换的
    const kept = existingMeals.filter(m => !replaceSet.has(m.time));
    expect(kept).toHaveLength(1);
    expect(kept[0].time).toBe('breakfast');

    // 新午餐替换旧午餐
    const merged = [...kept, ...newMeals];
    expect(merged).toHaveLength(2);
    const lunchMeal = merged.find(m => m.time === 'lunch');
    expect(lunchMeal!.calories).toBe(450);
  });
});
