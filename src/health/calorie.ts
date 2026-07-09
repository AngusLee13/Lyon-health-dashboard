import { DailyRecord, DietMeal, DietData } from './types';
import { config } from '../config';
import { matchCalorieFromLibrary } from './foodLibrary';

/** 统一 BMR 计算：优先用 .env 中实测的 KATCH_MCARDLE_BMR，否则用调整体重公式 */
export function getBMR(weightKg: number, age?: number): number {
  const envBmr = parseInt(process.env.KATCH_MCARDLE_BMR || '', 10);
  if (envBmr > 0) return envBmr;
  // 调整体重：理想76kg + 1/4×(实际-理想)
  const adjW = Math.round(76 + 0.25 * (weightKg - 76));
  return Math.round(10 * adjW + 6.25 * 181 - 5 * (age || 31) + 5);
}

/** 单个食物的钠含量估算（mg/100g）——常用中餐（参考中国食物成分表） */
const FOOD_SODIUM: Record<string, number> = {
  // 复合菜品（需在成分关键词之前，确保优先匹配）
  '辣肉雪菜拌面': 1200, '雪菜肉丝面': 650, '榨菜肉丝面': 600,
  // 东北过油菜（酱汁+过油，钠含量高）
  '溜肉段烧茄子': 600, '溜肉段': 650, '锅包肉': 550, '烧茄子': 500,
  '地三鲜': 450, '焦溜丸子': 700, '糖醋里脊': 480, '软炸里脊': 400,
  // 麻辣香锅/干锅（重调料，钠含量极高）
  '麻辣香锅': 900, '麻辣拌': 750, '干锅': 850, '香锅': 800,
  // 炸制食品（裹粉炸制，通常配椒盐/蘸料）
  '炸肉': 600, '炸鱼': 450, '炸蘑菇': 500, '炸茄盒': 550, '炸藕合': 500,
  // 主食
  '米饭': 3, '馒头': 165, '面条': 120, '花卷': 160, '包子': 200,
  '油条': 220, '豆腐脑': 200, '豆浆': 3, '燕麦': 4,
  // 蛋白质
  '鸡蛋': 130, '茶叶蛋': 450, '鸡胸肉': 44, '鸡腿肉': 70, '鸡丁': 65,
  '宫保鸡丁': 420, '猪肉': 57, '牛肉': 53, '羊肉': 80, '鱼': 40,
  '虾': 150, '三文鱼': 45, '金枪鱼': 300, '鸡翅': 75, '培根': 1500,
  '火腿': 1000, '排骨': 65, '肉丸': 450, '香肠': 800,
  // 豆制品
  '豆腐': 7, '豆皮': 10, '毛豆': 1,
  // 蔬菜
  '青菜': 70, '白菜': 50, '西兰花': 27, '番茄': 5, '黄瓜': 5,
  '胡萝卜': 70, '土豆': 3, '茄子': 5, '蘑菇': 5, '木耳': 10,
  '菠菜': 80, '生菜': 10, '洋葱': 4, '玉米': 1, '南瓜': 1,
  '红薯': 30, '紫薯': 30, '山药': 20,
  // 水果
  '苹果': 2, '香蕉': 1, '橙子': 1, '西瓜': 1,
  // 乳制品
  '牛奶': 45, '酸奶': 60, '奶酪': 600,
  // 快餐
  '吉士堡': 680, '双层吉士堡': 800, '汉堡': 500, '巨无霸': 550,
  '麦乐鸡': 550, '薯条': 210, '玉米杯': 1, '麦香鱼': 450,
  '板烧鸡腿堡': 650, '麦辣鸡腿堡': 700, '鸡块': 500,
  '披萨': 600, '意大利面': 250, '沙拉': 200,
  // 零食/饮品
  '巧克力': 70, '饼干': 300, '蛋糕': 250, '冰淇淋': 65,
  '咖啡': 2, '拿铁': 45, '可乐': 5, '雪碧': 8,
  '橙汁': 2, '运动饮料': 40,
  // 坚果/油脂
  '花生': 3, '核桃': 2, '杏仁': 1, '腰果': 10,
  '橄榄油': 0, '黄油': 40,
  // 鸡蛋木耳菜
  '鸡蛋炒木耳': 95, '醋溜木须': 350, '木须肉': 400,
  // 腌制品（钠含量极高）
  '雪菜': 4000, '榨菜': 4500, '酸菜': 2000, '泡菜': 1500, '腊肉': 2500,
  '火腿肠': 900, '蒜肠': 850, '香辣肠': 950,
  // 复合菜品补充
  '拌面': 350, '凉拌粉': 300, '酥肉': 400, '辣肉': 500,
  // 炒制主食（酱油+盐调味，钠含量较高）
  '炒饼': 400, '炒面': 380, '炒河粉': 350, '炒饭': 350, '炒米粉': 380,
  '炒馍': 380, '炒疙瘩': 360, '炒粉': 380,
};

/** 单个食物的热量估算（kcal/100g）——常用中餐 */
const FOOD_CALORIES: Record<string, number> = {
  // 复合菜品（需放在成分关键词之前，确保优先匹配）
  '辣肉雪菜拌面': 135, '雪菜肉丝面': 165, '榨菜肉丝面': 155,
  // 东北过油菜（肉段/茄子先炸后炒，吸油量极大，热量远高于食材本身）
  '溜肉段烧茄子': 220, '溜肉段': 255, '锅包肉': 250, '烧茄子': 180,
  '地三鲜': 160, '焦溜丸子': 240, '糖醋里脊': 230, '软炸里脊': 220,
  // 麻辣香锅/干锅（重油炒制，热量密度高）
  '麻辣香锅': 200, '麻辣拌': 160, '干锅': 200, '香锅': 190,
  // 炸制食品（裹粉/挂糊油炸，吸油率 15-25%）
  '炸肉': 320, '炸鱼': 250, '炸蘑菇': 280, '炸茄盒': 260, '炸藕合': 250,
  // 主食
  '米饭': 116, '馒头': 223, '面条': 110, '花卷': 211, '包子': 220,
  '油条': 386, '豆腐脑': 47, '豆浆': 31, '鸡蛋': 144, '茶叶蛋': 144,
  '鸡胸肉': 133, '鸡腿肉': 181, '鸡丁': 167, '宫保鸡丁': 185,
  '猪肉': 242, '牛肉': 125, '羊肉': 203, '鱼': 105, '虾': 93,
  '豆腐': 76, '青菜': 25, '白菜': 13, '西兰花': 34, '番茄': 20,
  '黄瓜': 16, '胡萝卜': 37, '土豆': 76, '茄子': 23, '蘑菇': 22,
  '木耳': 21, '鸡蛋炒木耳': 95, '醋溜木须': 130, '木须肉': 145,
  '苹果': 52, '香蕉': 89, '橙子': 47, '西瓜': 30,
  '牛奶': 54, '酸奶': 72, '燕麦': 338,
  // 快餐/外食
  '吉士堡': 260, '双层吉士堡': 260, '汉堡': 250, '巨无霸': 240,
  '麦乐鸡': 260, '薯条': 300, '玉米杯': 70, '麦香鱼': 220,
  '板烧鸡腿堡': 210, '麦辣鸡腿堡': 280, '鸡块': 230,
  '披萨': 270, '意大利面': 130, '沙拉': 35,
  // 肉类补充
  '三文鱼': 208, '金枪鱼': 130, '鸡翅': 220, '培根': 540,
  '火腿': 145, '排骨': 250, '肉丸': 200, '香肠': 300,
  // 蔬菜/豆制品补充
  '菠菜': 23, '生菜': 15, '洋葱': 40, '玉米': 96, '南瓜': 26,
  '红薯': 86, '紫薯': 82, '山药': 57, '毛豆': 131, '豆皮': 409,
  // 零食/饮品
  '巧克力': 540, '饼干': 430, '蛋糕': 350, '冰淇淋': 200,
  '咖啡': 2, '拿铁': 56, '可乐': 42, '雪碧': 41,
  '橙汁': 45, '运动饮料': 26,
  // 坚果/油脂
  '花生': 567, '核桃': 650, '杏仁': 580, '腰果': 553,
  '橄榄油': 884, '黄油': 717, '奶酪': 350,
  // 腌制品
  '雪菜': 35, '榨菜': 30, '酸菜': 20, '泡菜': 25, '腊肉': 400,
  '火腿肠': 200, '蒜肠': 250, '香辣肠': 280,
  // 复合菜品补充
  '拌面': 160, '凉拌粉': 140, '酥肉': 320, '辣肉': 280,
  // 炒制主食（糖油混合物：高碳水+大量油脂，热量密度远高于普通主食）
  '炒饼': 250, '炒面': 220, '炒河粉': 200, '炒饭': 200, '炒米粉': 210,
  '炒馍': 240, '炒疙瘩': 220, '炒粉': 210,
};

/** 尝试从食物名称匹配已知热量（优先动态库，回退静态字典） */
function matchCalorie(foodName: string): number | null {
  const result = matchFoodCalorie(foodName);
  return result.source !== 'none' ? result.caloriesPer100g : null;
}

/** 食物匹配结果（含完整宏量营养素） */
export interface FoodMatchResult {
  caloriesPer100g: number;
  carbsPer100g: number | null;
  proteinPer100g: number | null;
  fatPer100g: number | null;
  sodiumPer100g: number | null;
  source: 'library' | 'library_similar' | 'static' | 'none';
  /** 模糊匹配时使用的参考食物名 */
  referenceName?: string;
}

/** 优先查动态食物库，回退静态字典，返回完整宏量营养素 */
export function matchFoodCalorie(foodName: string): FoodMatchResult {
  // 第一步：查动态食物库（含模糊匹配）
  const libMatch = matchCalorieFromLibrary(foodName);
  if (libMatch) {
    return {
      caloriesPer100g: libMatch.caloriesPer100g,
      carbsPer100g: libMatch.carbsPer100g,
      proteinPer100g: libMatch.proteinPer100g,
      fatPer100g: libMatch.fatPer100g,
      sodiumPer100g: libMatch.sodiumPer100g,
      source: libMatch.source as 'library' | 'library_similar',
      referenceName: libMatch.referenceName,
    };
  }

  // 第二步：回退静态字典（收集所有匹配，选最长键 — 确保"鸡蛋炒木耳"优先于"鸡蛋"、"炒面"优先于同长度的"鸡蛋"）
  let bestStaticMatch: { key: string; cal: number } | null = null;
  for (const [key, cal] of Object.entries(FOOD_CALORIES)) {
    // 选最精确的匹配：键越长越精确；同长度时选在食物名中出现位置更靠后的（核心食物通常在中餐菜名末尾，如"鸡蛋炒面"→炒面）
    if (foodName.includes(key)) {
      if (!bestStaticMatch ||
          key.length > bestStaticMatch.key.length ||
          (key.length === bestStaticMatch.key.length && foodName.indexOf(key) > foodName.indexOf(bestStaticMatch.key))) {
        bestStaticMatch = { key, cal };
      }
    }
  }
  if (bestStaticMatch) {
    const sodium = FOOD_SODIUM[bestStaticMatch.key] ?? null;
    return {
      caloriesPer100g: bestStaticMatch.cal,
      carbsPer100g: null,
      proteinPer100g: null,
      fatPer100g: null,
      sodiumPer100g: sodium,
      source: 'static',
    };
  }

  return { caloriesPer100g: 0, carbsPer100g: null, proteinPer100g: null, fatPer100g: null, sodiumPer100g: null, source: 'none' };
}

/** 根据食物名中的烹饪方式估算额外油脂热量（kcal/份）
 *  中餐烹饪用油是热量低估的主要来源——字典值通常只含食材本身 */
export function estimateCookingOilKcal(foodName: string): number {
  // 油炸类（+150kcal/份）
  if (/炸|酥[肉排鱼鸡]|脆皮|油淋|糖醋|锅包/.test(foodName)) return 150;
  // 溜制（先炸后溜芡，+120kcal/份）——溜肉段、焦溜丸子、醋溜等
  if (/溜[肉段丸排鱼鸡]|焦溜|醋溜|滑溜/.test(foodName)) return 120;
  // 川式重油菜品（+100kcal/份）
  if (/宫保|鱼香|麻辣|回锅|水煮[肉鱼牛]|干煸|红油|辣子|干锅/.test(foodName)) return 100;
  // 炒/煎/爆/煸/铁板（+80kcal/份）
  if (/炒[^前]|煎[^饼饺包]|爆炒|煸|铁板/.test(foodName)) return 80;
  // 烧/焖/炖/卤/熬/红烧/烧茄（茄子吸油极强，+60kcal/份）
  if (/烧茄|烧[^饼饺]|焖|炖|卤|红烧|酱爆|三杯|熬/.test(foodName)) return 60;
  // 烤制（+30kcal/份）
  if (/烤[^冷面]/.test(foodName)) return 30;
  // 蒸/煮/白灼/凉拌/沙拉 → 不追加
  return 0;
}

/** 从 content 文本解析宏量营养素（回退方案，用于 AI 未提供字段时补充） */
function parseContentMacros(content: string): { calories: number; carbs: number; protein: number; fat: number; sodium: number } {
  let cals = 0;
  let carbsTotal = 0;
  let proteinTotal = 0;
  let fatTotal = 0;
  let sodiumTotal = 0;

  // 先按明确的食物分隔符拆分（逗号/顿号），不能用空格拆——会断开"燕麦 60g"
  const foodItems = content.split(/[，,、]+/).map(s => s.trim()).filter(Boolean);

  for (const item of foodItems) {
    // 提取份量：匹配 "60g"、"317.5g"、"200ml"、"150克" 等（支持小数）
    const gramMatch = item.match(/(\d+(?:\.\d+)?)\s*(g|克|ml|毫升|kg|千克)/i);
    let grams: number | null = null;
    let foodRaw = item;

    if (gramMatch) {
      grams = parseFloat(gramMatch[1]);
      // kg → g 换算
      if (/kg|千克/i.test(gramMatch[2])) grams *= 1000;
      // 去掉份量部分，剩余为食物名
      foodRaw = item.replace(gramMatch[0], '').trim();
    }

    // 使用升级后的匹配函数（优先动态库）
    const foodMatch = matchFoodCalorie(foodRaw);
    if (foodMatch.source !== 'none' && grams !== null) {
      cals += Math.round(foodMatch.caloriesPer100g * grams / 100);
      if (foodMatch.carbsPer100g !== null) carbsTotal += Math.round(foodMatch.carbsPer100g * grams / 100);
      if (foodMatch.proteinPer100g !== null) proteinTotal += Math.round(foodMatch.proteinPer100g * grams / 100);
      if (foodMatch.fatPer100g !== null) fatTotal += Math.round(foodMatch.fatPer100g * grams / 100);
      if (foodMatch.sodiumPer100g !== null) sodiumTotal += Math.round(foodMatch.sodiumPer100g * grams / 100);
    } else if (foodMatch.source !== 'none' && grams === null) {
      // 通用分量估算（如"一碗"≈300g、"一份"≈300g、"米饭"≈250g）
      if (item.includes('碗')) grams = 300;
      else if (item.includes('份')) grams = 300;
      else if (item.includes('个') || item.includes('根')) grams = 80;
      else if (/米饭|白饭/.test(foodRaw)) grams = 250;
      else grams = 150; // 默认估计
      cals += Math.round(foodMatch.caloriesPer100g * grams / 100);
      if (foodMatch.carbsPer100g !== null) carbsTotal += Math.round(foodMatch.carbsPer100g * grams / 100);
      if (foodMatch.proteinPer100g !== null) proteinTotal += Math.round(foodMatch.proteinPer100g * grams / 100);
      if (foodMatch.fatPer100g !== null) fatTotal += Math.round(foodMatch.fatPer100g * grams / 100);
      if (foodMatch.sodiumPer100g !== null) sodiumTotal += Math.round(foodMatch.sodiumPer100g * grams / 100);
    }
  }
  return { calories: cals, carbs: carbsTotal, protein: proteinTotal, fat: fatTotal, sodium: sodiumTotal };
}

/** 四舍五入到小数点后 1 位，消除浮点数误差（如 3.9999999 → 4.0）。
 *  使用 toFixed(1) 而非 Math.round(v*10)/10，因为后者在乘除过程中
 *  会重新引入浮点数精度问题（如 0.35*10=3.4999... 导致错误舍入）。 */
function r1(v: number): number {
  return Number(v.toFixed(1));
}

/** 从食物文本中估算克数，支持多种中文份量单位 */
export function estimateGrams(part: string): number {
  // 精确克数：60g、317.5g、150克（支持小数）
  const gMatch = part.match(/(\d+(?:\.\d+)?)\s*(g|克)\b/);
  if (gMatch) return parseFloat(gMatch[1]);
  // 毫升近似克数：200ml、250毫升（支持小数）
  const mlMatch = part.match(/(\d+(?:\.\d+)?)\s*(ml|毫升)\b/i);
  if (mlMatch) return parseFloat(mlMatch[1]);
  // 千克 → 克（支持小数）
  const kgMatch = part.match(/(\d+(?:\.\d+)?)\s*(kg|千克)\b/i);
  if (kgMatch) return parseFloat(kgMatch[1]) * 1000;

  // 中文份量单位估算
  const numMatch = part.match(/(\d+)/);
  const n = numMatch ? parseInt(numMatch[1]) : 1;
  if (part.includes('串')) return n * 25;       // 1串肉 ≈ 25g
  if (part.includes('个') || part.includes('根')) return n * 80;  // 1个/根 ≈ 80g
  if (part.includes('碗')) return n * 300;       // 1碗 ≈ 300g
  if (part.includes('份')) return n * 300;       // 1份 ≈ 300g（餐馆炒饼/炒面等主食通常300-400g）
  if (part.includes('片')) return n * 30;        // 1片 ≈ 30g
  if (part.includes('块')) return n * 50;        // 1块 ≈ 50g
  if (part.includes('杯')) return n * 250;       // 1杯 ≈ 250ml ≈ 250g
  if (part.includes('勺')) return n * 15;        // 1勺 ≈ 15g

  return 100; // 无单位默认 100g
}

/** 将合并了多个食物的 content 拆分为独立 meal 对象
 *  例如 "燕麦 60g，冻蓝莓 80g，简醇0蔗糖酸奶 100g" → 3 个独立 meal
 *  用于处理 AI 偶尔不按 prompt 要求输出独立条目的情况 */
export function splitCombinedMeals(meals: DietMeal[]): DietMeal[] {
  const result: DietMeal[] = [];
  for (const meal of meals) {
    // 按中文逗号/英文逗号/顿号拆分（这些是明确的食物分隔符，空格不是）
    const parts = meal.content.split(/[，,、]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) {
      result.push(meal);
      continue;
    }

    console.log(`[饮食拆分] 检测到合并内容 "${meal.content}" → 拆分为 ${parts.length} 个独立食物`);

    // 先计算每个部分的估算克数，以及总克数（用于比例摊分）
    const partGrams = parts.map(p => estimateGrams(p));
    const totalGrams = partGrams.reduce((a, b) => a + b, 0);

    // 为每个拆分后的食物创建独立的 meal 对象
    const splitMeals: DietMeal[] = parts.map((part, idx) => {
      const grams = partGrams[idx];
      const gramRatio = grams / 100;                   // 字典匹配时用: per-100g × 克数/100
      const propRatio = totalGrams > 0 ? grams / totalGrams : 1 / parts.length;  // 未匹配时按克数比例摊分 AI 估值

      // 尝试从食物库/静态字典匹配该食物
      const foodMatch = matchFoodCalorie(part);

      if (foodMatch.source !== 'none') {
        // 热量取值策略（按优先级）：
        // 1. 动态食物库（library/library_similar）→ 人工校准的精确数据，始终信任
        // 2. 静态字典 + 有明确克数/毫升 → 重量可靠，per-100g 字典值基本准确
        // 3. 静态字典 + 无明确重量 + 有 AI 估值 → 用比例摊分（estimateGrams
        //    默认值可能严重偏离实际，如"个"≈80g 但对恩施小土豆只有 30-40g）
        // 4. 静态字典 + 无明确重量 + 无 AI 估值 → 字典兜底（比空值好）
        const hasAI = meal.calories != null && meal.calories > 0;
        const isLibrary = foodMatch.source === 'library' || foodMatch.source === 'library_similar';
        // 检查该食物部分是否自带明确重量单位（g/克/ml/毫升/kg/千克）
        const hasExplicitWeight = /\d+\s*(g|克|ml|毫升|kg|千克)/i.test(part);
        const useDictCalories = isLibrary || hasExplicitWeight || !hasAI;
        const useDictMacros = isLibrary;  // 仅动态食物库有完整宏量素数据（静态字典缺碳蛋脂）

        return {
          time: meal.time,
          content: part,
          calories: useDictCalories
            ? r1(foodMatch.caloriesPer100g * gramRatio)
            : r1((meal.calories || 0) * propRatio),
          carbs: useDictMacros && foodMatch.carbsPer100g != null
            ? r1(foodMatch.carbsPer100g * gramRatio)
            : (meal.carbs != null ? r1(meal.carbs * propRatio) : undefined),
          protein: useDictMacros && foodMatch.proteinPer100g != null
            ? r1(foodMatch.proteinPer100g * gramRatio)
            : (meal.protein != null ? r1(meal.protein * propRatio) : undefined),
          fat: useDictMacros && foodMatch.fatPer100g != null
            ? r1(foodMatch.fatPer100g * gramRatio)
            : (meal.fat != null ? r1(meal.fat * propRatio) : undefined),
          sodium: foodMatch.sodiumPer100g != null
            ? r1(foodMatch.sodiumPer100g * gramRatio)
            : (meal.sodium != null ? r1(meal.sodium * propRatio) : undefined),
        };
      }

      // 食物库和字典都没匹配到 → 按估算克数比例分摊 AI 估算的总热量和宏量素
      return {
        time: meal.time,
        content: part,
        calories: r1((meal.calories || 0) * propRatio),
        carbs: meal.carbs != null ? r1(meal.carbs * propRatio) : undefined,
        protein: meal.protein != null ? r1(meal.protein * propRatio) : undefined,
        fat: meal.fat != null ? r1(meal.fat * propRatio) : undefined,
        sodium: meal.sodium != null ? r1(meal.sodium * propRatio) : undefined,
      };
    });

    result.push(...splitMeals);
  }
  return result;
}

/** 从饮食内容解析食物热量和宏量营养素（AI 提供值优先，但字典值显著高于 AI 时以字典为准，防止糖油混合物被低估） */
function parseMealCalories(meal: DietMeal): { calories: number; carbs: number; protein: number; fat: number; sodium: number } {
  // 从 content 文本解析作为回退值（用于补充 AI 未估算的字段，尤其是钠）
  const contentMacros = parseContentMacros(meal.content);

  // AI 提供的值优先；AI 未提供（undefined/null）或为 0 时，用 content 解析值补充
  let fromAI = meal.calories != null && meal.calories > 0;
  let baseCal = fromAI ? meal.calories! : (contentMacros.calories || meal.calories || 0);

  // ── 交叉验证：字典/内容解析值显著高于 AI 估值时（≥1.3x），以字典为准 ──
  // AI 容易系统性低估糖油混合物（炒饼/炒面/炒饭等），字典值是人工校准的更可靠
  // 注意：字典 per-100g 值已包含烹饪用油，设为 fromAI=true 避免 estimateCookingOilKcal 重复追加
  if (fromAI && contentMacros.calories > 0 && contentMacros.calories > meal.calories! * 1.3) {
    console.log(`[热量修正] "${meal.content}" AI估值=${meal.calories}kcal → 字典值=${contentMacros.calories}kcal (${(contentMacros.calories / meal.calories!).toFixed(1)}x)`);
    baseCal = contentMacros.calories;
    // fromAI 保持 true → oilKcal=0，字典的 per-100g 值已含烹饪用油，不重复追加
  }

  // ── 安全下限：AI 给出极低估值时的兜底检查 ──
  // 任何食物热量不应低于 10 kcal/100g（水/零卡饮料除外），317.5g 食物至少应有 ~30 kcal
  // 当 AI 估值低于 contentMacros 的 30% 且 contentMacros > 50 时，强制使用字典值
  if (fromAI && contentMacros.calories >= 50 && meal.calories! < contentMacros.calories * 0.3) {
    console.log(`[热量兜底] "${meal.content}" AI估值=${meal.calories}kcal 严重偏低 (字典=${contentMacros.calories}kcal)，强制使用字典值`);
    baseCal = contentMacros.calories;
  }

  const calories = r1(baseCal);
  // 宏量营养素：AI 有值则用 AI，否则用 content 解析（即使是 0 也接受，因为有些食物确实为 0）
  const carbs = r1(meal.carbs != null ? meal.carbs : contentMacros.carbs);
  const protein = r1(meal.protein != null ? meal.protein : contentMacros.protein);
  const fat = r1(meal.fat != null ? meal.fat : contentMacros.fat);
  const sodium = r1(meal.sodium != null ? meal.sodium : contentMacros.sodium);

  // 烹饪用油修正：仅在字典回退时追加（字典 per-100g 值已含烹饪用油，AI 估值也已包含）
  const oilKcal = fromAI ? 0 : estimateCookingOilKcal(meal.content);
  return { calories: r1(calories + oilKcal), carbs, protein, fat, sodium };
}

/** 在存储前用字典值校验并修正单个 meal 的 AI 估值
 *  与 parseMealCalories 不同：此函数直接修改并返回 DietMeal，用于数据落盘前的清洗 */
export function correctMealBeforeSave(meal: DietMeal): DietMeal {
  const contentMacros = parseContentMacros(meal.content);
  const fromAI = meal.calories != null && meal.calories > 0;

  // 交叉验证：字典值 ≥ AI 估值 1.3x 时，以字典为准
  if (fromAI && contentMacros.calories > 0 && contentMacros.calories > meal.calories! * 1.3) {
    console.log(`[存储前修正] "${meal.content}" AI估值=${meal.calories}kcal → 字典值=${contentMacros.calories}kcal (${(contentMacros.calories / meal.calories!).toFixed(1)}x)`);
    return {
      ...meal,
      calories: r1(contentMacros.calories),
      carbs: r1(contentMacros.carbs || meal.carbs || 0),
      protein: r1(contentMacros.protein || meal.protein || 0),
      fat: r1(contentMacros.fat || meal.fat || 0),
      sodium: r1(contentMacros.sodium || meal.sodium || 0),
    };
  }

  // 安全下限：AI 估值低于字典值 30% 且字典值 ≥ 50kcal → 强制字典值
  if (fromAI && contentMacros.calories >= 50 && meal.calories! < contentMacros.calories * 0.3) {
    console.log(`[存储前兜底] "${meal.content}" AI估值=${meal.calories}kcal 严重偏低 (字典=${contentMacros.calories}kcal)，强制修正`);
    return {
      ...meal,
      calories: r1(contentMacros.calories),
      carbs: r1(contentMacros.carbs || meal.carbs || 0),
      protein: r1(contentMacros.protein || meal.protein || 0),
      fat: r1(contentMacros.fat || meal.fat || 0),
      sodium: r1(contentMacros.sodium || meal.sodium || 0),
    };
  }

  return meal;
}

export interface CalorieSummary {
  target: number;            // 基础热量目标（固定值，如 2000）
  adjustedTarget: number;    // 运动调整后目标 = target + exerciseBonus
  exerciseBonus: number;     // 运动奖励热量（健身+有氧+步数）
  consumed: number;
  remaining: number;         // 基于固定 target 的剩余（不受运动奖励影响）
  meals: { time: string; content: string; calories: number }[];
  percentage: number;        // 基于 adjustedTarget 的百分比
  carbs: number;
  protein: number;
  fat: number;
  sodium: number;            // 钠(mg)
  sodiumTarget: number;      // 钠目标(mg)
  sodiumPercentage: number;  // 钠目标达成百分比
}

/** 根据力量训练容量估算消耗热量（kcal），用作训记返回 0 时的兜底
 *  公式：总容量(kg) × 0.1 kcal/kg，复合动作（蹲/硬拉/卧推等）系数略高 */
export function estimateStrengthCalories(
  exercises: Array<{ sets: number; reps: number; weight: number }>,
): number {
  if (!exercises || exercises.length === 0) return 0;
  let totalVolume = 0;
  for (const ex of exercises) {
    const sets = ex.sets || 0;
    const reps = ex.reps || 0;
    const weight = ex.weight || 0;
    totalVolume += sets * reps * weight;
  }
  // 0.1 kcal/kg 是力量训练能耗的保守经验值（基于运动生物力学文献）
  return Math.round(totalVolume * 0.1);
}

/** 根据步数和体重估算日间活动消耗（kcal） */
export function estimateStepCalories(steps: number, weightKg: number): number {
  // 基于 MET 公式：每步约 0.04 kcal（70kg 基准），按体重线性缩放
  return Math.round(steps * 0.04 * (weightKg / 70));
}

/** 计算 0-100 睡眠评分（保留备用，当前仅测试使用） */
export function computeSleepScore(sleep: any): number {
  if (!sleep?.duration) return 0;
  const dur = sleep.duration;
  const deep = sleep.deepSleep || 0;
  const ratio = dur > 0 ? deep / dur : 0;

  // 时长评分 0-40
  let durScore = 0;
  if (dur >= 7.5 && dur <= 8.5) durScore = 40;
  else if (dur >= 7 && dur < 7.5) durScore = 35;
  else if (dur > 8.5 && dur <= 9) durScore = 30;
  else if (dur >= 6 && dur < 7) durScore = 25;
  else if (dur >= 5 && dur < 6) durScore = 15;
  else if (dur > 9) durScore = 10;
  else durScore = 5;

  // 深睡比例评分 0-30
  let deepScore = 0;
  if (ratio >= 0.25) deepScore = 30;
  else if (ratio >= 0.20) deepScore = 25;
  else if (ratio >= 0.15) deepScore = 20;
  else if (ratio >= 0.10) deepScore = 10;
  else deepScore = 5;

  // 质量评分 0-30
  const qMap: Record<string, number> = { excellent: 30, good: 22, fair: 12, poor: 5 };
  const qualityScore = qMap[sleep.quality] ?? 15;

  // 入睡时间惩罚（晚于0点扣分）
  let bedtimePenalty = 0;
  if (sleep.bedTime) {
    const bedHour = parseInt(sleep.bedTime.split(':')[0], 10);
    if (bedHour >= 0 && bedHour < 3) bedtimePenalty = 10;
    else if (bedHour >= 3 && bedHour < 6) bedtimePenalty = 15;
  }

  return Math.max(0, Math.min(100, durScore + deepScore + qualityScore - bedtimePenalty));
}

export function calcCalorieSummary(record: DailyRecord | null): CalorieSummary {
  // 5+2轻断食：断食日使用更低热量目标
  const isFasting = !!(record && (record as any).fastingDay);
  const target = isFasting ? config.health.fastingCalorieTarget : config.health.dailyCalorieTarget;
  const sodiumTarget = config.health.dailySodiumTarget ?? 2000;

  // ── 运动奖励热量：仅健身 + 有氧，步数消耗已在 TDEE 中通过 PAL 系数覆盖 ──
  const trainingCals = (record?.training?.calories || 0) + (record?.cardio?.calories || 0);
  const exerciseBonus = trainingCals;
  // 运动调整后目标 = 基础目标 + 运动奖励（100% 比例）
  const adjustedTarget = target + exerciseBonus;

  const meals: { time: string; content: string; calories: number }[] = [];

  if (!record || !record.diet) {
    return { target, adjustedTarget, exerciseBonus, consumed: 0, remaining: target, meals: [], percentage: 0, carbs: 0, protein: 0, fat: 0, sodium: 0, sodiumTarget, sodiumPercentage: 0 };
  }

  const diet = record.diet as any;
  // 确保合并的多个食物被拆分为独立条目（兼容旧数据中 AI 合并输出的情况）
  // 🔧 使用局部变量而非直接修改 diet.meals，避免污染原始 record 对象
  const mealsForCalc = diet.meals?.length ? splitCombinedMeals(diet.meals) : (diet.meals || []);
  let consumed = 0;
  let totalCarbs = 0;
  let totalProtein = 0;
  let totalFat = 0;
  let totalSodium = 0;

  // 优先解析 meals[] 数组（标准 DietData 格式）
  for (const meal of mealsForCalc) {
    const { calories: cal, carbs: c, protein: p, fat: f, sodium: s } = parseMealCalories(meal);
    consumed += cal;
    totalCarbs += c;
    totalProtein += p;
    totalFat += f;
    totalSodium += s;
    meals.push({ time: meal.time, content: meal.content, calories: cal, carbs: c || meal.carbs || 0, protein: p || meal.protein || 0, fat: f || meal.fat || 0, sodium: s || meal.sodium || 0 } as any);
  }

  // 扩展格式：breakfast/lunch/dinner/snack 属性存餐次
  if (meals.length === 0) {
    for (const mealKey of ['breakfast', 'lunch', 'dinner', 'snack']) {
      const m = diet[mealKey];
      if (m) {
        const cal = m.totalCalories || 0;
        consumed += cal;
        meals.push({
          time: mealKey,
          content: m.items ? m.items.map((i: any) => `${i.name}${i.amount || ''}`).join(' + ') : '',
          calories: cal,
        });
      }
    }
  }

  // 同一餐的食物合并为一行，每项食物后标注自身热量
  const mergedMeals = new Map<string, { items: { content: string; calories: number }[]; totalCalories: number; carbs: number; protein: number; fat: number; sodium: number }>();
  for (const meal of meals) {
    const m = meal as any;
    const existing = mergedMeals.get(meal.time);
    if (existing) {
      existing.items.push({ content: meal.content, calories: meal.calories });
      existing.totalCalories += meal.calories;
      existing.carbs += m.carbs || 0;
      existing.protein += m.protein || 0;
      existing.fat += m.fat || 0;
      existing.sodium += m.sodium || 0;
    } else {
      mergedMeals.set(meal.time, {
        items: [{ content: meal.content, calories: meal.calories }],
        totalCalories: meal.calories,
        carbs: m.carbs || 0,
        protein: m.protein || 0,
        fat: m.fat || 0,
        sodium: m.sodium || 0,
      });
    }
  }
  const merged = [...mergedMeals.entries()].map(([time, v]) => ({
    time,
    content: v.items.map(i => `${i.content}(${i.calories}kcal)`).join('、'),
    calories: v.totalCalories,
  }));

  // dayTotalSoFar.calories 或 totalCalories 覆盖总额（取最大值）
  if (diet.dayTotalSoFar?.calories && diet.dayTotalSoFar.calories > consumed) {
    consumed = diet.dayTotalSoFar.calories;
  }
  if (diet.totalCalories && diet.totalCalories > consumed) {
    consumed = diet.totalCalories;
  }

  // 优先使用 diet 级别的宏量营养素汇总（但 0 不覆盖正值，避免 AI 漏估钠时覆盖静态字典估算值）
  if (diet.totalCarbs !== undefined && diet.totalCarbs > 0) totalCarbs = diet.totalCarbs;
  if (diet.totalProtein !== undefined && diet.totalProtein > 0) totalProtein = diet.totalProtein;
  if (diet.totalFat !== undefined && diet.totalFat > 0) totalFat = diet.totalFat;
  if (diet.totalSodium !== undefined && diet.totalSodium > 0) totalSodium = diet.totalSodium;

  return {
    target,
    adjustedTarget,
    exerciseBonus,
    consumed: Math.round(consumed),
    // 剩余始终基于固定目标，运动奖励不增加"还能吃"的额度
    remaining: Math.round(Math.max(0, target - consumed)),
    meals: merged,
    // 百分比基于运动调整后的目标，运动日进度条自动放宽
    percentage: Math.round((consumed / adjustedTarget) * 100),
    carbs: r1(totalCarbs),
    protein: r1(totalProtein),
    fat: r1(totalFat),
    sodium: r1(totalSodium),
    sodiumTarget,
    sodiumPercentage: sodiumTarget > 0 ? Math.round((totalSodium / sodiumTarget) * 100) : 0,
  };
}
