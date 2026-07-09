/** 每日健康记录 */

export interface SleepData {
  duration: number;        // 小时
  quality: 'poor' | 'fair' | 'good' | 'excellent';
  sleepScore?: number;     // 0-100 睡眠评分（AI提取或本地计算）
  bedTime: string;         // HH:mm
  wakeTime: string;        // HH:mm
  deepSleep?: number;      // 深睡小时（可选）
  lightSleep?: number;     // 浅睡/核心睡眠小时（可选）
  coreSleep?: number;      // 核心睡眠（Apple Watch 用此名）
  remSleep?: number;       // 快速眼动睡眠小时（可选）
  awakeTime?: number;      // 夜间清醒小时（可选）
  awakeCount?: number;     // 夜间清醒次数（可选，Apple Watch截图中的"清醒 N次"）
  notes?: string;
}

export interface DietMeal {
  time: string;            // breakfast/lunch/dinner/snack
  content: string;
  calories?: number;
  carbs?: number;          // 碳水(g)
  protein?: number;        // 蛋白质(g)
  fat?: number;            // 脂肪(g)
  sodium?: number;         // 钠(mg)
}

export interface DietData {
  meals: DietMeal[];
  adherence: 'poor' | 'fair' | 'good' | 'excellent';
  totalCalories?: number;
  totalCarbs?: number;
  totalProtein?: number;
  totalFat?: number;
  totalSodium?: number;    // 钠(mg)
  notes?: string;
  /** 用户发送的是修正数据时，列出需要替换（而非追加）的餐次，如 ["dinner"] */
  replaceMeals?: string[];
}

export interface TrainingExercise {
  name: string;
  sets: number;
  reps: number;
  weight: number;
}

export interface TrainingData {
  bodyPart: string;
  exercises: TrainingExercise[];
  calories: number;
  /** Apple Watch / 有氧扩展字段 */
  duration?: string;
  distance?: string;
  avgHeartRate?: number;
}

export interface DailyRecord {
  date: string;            // YYYY-MM-DD
  sleep: SleepData;
  training: TrainingData | null;   // 力量训练
  cardio?: TrainingData;           // 有氧训练（Apple Watch / 训记）
  diet: DietData | null;
  weight?: number;
  steps?: number;            // 当日步数
  fastingDay?: boolean;      // 5+2轻断食：当天为断食日（热量上限降至600kcal）
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  days: DailyRecord[];
  averages: {
    sleepDuration: number;
    sleepQuality: number;    // 1-4 scale
    trainingCalories: number;
    trainingDays: number;
    weight?: number;
    dietAdherence: number;   // 1-4 scale
  };
  anomalies: Anomaly[];
  summary: string;
}

export interface MonthlyReport {
  month: string;           // YYYY-MM
  weeks: WeeklyReport[];
  averages: {
    sleepDuration: number;
    sleepQuality: number;
    trainingCalories: number;
    trainingDays: number;
    weight?: number;
    dietAdherence: number;
  };
  trends: Trend[];
  anomalies: Anomaly[];
  summary: string;
}

export interface Anomaly {
  metric: string;
  date: string;
  value: number;
  baseline: number;
  deviation: number;       // 偏离百分比
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
}

export interface Trend {
  metric: string;
  direction: 'up' | 'down' | 'stable';
  change: number;          // 变化百分比
  interpretation: string;
}

// ─── 动态食物热量库 ───

/** 食物热量库中的一条记录（持久化到 foods.json） */
export interface FoodItem {
  name: string;
  category: string;           // 主食/肉类/零食/饮品/乳制品/蔬菜/水果/调味品/速食/其他
  caloriesPer100g: number;
  carbsPer100g: number;
  proteinPer100g: number;
  fatPer100g: number;
  sodiumPer100g?: number;
  servingSize?: number;       // 每份克数
  servingCalories?: number;
  source: string;             // "nutrition_label" | "manual" | "ai_estimate"
  createdAt: number;
  updatedAt?: number;
}

/** 营养成分表识别结果（从食品包装 OCR 提取） */
export interface NutritionFacts {
  foodName: string;
  category: string;
  energyKj?: number;          // 原始 kJ 值（如有）
  caloriesPer100g: number;    // kcal/100g
  proteinPer100g: number;
  fatPer100g: number;
  carbsPer100g: number;
  sodiumPer100g?: number;     // mg/100g
  servingSize?: number;
  servingCalories?: number;
  servingProtein?: number;
  servingFat?: number;
  servingCarbs?: number;
}
