import { fetchTrains, TrainItem } from '../xunji/client';
import { AppConfig } from '../config';
import { DailyRecord, SleepData, DietData, DietMeal, TrainingData, TrainingExercise, Anomaly } from './types';
import { saveDailyRecord, getDailyRecord, detectAnomalies, listRecordDates } from './store';
import { getDeepSeekClient } from '../claude/client';
import { findFood } from './foodLibrary';
import { splitCombinedMeals, estimateStrengthCalories, correctMealBeforeSave } from './calorie';

/** 从训记原始行解析训练数据 */
function parseTrainingFromXunji(items: string[]): TrainingData | null {
  if (!items.length) return null;
  // 取第一条（通常一个日期只有一条训练记录）
  const raw = items[0];
  const parts = raw.split(',');
  // 格式: 260524,id:xxx,部位名,train_time:...,[calorie:xxx,]动作名,组,重量,次数,...
  // 注意：calorie 字段可能缺失（如功能性训练），此时动作名从 index 4 开始
  const bodyPart = parts[2] || '未知';

  // 解析卡路里
  let calories = 0;
  const calSeg = parts.find(p => p.startsWith('calorie:'));
  if (calSeg) calories = parseInt(calSeg.split(':')[1], 10) || 0;

  // 解析动作
  const exercises: TrainingExercise[] = [];
  let currentEx: { name: string; sets: { weight: number; reps: number }[]; durationSec?: number } | null = null;

  // 🔧 动态定位第一个动作的起始索引：兼容 calorie 字段缺失时的格式偏移
  const firstExIdx = parts.findIndex(p => /^(\d+)\.(?!\d+kg)(.+)/.test(p));
  const startIdx = firstExIdx !== -1 ? firstExIdx : 5;

  for (let i = startIdx; i < parts.length; i++) {
    const p = parts[i];
    // 判断是否是动作名（以数字.开头，如 "1.对握高位下拉"）
    const exMatch = p.match(/^(\d+)\.(?!\d+kg)(.+)/);
    if (exMatch) {
      if (currentEx) {
        // 汇总上一动作
        if (currentEx.sets.length > 0) {
          const totalSets = currentEx.sets.length;
          const avgWeight = Math.round(currentEx.sets.reduce((s, set) => s + set.weight, 0) / totalSets);
          const avgReps = Math.round(currentEx.sets.reduce((s, set) => s + set.reps, 0) / totalSets);
          exercises.push({ name: currentEx.name, sets: totalSets, reps: avgReps, weight: avgWeight,
            ...(currentEx.durationSec ? { duration: currentEx.durationSec + 's' } as any : {}) });
        } else if (currentEx.durationSec) {
          // 纯时间型动作（如爬楼梯、跑步机等）：无重量次数，只有时长
          exercises.push({ name: currentEx.name, sets: 1, reps: 0, weight: 0,
            duration: currentEx.durationSec + 's' } as any);
        }
      }
      currentEx = { name: exMatch[2], sets: [] };
      continue;
    }

    // 匹配时间型记录（如 time:6136s → 爬楼梯/跑步等纯时长动作）
    const timeMatch = p.match(/^time:(\d+)s$/);
    if (timeMatch && currentEx) {
      currentEx.durationSec = parseInt(timeMatch[1], 10);
      continue;
    }

    // 匹配重量
    const wtMatch = p.match(/^(\d+[.\d]*)kg$/);
    if (wtMatch && i + 1 < parts.length) {
      const repsMatch = parts[i + 1].match(/^(\d+)次$/);
      if (repsMatch && currentEx) {
        currentEx.sets.push({
          weight: parseFloat(wtMatch[1]),
          reps: parseInt(repsMatch[1]),
        });
        i++; // 跳过已消费的 reps
      }
    }
  }

  // 收尾最后一个动作
  if (currentEx) {
    if (currentEx.sets.length > 0) {
      const totalSets = currentEx.sets.length;
      const avgWeight = Math.round(currentEx.sets.reduce((s, set) => s + set.weight, 0) / totalSets);
      const avgReps = Math.round(currentEx.sets.reduce((s, set) => s + set.reps, 0) / totalSets);
      exercises.push({ name: currentEx.name, sets: totalSets, reps: avgReps, weight: avgWeight,
        ...(currentEx.durationSec ? { duration: currentEx.durationSec + 's' } as any : {}) });
    } else if (currentEx.durationSec) {
      exercises.push({ name: currentEx.name, sets: 1, reps: 0, weight: 0,
        duration: currentEx.durationSec + 's' } as any);
    }
  }

  return { bodyPart, exercises, calories };
}

/** 已知有氧训练部位关键词 */
const CARDIO_BODY_PARTS = new Set([
  '徒步', '跑步', '骑行', '游泳', '椭圆机', 'HIIT', '有氧', '登山',
  '快走', '划船', '划船机', '跳绳', '爬楼', '越野跑', '马拉松', '户外跑步',
  '户外步行', '室内跑步', '室内步行', '户外骑行', '室内骑行',
  '拳击', '搏击', '泰拳', '跆拳道', '散打', '格斗', '击剑',
  '体能训练', '功能性训练', 'CrossFit', 'Tabata', '普拉提', '瑜伽',
  '飞盘', '网球', '羽毛球', '乒乓球', '篮球', '足球', '排球',
]);

/** 有氧特征子串：自由泳/蛙泳/蝶泳/仰泳等没在精确集合里，但含"泳"的就是有氧
 *  注意："划船"已从此列表移除——"坐姿划船""杠铃划船""哑铃划船"都是力量训练动作
 *  只有"划船机"是有氧（已在 CARDIO_BODY_PARTS 中精确匹配） */
const CARDIO_SUBSTRINGS = ['泳', '跑', '骑', '徒步', '爬楼', '楼梯', '拳击', '搏击', '击剑', '网球', '羽毛球', '乒乓球', '篮球', '足球', '排球'];

/** 力量训练特征词：防止"杠铃划船""哑铃划船"等被"划船"子串误判为有氧 */
const STRENGTH_INDICATORS = ['杠铃', '哑铃', '器械', '绳索', '龙门架', '史密斯', '腿举', '弯举', '卧推', '深蹲', '硬拉', '推举', '飞鸟', '臂屈伸', '引体', '下拉', '坐姿划船', '面拉', '划船机除外'];

/** 判断名称是否匹配有氧关键词（精确 + 子串），排除明显的力量训练动作 */
function isCardioName(name: string): boolean {
  if (CARDIO_BODY_PARTS.has(name)) return true;
  // 如果名称包含力量训练特征词，即使命中"跑/骑/划船"等子串也不是有氧
  // 例如："杠铃划船"命中"划船"但实际是力量训练
  if (STRENGTH_INDICATORS.some(kw => name.includes(kw))) return false;
  return CARDIO_SUBSTRINGS.some(kw => name.includes(kw));
}

/** 分类训练数据为力量或有氧 */
export function classifyTraining(t: TrainingData): 'strength' | 'cardio' {
  if (isCardioName(t.bodyPart)) return 'cardio';
  // 检查动作名是否属于有氧（如训记把骑行记在"腿部"下，自由泳记在"全身"下）
  if (t.exercises.length > 0 && t.exercises.some(e => isCardioName(e.name))) return 'cardio';
  if (t.exercises.length > 0 && t.exercises.every(e => e.name === t.bodyPart)) return 'cardio';
  // 缺少组数/次数/重量的"训练"大概率是有氧（如游泳只记录时长和热量）
  if (t.exercises.length > 0 && t.exercises.every(e => e.sets == null && e.reps == null && e.weight == null)) return 'cardio';
  if (t.duration || t.avgHeartRate !== undefined || t.distance) return 'cardio';
  return 'strength';
}

/** 合并两条有氧训练数据：热量取最大值（避免重复拉取时累加），exercises 去重、duration/distance 拼接 */
function mergeCardioData(existing: TrainingData, incoming: TrainingData): TrainingData {
  const mergedExercises = [...existing.exercises];
  const existingNames = new Set(existing.exercises.map(e => e.name));
  for (const ex of incoming.exercises) {
    if (!existingNames.has(ex.name)) {
      mergedExercises.push(ex);
      existingNames.add(ex.name);
    }
  }

  const mergedDuration = [existing.duration, incoming.duration]
    .filter(Boolean).join(' + ');
  const mergedDistance = [existing.distance, incoming.distance]
    .filter(Boolean).join(' + ');

  // 热量取较大值，避免同一天多次拉取训记 API 时累加热量（以前是相加，会导致膨胀）
  return {
    bodyPart: incoming.bodyPart || existing.bodyPart,
    exercises: mergedExercises,
    calories: Math.max(existing.calories, incoming.calories),
    duration: mergedDuration || undefined,
    distance: mergedDistance || undefined,
    avgHeartRate: incoming.avgHeartRate ?? existing.avgHeartRate,
  };
}

/** 根据食物描述推断餐次（用于修复缺少 time 字段的 meal）
 *  匹配中文餐次关键词，找不到则默认 snack */
function inferMealTime(content: string): string {
  const c = content.toLowerCase();
  if (/早餐|早饭|早上|早起|晨|早/.test(c)) return 'breakfast';
  if (/午餐|午饭|中午|午/.test(c)) return 'lunch';
  if (/晚餐|晚饭|晚上|晚|夜宵|宵夜/.test(c)) return 'dinner';
  if (/加餐|零食|下午茶|上午茶|补餐/.test(c)) return 'snack';
  // 无法推断时默认 snack（加餐），避免归入正餐影响热量统计
  return 'snack';
}

/** 从用户输入文本推断餐次（用于修复 AI 遗漏 time 字段时提供上下文提示）
 *  例如 "修正晚餐"→"dinner"，"补充早饭"→"breakfast" */
function inferMealTimeFromText(text: string): string | null {
  const t = text.toLowerCase();
  // 匹配修正/补充/更正/修改 后面紧跟的餐次关键词
  const m = t.match(/(?:修正|补充|更正|修改|改成|改一下|调整)\s*[：:]?\s*(早餐|早饭|早上|午餐|午饭|中午|晚餐|晚饭|晚上|夜宵|宵夜|加餐|零食|下午茶|上午茶|补餐)/);
  if (m) {
    const meal = m[1];
    if (/早餐|早饭|早上/.test(meal)) return 'breakfast';
    if (/午餐|午饭|中午/.test(meal)) return 'lunch';
    if (/晚餐|晚饭|晚上|夜宵|宵夜/.test(meal)) return 'dinner';
    if (/加餐|零食|下午茶|上午茶|补餐/.test(meal)) return 'snack';
  }
  // 匹配餐次词出现的位置（用户可能写"晚餐：鸡胸肉"）
  if (/晚餐|晚饭/.test(t)) return 'dinner';
  if (/早餐|早饭/.test(t)) return 'breakfast';
  if (/午餐|午饭/.test(t)) return 'lunch';
  if (/加餐|零食/.test(t)) return 'snack';
  return null;
}

/** 获取某天的完整健康数据（训练 + 日报） */
export async function fetchHealthData(dateStr: string, config: AppConfig): Promise<{
  date: string;
  training: TrainingData | null;
  record: DailyRecord | null;
}> {
  // 获取训记数据（使用缓存，避免频繁请求被限流）
  let training: TrainingData | null = null;
  try {
    const result = await fetchTrains(dateStr, { apiKey: config.xunji.apiKey, baseUrl: config.xunji.baseUrl }, false);
    if (result.items.length) {
      training = parseTrainingFromXunji(result.items.map(i => i.raw));
    }
  } catch (e: any) {
    console.warn(`获取训记数据失败 (${dateStr}): ${e.message}`);
  }

  const record = getDailyRecord(dateStr);
  return { date: dateStr, training, record };
}

/** 生成/更新日报 */
export async function generateHealthAnalysis(
  dateStr: string,
  config: AppConfig,
  input: { sleep?: SleepData; diet?: DietData; training?: TrainingData; weight?: number; steps?: number; notes?: string; supplements?: string },
): Promise<DailyRecord> {
  // 获取训练数据（优先使用 input 中的训练数据，否则强制刷新获取最新）
  let rawTraining: TrainingData | null = input.training || null;
  if (!rawTraining) {
    try {
      const result = await fetchTrains(dateStr, { apiKey: config.xunji.apiKey, baseUrl: config.xunji.baseUrl }, false);
      if (result.items.length) {
        rawTraining = parseTrainingFromXunji(result.items.map(i => i.raw));
      }
    } catch (e: any) {
      console.warn(`获取训记数据失败 (${dateStr}): ${e.message}`);
    }
  }

  // 🔧 兜底：训记部分训练（如功能性训练）可能返回 calorie:0，
  // 当有有效动作数据时，基于训练容量（组×次×重量）本地估算消耗热量
  if (rawTraining && rawTraining.calories === 0 && rawTraining.exercises.length > 0) {
    const estimated = estimateStrengthCalories(rawTraining.exercises);
    if (estimated > 0) {
      console.log(`[训练热量兜底] "${rawTraining.bodyPart}" 训记返回0kcal → 基于容量估算=${estimated}kcal (${rawTraining.exercises.length}个动作)`);
      rawTraining = { ...rawTraining, calories: estimated };
    }
  }

  // 读取已有记录，合并而非覆盖
  const existing = getDailyRecord(dateStr);
  const now = Date.now();

  // 分类并赋值：力量训练 / 有氧训练
  let strengthTraining: TrainingData | null = null;
  let cardioTraining: TrainingData | null = existing?.cardio || null;

  if (rawTraining) {
    const category = classifyTraining(rawTraining);
    if (category === 'strength') {
      strengthTraining = rawTraining;
    } else {
      cardioTraining = cardioTraining
        ? mergeCardioData(cardioTraining, rawTraining)
        : rawTraining;
    }
  }

  // 自动迁移：旧记录中 training 字段可能存有有氧数据，移至 cardio
  if (existing?.training && !existing.cardio) {
    const oldCat = classifyTraining(existing.training);
    if (oldCat === 'cardio') {
      cardioTraining = cardioTraining
        ? mergeCardioData(cardioTraining, existing.training)
        : existing.training;
      // 不把旧有氧数据当作力量训练回退
    }
  }

  // 合并睡眠：新数据覆盖同字段，保留旧数据中未提供的字段
  const mergedSleep = input.sleep
    ? { ...(existing?.sleep || {}), ...input.sleep }
    : existing?.sleep || { duration: 0, quality: 'fair' as const, bedTime: '', wakeTime: '' };

  // 睡眠评分：仅使用 AI 从截图中提取的 Apple Watch 评分，不本地计算
  // sleepScore 由 vision API 从健康 App 截图直接提取，无截图则无评分

  // 合并饮食：根据 replaceMeals 决定是替换还是追加
  // 🔧 重要：使用数组保留独立条目，不用 Map 按 time 聚合。
  // 旧逻辑用 Map 会把同餐次多个食物合并成一条（如"鱼，米饭"），
  // 后续 splitCombinedMeals 拆分时用字典值重算热量，导致原有 AI 估值被覆盖、
  // 午餐热量在输入晚餐后"变少了"的 bug。
  let mergedDiet = existing?.diet || null;
  if (input.diet && mergedDiet) {
    const existingMeals = mergedDiet.meals || [];
    const inputMeals = input.diet.meals || [];
    const replaceSet = new Set((input.diet as any).replaceMeals || []);
    const isReplace = replaceSet.size > 0;
    console.log(`[饮食合并] 日期=${dateStr} 已有餐次=${existingMeals.length} (${existingMeals.map((m: any) => m.time).join(',')}) 新增餐次=${inputMeals.length} (${inputMeals.map((m: any) => m.time).join(',')})${isReplace ? ' 替换餐次=' + [...replaceSet].join(',') : ''}`);

    let mergedMeals: any[];

    if (isReplace) {
      // 修正模式：保留不被替换的餐次，丢弃被替换餐次的旧条目，新数据直接加入
      let skippedMissingTime = 0;
      const keptMeals: any[] = [];
      for (const m of existingMeals) {
        if (!m.time) {
          skippedMissingTime++;
          console.log(`[饮食合并] 修正模式：丢弃缺少time的旧条目 "${m.content}"`);
          continue;
        }
        if (replaceSet.has(m.time)) continue; // 丢弃被替换的餐次
        keptMeals.push({ ...m });
      }
      if (skippedMissingTime > 0) {
        console.log(`[饮食合并] 修正模式：共清理 ${skippedMissingTime} 个缺少time的旧条目`);
      }
      // 新数据直接加入（保留独立条目，不合并同餐次）
      mergedMeals = [...keptMeals, ...inputMeals.map((m: any) => ({ ...m }))];
    } else {
      // 追加模式：保留所有已有条目，新条目按内容去重后追加
      mergedMeals = [...existingMeals.map((m: any) => ({ ...m }))];
      for (const m of inputMeals) {
        const nc = (m.content || '').trim();
        // 防重复：检查是否已有内容相同的条目（同餐次 + 同内容）
        const isDuplicate = mergedMeals.some((em: any) =>
          em.time === m.time && (
            (em.content || '').trim().includes(nc) ||
            nc.includes((em.content || '').trim())
          )
        );
        if (isDuplicate) {
          console.log(`[饮食合并] 跳过重复: time=${m.time} content="${nc}"`);
          continue;
        }
        mergedMeals.push({ ...m });
      }
    }

    // 从合并后的 meals 重新计算全天汇总，避免 input.diet 的部分数据覆盖已有累积值
    const recalcCal = mergedMeals.reduce((s: number, m: any) => s + (m.calories || 0), 0);
    const recalcCarbs = mergedMeals.reduce((s: number, m: any) => s + (m.carbs || 0), 0);
    const recalcProtein = mergedMeals.reduce((s: number, m: any) => s + (m.protein || 0), 0);
    const recalcFat = mergedMeals.reduce((s: number, m: any) => s + (m.fat || 0), 0);
    const recalcSodium = mergedMeals.reduce((s: number, m: any) => s + (m.sodium || 0), 0);

    // 只保留 input.diet 的安全字段，用合并后 meals 的累计值覆盖 diet 级汇总
    mergedDiet = {
      ...mergedDiet,
      adherence: input.diet.adherence || mergedDiet.adherence,
      notes: input.diet.notes || mergedDiet.notes,
      meals: mergedMeals,
      totalCalories: recalcCal,
      totalCarbs: recalcCarbs,
      totalProtein: recalcProtein,
      totalFat: recalcFat,
      totalSodium: recalcSodium,
    };

    // dayTotalSoFar 仅在用户显式声明全天总热量时保留（数值大于 meals 合计才生效）
    const inputDietAny = input.diet as any;
    if (inputDietAny.dayTotalSoFar?.calories) {
      (mergedDiet as any).dayTotalSoFar = inputDietAny.dayTotalSoFar;
    }

    // 清除临时字段（不应持久化）
    delete (mergedDiet as any).replaceMeals;

    console.log(`[饮食合并] 结果餐次=${mergedMeals.length} (${mergedMeals.map((m: any) => `${m.time}(${m.calories}kcal)`).join(', ')}) totalCal=${recalcCal}`);
  } else if (input.diet) {
    mergedDiet = { ...input.diet };
    // 清除临时字段（不应持久化）
    delete (mergedDiet as any).replaceMeals;
    console.log(`[饮食合并] 日期=${dateStr} 首次保存饮食，餐次=${mergedDiet.meals?.length || 0}`);
  }

  // 合并补剂和备注
  const existingExt = existing as any;
  const mergedSupplements = input.supplements || existingExt?.supplements || '';
  const mergedNotes = [input.notes || '', existing?.notes || ''].filter(Boolean).join(' | ');

  // 拆分合并的多个食物为独立条目，确保所有数据路径（API/飞书/同步）都拆分
  // 同时从拆分后的 meals 重新计算 diet 级汇总，保证与 calcCalorieSummary 展示一致
  if (mergedDiet?.meals?.length) {
    const beforeCount = mergedDiet.meals.length;
    mergedDiet.meals = splitCombinedMeals(mergedDiet.meals);
    if (mergedDiet.meals.length !== beforeCount) {
      console.log(`[饮食拆分] 日期=${dateStr} ${beforeCount} → ${mergedDiet.meals.length} 个独立食物`);
    }
    // 用静态字典交叉验证修正 AI 估值（覆盖所有数据入口：文本解析 + 图片识别）
    mergedDiet.meals = mergedDiet.meals.map((m: any) => correctMealBeforeSave(m));
    // 从拆分+修正后的 meals 重算 diet 级汇总
    mergedDiet.totalCalories = mergedDiet.meals.reduce((s: number, m: any) => s + (m.calories || 0), 0);
    mergedDiet.totalCarbs = mergedDiet.meals.reduce((s: number, m: any) => s + (m.carbs || 0), 0);
    mergedDiet.totalProtein = mergedDiet.meals.reduce((s: number, m: any) => s + (m.protein || 0), 0);
    mergedDiet.totalFat = mergedDiet.meals.reduce((s: number, m: any) => s + (m.fat || 0), 0);
    mergedDiet.totalSodium = mergedDiet.meals.reduce((s: number, m: any) => s + (m.sodium || 0), 0);
  }

  // 写入前对饮食数据整体取整，消除合并过程中的浮点累积误差
  if (mergedDiet) {
    // 修复缺少 time 字段的餐次：尝试从内容推断，否则默认 snack
    mergedDiet.meals = (mergedDiet.meals || []).map((m: any, idx: number) => {
      if (!m.time) {
        const inferred = inferMealTime(m.content || '');
        console.warn(`[饮食修复] 日期=${dateStr} 餐次#${idx} 缺少time字段，内容="${m.content}" → 推断为 ${inferred}`);
        return { ...m, time: inferred };
      }
      return m;
    });
    mergedDiet.meals = mergedDiet.meals.map((m: any) => ({
      ...m,
      calories: round1(m.calories || 0),
      carbs: m.carbs != null ? round1(m.carbs) : undefined,
      protein: m.protein != null ? round1(m.protein) : undefined,
      fat: m.fat != null ? round1(m.fat) : undefined,
      sodium: m.sodium != null ? round1(m.sodium) : undefined,
    }));
    mergedDiet.totalCalories = mergedDiet.totalCalories != null ? round1(mergedDiet.totalCalories) : undefined;
    mergedDiet.totalCarbs = mergedDiet.totalCarbs != null ? round1(mergedDiet.totalCarbs) : undefined;
    mergedDiet.totalProtein = mergedDiet.totalProtein != null ? round1(mergedDiet.totalProtein) : undefined;
    mergedDiet.totalFat = mergedDiet.totalFat != null ? round1(mergedDiet.totalFat) : undefined;
    mergedDiet.totalSodium = mergedDiet.totalSodium != null ? round1(mergedDiet.totalSodium) : undefined;
  }

  const record: DailyRecord = {
    date: dateStr,
    sleep: mergedSleep,
    // 力量训练：优先新数据，其次旧记录中未被迁移为有氧的 training
    training: strengthTraining || (existing?.training && classifyTraining(existing.training) === 'strength' ? existing.training : null),
    cardio: cardioTraining || undefined,
    diet: mergedDiet,
    weight: input.weight != null ? round1(input.weight) : existing?.weight,
    steps: input.steps ?? existing?.steps,
    notes: mergedNotes,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  // 补剂作为扩展字段存储
  if (mergedSupplements) {
    (record as any).supplements = mergedSupplements;
  }

  console.log(`[健康存档] 日期=${dateStr} 睡眠=${record.sleep.duration}h 训练=${record.training ? '有' : '无'} 有氧=${record.cardio ? '有' : '无'} 饮食餐次=${record.diet?.meals?.length || 0} 体重=${record.weight || '-'} 步数=${record.steps || '-'}`);
  saveDailyRecord(record);
  return record;
}

/** 查询指定日期的训练数据并格式化为易读文本 */
export async function fetchAndFormatTraining(
  dateStr: string,
  cfg: AppConfig,
): Promise<string> {
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][new Date(dateStr).getDay()];
  const header = `${dateStr} 周${weekDay} · 训练记录`;

  try {
    const result = await fetchTrains(dateStr, { apiKey: cfg.xunji.apiKey, baseUrl: cfg.xunji.baseUrl }, true);
    if (!result.items.length) {
      return `${header}\n\n📭 当日无训练记录。`;
    }

    const rawTraining = parseTrainingFromXunji(result.items.map(i => i.raw));
    if (!rawTraining) {
      return `${header}\n\n📭 当日无训练记录。`;
    }

    const category = classifyTraining(rawTraining);
    const icon = category === 'cardio' ? '🏃' : '🏋️';
    const typeLabel = category === 'cardio' ? '有氧训练' : '力量训练';

    // 解析第一条原始数据获取 ID 和训练时间
    const rawFirst = result.items[0].raw;
    const idMatch = rawFirst.match(/id:(\d+)/);
    const timeMatch = rawFirst.match(/train_time:(\d+)-(\d+)/);

    let trainDuration = '';
    if (timeMatch) {
      const start = parseInt(timeMatch[1]);
      const end = parseInt(timeMatch[2]);
      const mins = Math.round((end - start) / 60000);
      if (mins > 0) trainDuration = `  ·  ${mins} 分钟`;
    }

    // 有氧额外信息
    let cardioExtra = '';
    if (category === 'cardio') {
      const extras = [rawTraining.distance, rawTraining.avgHeartRate ? `avgHR ${rawTraining.avgHeartRate}` : '']
        .filter(Boolean);
      if (extras.length) cardioExtra = `  ·  ${extras.join(' · ')}`;
    }

    const lines: string[] = [
      `${icon} **${header} · ${typeLabel}**`,
      '',
      `部位：**${rawTraining.bodyPart}**  ·  消耗 **${rawTraining.calories}** kcal${trainDuration}${cardioExtra}`,
    ];

    if (idMatch) {
      lines.push(`ID：\`${idMatch[1]}\``);
    }

    lines.push('');
    lines.push('─── 动作列表 ───');

    for (let i = 0; i < rawTraining.exercises.length; i++) {
      const ex = rawTraining.exercises[i];
      const setsDetail = `${ex.sets} 组  ·  ${ex.weight}kg × ${ex.reps} 次`;
      lines.push(`${i + 1}. **${ex.name}**  \`${setsDetail}\``);
    }

    return lines.join('\n');
  } catch (err: any) {
    return `${header}\n\n❌ 获取训练数据失败：${err.message}`;
  }
}

const HEALTH_TEXT_PARSE_PROMPT = `你是一个健康数据提取助手。从用户发送的文本中提取健康数据，以 JSON 格式返回。

需要识别的数据字段：
- sleep: { bedTime (HH:mm), wakeTime (HH:mm), duration (小时数), deepSleep (深睡小时), lightSleep (浅睡小时), coreSleep (核心睡眠小时), remSleep (REM小时), awakeTime (清醒小时), awakeCount (清醒次数,整数), quality (poor/fair/good/excellent), sleepScore (0-100睡眠评分, 🔥如有智能手表/健康App数据则必须提取，这是用户最关心的指标！) }
- diet: { meals: [{ time (breakfast/lunch/dinner/snack), content (食物名称+份量), calories (估算热量kcal,必填), carbs (碳水g), protein (蛋白质g), fat (脂肪g), sodium (钠mg) }], totalCarbs, totalProtein, totalFat, totalSodium (仅本次提交食物的宏量营养素合计，不代表全天汇总,可选), dayTotalSoFar: { calories } (仅当用户显式声明"今天总共摄入X kcal"时才填写,可选), replaceMeals: [餐次列表] (仅当用户发送的是修正/更正数据时才填写，列出要被替换的餐次，如用户说"修正晚餐"→["dinner"]，"晚餐改成"→["dinner"]，"更正早午餐"→["breakfast","lunch"]，"修改加餐"→["snack"]。关键词：修正/更正/修改/改成/改一下/调整。不是修正则不填) }
- training: { bodyPart (训练部位), calories (消耗热量), exercises: [{ name (动作名), sets (组数), reps (次数), weight (重量kg) }] }
- weight: 体重数字(kg)，只提取纯数字
- steps: 当日步数，只提取纯数字（如"步数8500"→8500，"走了10000步"→10000）
- supplements: 补剂信息(文字描述)
- notes: 备注或其他信息

规则：
1. 只提取实际存在的数据，不存在的字段不要包含
2. 时间格式统一为 HH:mm（如 23:30）
3. 饮食餐次用英文：breakfast/lunch/dinner/snack
4. 补剂只需要提取文字描述即可
5. 如果提到"鱼油2粒"、"维生素D 2000IU"这类信息，归类到 supplements
6. **🔥 极其重要 —— 每个食物必须是 meals 数组中的独立元素！**
   - content 字段只能包含「一种食物 + 一份量」，例如 "燕麦 60g"、"鸡蛋2个"
   - 用户说"早餐吃了鸡蛋、粥、牛奶" → 必须返回三个独立的 meal 对象，time 都是 "breakfast"：
     [{time:"breakfast", content:"鸡蛋2个", calories:140, carbs:0.5, protein:12, fat:10, sodium:260},
       {time:"breakfast", content:"粥1碗", calories:175, carbs:38, protein:4, fat:0.5, sodium:5},
       {time:"breakfast", content:"牛奶250ml", calories:150, carbs:12, protein:8, fat:8, sodium:112}]
   - **❌ 绝对禁止合并！** 不要返回 {content:"鸡蛋2个、粥1碗、牛奶250ml", calories:465} 这种合并格式！
   - 每个食物都要估算热量(calories)和宏量营养素(carbs/protein/fat/sodium)，参考常见份量：
   - 吉士堡/双层吉士堡 ≈ 300-400kcal/个(C30 P15 F20 Na680-800mg)，巨无霸 ≈ 550kcal/个(C45 P26 F30 Na550mg)
   - 中薯条 ≈ 340kcal/份(C42 P4 F17 Na210mg)，玉米杯 ≈ 70kcal/杯(C14 P2 F1 Na1mg)
   - 米饭1碗(150g) ≈ 175kcal(C38 P4 F0.5 Na5mg)，鸡胸肉150g ≈ 200kcal(C0 P46 F4 Na66mg)
   - 豆腐脑1碗 ≈ 150kcal(C18 P10 F6 Na200mg)，鸡蛋1个 ≈ 70kcal(C0.5 P6 F5 Na130mg)
   - 牛奶1杯(250ml) ≈ 150kcal(C12 P8 F8 Na112mg)，全麦面包1片 ≈ 80kcal(C15 P3 F1 Na120mg)
   - 馒头1个(100g) ≈ 220kcal(C44 P7 F1 Na165mg)，包子1个 ≈ 220kcal(C30 P8 F9 Na200mg)
   - 猪肉100g ≈ 240kcal(C0 P22 F16 Na57mg)，牛肉100g ≈ 125kcal(C0 P22 F4 Na53mg)
   - 油条1根 ≈ 190kcal(C20 P4 F11 Na220mg)
   - 面条1碗(200g) ≈ 220kcal(C44 P8 F1 Na240mg)
   - 鱼100g ≈ 105kcal(C0 P20 F3 Na40mg)，虾100g ≈ 93kcal(C0 P20 F1 Na150mg)
   - 苹果1个 ≈ 80kcal(C21 P0.4 F0.2 Na2mg)，香蕉1根 ≈ 90kcal(C23 P1 F0.3 Na1mg)
   - 可乐330ml ≈ 139kcal(C35 P0 F0 Na5mg)，橙汁250ml ≈ 112kcal(C26 P2 F0.5 Na5mg)
   - 巧克力50g ≈ 270kcal(C30 P4 F15 Na35mg)，薯片50g ≈ 270kcal(C25 P3 F18 Na300mg)
   - 钠含量参考：加工食品/外卖/快餐通常钠含量较高(500-1500mg/份)，天然食材通常低钠(<100mg/份)
   - 腌制品（咸菜/腊肉/火腿）钠极高(1000-3000mg/100g)，酱油/味精/鸡精等调味品含钠高
7. dayTotalSoFar.calories 为该餐之前已摄入的总热量（如有提及）
8. 只返回 JSON，不要任何其他文字
9. 确保返回的 meals 数组中，用户文本里提到的每个食物都是独立的一条记录，食物数量和 meals 数组长度一致。逐一核对，一个食物 = 一个 meal 对象，绝对不能合并！
10. **carbs/protein/fat/sodium 字段必填**，每个食物都必须估算这四个值，即使为0也要标注。钠(sodium)单位为 mg。同时在 diet 层级输出 totalCarbs/totalProtein/totalFat/totalSodium 汇总
11. **所有数值保留到小数点后1位**（如 3.5、12.0、0.5），不要输出过长小数（如 3.9999999）
12. **睡眠阶段必须提取**：Apple Watch/健康App中常见"深睡""核心睡眠""REM""清醒"等阶段数据，分别提取为 deepSleep/lightSleep(coreSleep)/remSleep/awakeTime，单位为小时。如"深睡 1h20min"→1.33h。"核心睡眠"等同于 lightSleep
   **🔥 清醒次数必须提取！** Apple Watch/健康App中常见"清醒 N次"（如"清醒 2次""夜间清醒1次"），必须提取为 awakeCount 字段（整数）。清醒时长提取为 awakeTime（如"清醒 15min"→0.25h）。两者缺一不可！
13. **🔥 睡眠评分必须原样提取（最高优先级）**：文字中出现的睡眠评分（如"睡眠评分77""Apple Watch显示71分""睡眠 71"甚至孤立的0-100数字出现在睡眠相关上下文），必须提取为 sleepScore 字段，原样保留整数，不得自行计算或修改。这是用户最关心的健康指标之一，遗漏将严重影响数据质量

如果没找到任何健康数据，返回：{"error":"未识别到健康数据"}`;

/** 四舍五入到小数点后1位，消除浮点数误差。
 *  使用 toFixed(1) 而非 Math.round(v*10)/10，后者乘除过程会重新引入浮点误差。 */
function round1(v: number): number {
  return Number(v.toFixed(1));
}

/** 从食物库匹配并补充宏量营养素（库中有的食物用精确数据替代 AI 估算） */
function enrichMealsWithLibrary(meals: DietMeal[]): DietMeal[] {
  return meals.map(meal => {
    const food = findFood(meal.content);
    if (food) {
      console.log(`[饮食补充] 食物库匹配: "${meal.content}" → ${food.name} (${food.caloriesPer100g}kcal/100g)`);
      return {
        ...meal,
        // 使用 != null 判断，避免 AI 返回 0 时被 || 运算符错误跳过
        calories: meal.calories != null ? round1(meal.calories) : round1(food.caloriesPer100g),
        carbs: meal.carbs != null ? round1(meal.carbs) : round1(food.carbsPer100g),
        protein: meal.protein != null ? round1(meal.protein) : round1(food.proteinPer100g),
        fat: meal.fat != null ? round1(meal.fat) : round1(food.fatPer100g),
        sodium: meal.sodium != null ? round1(meal.sodium) : (food.sodiumPer100g != null ? round1(food.sodiumPer100g) : undefined),
      };
    }
    // 即使食物库没有匹配，也要对 AI 返回值取整，防止 999999 循环小数
    return {
      ...meal,
      calories: meal.calories != null ? round1(meal.calories) : meal.calories,
      carbs: meal.carbs != null ? round1(meal.carbs) : meal.carbs,
      protein: meal.protein != null ? round1(meal.protein) : meal.protein,
      fat: meal.fat != null ? round1(meal.fat) : meal.fat,
      sodium: meal.sodium != null ? round1(meal.sodium) : meal.sodium,
    };
  });
}

/** 解析用户文本中的健康数据并保存到日报 */
export async function parseAndSaveHealthText(
  dateStr: string,
  text: string,
  cfg: AppConfig,
  options?: { isCorrection?: boolean },
): Promise<{ savedItems: string[]; error?: string }> {
  const client = getDeepSeekClient();

  let response: any;
  try {
    response = await client.chat.completions.create({
      model: cfg.deepseek.healthModel,
      messages: [
        { role: 'user', content: `${HEALTH_TEXT_PARSE_PROMPT}\n\n用户文本：${text}` },
      ],
      max_tokens: 4000,
      temperature: 0.1,
    });
  } catch (err: any) {
    return { savedItems: [], error: `AI 解析失败: ${err.message}` };
  }

  const content = response.choices[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { savedItems: [], error: 'AI 未返回有效数据' };
  }

  let extracted: any;
  try {
    extracted = JSON.parse(jsonMatch[0]);
  } catch {
    return { savedItems: [], error: 'AI 返回的 JSON 解析失败' };
  }

  if (extracted.error) {
    return { savedItems: [], error: extracted.error };
  }

  const { sleep, diet, training, weight, steps, supplements, notes } = extracted;
  const savedItems: string[] = [];

  // 拆分合并的多个食物为独立条目（AI 有时会把多个食物合并到一个 content 中）
  if (diet?.meals?.length) {
    diet.meals = splitCombinedMeals(diet.meals);
  }

  // 从食物库补充宏量营养素（库中已有食物的精确数据优于 AI 估算）
  if (diet?.meals?.length) {
    diet.meals = enrichMealsWithLibrary(diet.meals);
  }

  // 用静态字典交叉验证并修正 AI 估值（防止 317.5g 熬海杂鱼被估成 5 kcal 这类离谱错误）
  if (diet?.meals?.length) {
    let correctedCount = 0;
    diet.meals = diet.meals.map((m: any) => {
      const corrected = correctMealBeforeSave(m);
      if (corrected.calories !== m.calories) correctedCount++;
      return corrected;
    });
    if (correctedCount > 0) {
      console.log(`[字典校验] 共修正 ${correctedCount} 个食物的 AI 估值`);
    }
  }

  // 修复 AI 可能遗漏的 time 字段：尝试从内容或上下文推断餐次
  if (diet?.meals?.length) {
    let repairedCount = 0;
    diet.meals = diet.meals.map((m: any, idx: number) => {
      if (!m.time) {
        // 优先从用户文本推断（如"修正晚餐"暗示 dinnertime）
        const fromContext = inferMealTimeFromText(text);
        const inferred = fromContext || inferMealTime(m.content || '');
        console.warn(`[AI解析] 餐次#${idx} 缺少time字段，内容="${m.content}" 上下文=${fromContext || '无'} → 推断为 ${inferred}`);
        repairedCount++;
        return { ...m, time: inferred };
      }
      return m;
    });
    if (repairedCount > 0) {
      console.log(`[AI解析] 共修复 ${repairedCount} 个缺少time字段的餐次`);
    }
  }

  // 如果是修正模式，强制设置 replaceMeals 为该次提交的所有餐次（不依赖AI检测关键词）
  if (options?.isCorrection && diet?.meals?.length) {
    const allMealTimes = [...new Set(diet.meals.map((m: any) => m.time))];
    (diet as any).replaceMeals = allMealTimes;
    console.log(`[修正模式] 强制替换餐次: ${allMealTimes.join(', ')}`);
  }

  await generateHealthAnalysis(dateStr, cfg, {
    sleep: sleep as SleepData | undefined,
    diet: diet as DietData | undefined,
    training: training as any,
    weight: weight ? parseFloat(String(weight)) : undefined,
    steps: steps ? parseInt(String(steps), 10) : undefined,
    notes: notes || undefined,
    supplements: supplements || undefined,
  });

  if (sleep) savedItems.push('睡眠');
  if (diet) savedItems.push('饮食');
  if (training) savedItems.push('训练');
  if (weight) savedItems.push(`体重(${weight}kg)`);
  if (steps) savedItems.push(`步数(${steps})`);
  if (supplements) savedItems.push('补剂');
  if (notes && !sleep && !diet && !training && !weight && !steps && !supplements) savedItems.push('备注');

  return { savedItems };
}
