/**
 * 修复历史饮食数据：将合并的内容拆分为独立食物条目
 *
 * 用法: cd D:\fisrt-cc && npx ts-node scripts/fix-meal-items.ts
 *
 * 原理:
 * - 检测 meals[] 中 content 含分隔符（逗号/顿号等）的条目
 * - 将合并条目拆分为多个独立条目，每个食物保留原始的 time
 * - 用静态食物库估算每个独立食物的热量/宏量营养素
 * - 无匹配的食物按比例从总热量中分摊
 * - 每修正一天自动备份原数据
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.resolve(__dirname, '..', '.data', 'health');
const BACKUP_DIR = path.resolve(__dirname, '..', '.data', 'health', '.fix-backup');

// ─── 食物热量库（与 calorie.ts 对应）───

const FOOD_CALORIES: Record<string, number> = {
  '燕麦': 338, '米饭': 116, '馒头': 223, '面条': 110, '花卷': 211, '包子': 220,
  '油条': 386, '豆腐脑': 47, '豆浆': 31, '鸡蛋': 144, '茶叶蛋': 144,
  '鸡胸肉': 133, '鸡腿肉': 181, '鸡丁': 167, '宫保鸡丁': 185,
  '猪肉': 242, '牛肉': 125, '羊肉': 203, '鱼': 105, '虾': 93,
  '豆腐': 76, '青菜': 25, '白菜': 13, '西兰花': 34, '番茄': 20,
  '黄瓜': 16, '胡萝卜': 37, '土豆': 76, '茄子': 23, '蘑菇': 22,
  '木耳': 21, '苹果': 52, '香蕉': 89, '橙子': 47, '西瓜': 30,
  '牛奶': 54, '酸奶': 72, '吉士堡': 260, '双层吉士堡': 260, '汉堡': 250,
  '巨无霸': 240, '麦乐鸡': 260, '薯条': 300, '玉米杯': 70, '麦香鱼': 220,
  '板烧鸡腿堡': 210, '麦辣鸡腿堡': 280, '鸡块': 230, '披萨': 270,
  '意大利面': 130, '沙拉': 35, '三文鱼': 208, '金枪鱼': 130,
  '鸡翅': 220, '培根': 540, '火腿': 145, '排骨': 250, '肉丸': 200, '香肠': 300,
  '菠菜': 23, '生菜': 15, '洋葱': 40, '玉米': 96, '南瓜': 26,
  '红薯': 86, '紫薯': 82, '山药': 57, '毛豆': 131, '豆皮': 409,
  '巧克力': 540, '饼干': 430, '蛋糕': 350, '冰淇淋': 200,
  '咖啡': 2, '拿铁': 56, '可乐': 42, '雪碧': 41, '橙汁': 45, '运动饮料': 26,
  '花生': 567, '核桃': 650, '杏仁': 580, '腰果': 553,
  '橄榄油': 884, '黄油': 717, '奶酪': 350,
  '雪菜': 35, '榨菜': 30, '酸菜': 20, '泡菜': 25, '腊肉': 400,
  '火腿肠': 200, '蒜肠': 250, '香辣肠': 280,
  '拌面': 160, '凉拌粉': 140, '酥肉': 320, '辣肉': 280,
  '全麦面包': 250, '纯牛奶': 54, '简醇': 72, '蓝莓': 57, '冻蓝莓': 57,
  '草莓': 32, '蛋白粉': 380, '水饺': 230, '饺子': 230, '馄饨': 200,
  '凉皮': 120, '烧麦': 220, '麦片': 367, '荞麦': 340,
  '优形': 133, '鸡腿': 181, '卤蛋': 144, '鹌鹑蛋': 160,
  '酱牛肉': 180, '腊八蒜': 30, '烤肠': 280, '香肠': 300,
  '脉动': 20, '凉拌菜': 35, '熏鹌鹑蛋': 160, '马兰头': 25,
  '菠萝': 41, '海河': 65, '青提': 69, '羽衣': 40,
  '平菇': 22, '炒肉': 180, '鸡腿肉': 181, '去皮': 0,
  '简醇0蔗糖酸奶': 65, '0蔗糖酸奶': 65, '酸奶': 72,
  '猪肉芹菜水饺': 230,
};

const FOOD_CARBS: Record<string, number> = {
  '燕麦': 66, '米饭': 26, '馒头': 44, '面条': 24, '包子': 28,
  '全麦面包': 45, '饺子': 35, '水饺': 35,
};

const FOOD_PROTEIN: Record<string, number> = {
  '燕麦': 12, '米饭': 2.6, '鸡蛋': 12, '鸡胸肉': 31, '鸡腿肉': 18,
  '猪肉': 17, '牛肉': 22, '鱼': 20, '虾': 20, '牛奶': 3.3,
  '全麦面包': 10, '酸奶': 2.5, '简醇0蔗糖酸奶': 2.5, '0蔗糖酸奶': 2.5,
  '饺子': 9, '水饺': 9, '酱牛肉': 30, '优形': 31,
};

const FOOD_FAT: Record<string, number> = {
  '鸡蛋': 9, '鸡胸肉': 3, '猪肉': 20, '牛肉': 4, '牛奶': 3.2,
  '全麦面包': 2, '饺子': 9, '水饺': 9, '酱牛肉': 6,
};

/** 单个食物的钠含量估算（mg/100g），与 calorie.ts 保持一致 */
const FOOD_SODIUM: Record<string, number> = {
  '辣肉雪菜拌面': 1200, '雪菜肉丝面': 650, '榨菜肉丝面': 600,
  '米饭': 3, '馒头': 165, '面条': 120, '花卷': 160, '包子': 200,
  '油条': 220, '豆腐脑': 200, '豆浆': 3, '燕麦': 4,
  '鸡蛋': 130, '茶叶蛋': 450, '鸡胸肉': 44, '鸡腿肉': 70, '鸡丁': 65,
  '宫保鸡丁': 420, '猪肉': 57, '牛肉': 53, '羊肉': 80, '鱼': 40,
  '虾': 150, '三文鱼': 45, '金枪鱼': 300, '鸡翅': 75, '培根': 1500,
  '火腿': 1000, '排骨': 65, '肉丸': 450, '香肠': 800,
  '豆腐': 7, '豆皮': 10, '毛豆': 1,
  '青菜': 70, '白菜': 50, '西兰花': 27, '番茄': 5, '黄瓜': 5,
  '胡萝卜': 70, '土豆': 3, '茄子': 5, '蘑菇': 5, '木耳': 10,
  '菠菜': 80, '生菜': 10, '洋葱': 4, '玉米': 1, '南瓜': 1,
  '红薯': 30, '紫薯': 30, '山药': 20,
  '苹果': 2, '香蕉': 1, '橙子': 1, '西瓜': 1,
  '牛奶': 45, '酸奶': 60, '奶酪': 600, '简醇': 60, '纯牛奶': 45,
  '吉士堡': 680, '双层吉士堡': 800, '汉堡': 500, '巨无霸': 550,
  '麦乐鸡': 550, '薯条': 210, '玉米杯': 1, '麦香鱼': 450,
  '板烧鸡腿堡': 650, '麦辣鸡腿堡': 700, '鸡块': 500,
  '披萨': 600, '意大利面': 250, '沙拉': 200,
  '巧克力': 70, '饼干': 300, '蛋糕': 250, '冰淇淋': 65,
  '咖啡': 2, '拿铁': 45, '可乐': 5, '雪碧': 8,
  '橙汁': 2, '运动饮料': 40,
  '花生': 3, '核桃': 2, '杏仁': 1, '腰果': 10,
  '橄榄油': 0, '黄油': 40,
  '鸡蛋炒木耳': 95, '醋溜木须': 350, '木须肉': 400,
  '雪菜': 4000, '榨菜': 4500, '酸菜': 2000, '泡菜': 1500, '腊肉': 2500,
  '火腿肠': 900, '蒜肠': 850, '香辣肠': 950,
  '拌面': 350, '凉拌粉': 300, '酥肉': 400, '辣肉': 500,
  '全麦面包': 120, '凉拌菜': 200, '凉皮': 300, '水饺': 350, '饺子': 350,
  '酱牛肉': 800, '烤肠': 700, '卤蛋': 400, '熏鹌鹑蛋': 400, '鹌鹑蛋': 400,
  '蓝莓': 1, '冻蓝莓': 1, '玉米': 1,
  '海河': 50, '脉动': 10, '鸡肉肠': 600, '鸡肉': 65,
  '0蔗糖酸奶': 60, '简醇0蔗糖酸奶': 60,
};

function round1(v: number): number {
  return Number(v.toFixed(1));
}

/** 从食物名提取份量，返回 { name, grams } */
function parseFoodItem(text: string): { name: string; grams: number | null } {
  const trimmed = text.trim();
  if (!trimmed) return { name: '', grams: null };

  // 1. 前置份量: "200g全麦面包" / "56g燕麦" / "200g 全麦面包"
  const preGramMatch = trimmed.match(/^(\d+)\s*g\s*(.*)/i);
  if (preGramMatch) {
    const name = preGramMatch[2].trim();
    const grams = parseInt(preGramMatch[1], 10);
    if (name && grams > 0) return { name, grams };
  }

  // 2. 后置份量: "燕麦 60g" / "米饭250g"
  const postGramMatch = trimmed.match(/^(.+?)\s*(\d+)\s*g\s*$/i);
  if (postGramMatch) {
    const name = postGramMatch[1].trim();
    const grams = parseInt(postGramMatch[2], 10);
    if (name && grams > 0) return { name, grams };
  }

  // 3. 括号内份量: "宫爆鸡丁1份(约200g)" / "全麦面包(200g)"
  const parenGramMatch = trimmed.match(/^(.+?)\s*\([^)]*(\d+)\s*g\s*\)\s*$/i);
  if (parenGramMatch) {
    const name = parenGramMatch[1].replace(/\s*\d+\s*(份|碗|个|根|瓶|杯|笼|盒|包|片|块|罐|袋)/, '').trim();
    const grams = parseInt(parenGramMatch[2], 10);
    if (name && grams > 0) return { name, grams };
  }

  // 4. 单位份量(无克数): "菠萝味脉动 1瓶" / "烤肠 1根"
  const unitMatch = trimmed.match(/^(.+?)\s+(\d+)\s*(袋|碗|个|根|瓶|杯|笼|份|盒|包|片|块|罐)$/);
  if (unitMatch) {
    return { name: unitMatch[1].trim(), grams: null };
  }

  // 5. 中置数字+单位在后: "牛肉寿司2贯" / "熏鹌鹑蛋12个"
  const midUnitMatch = trimmed.match(/^(.+?)(\d+)\s*(袋|碗|个|根|瓶|杯|笼|份|盒|包|片|块|罐|贯|串)$/);
  if (midUnitMatch) {
    return { name: midUnitMatch[1].trim(), grams: null };
  }

  // 6. 清理数字+单位残余 + 括号残余: "三元纯牛奶2袋" / "米饭()" / "宫爆鸡丁(约)"
  const cleanName = trimmed
    .replace(/\s*\d+\s*(袋|碗|个|根|瓶|杯|笼|份|盒|包|片|块|罐|贯|串|勺|ml|g|kg)/g, '')
    .replace(/\([^)]*\)/g, '')  // 去括号残余如 (约) (200g) (小)
    .replace(/\s*\d+(\.\d+)?\s*(ml|g|kg)\b/gi, '')
    .trim();
  if (cleanName && cleanName !== trimmed) {
    return { name: cleanName, grams: null };
  }

  // 7. 放行
  return { name: trimmed, grams: null };
}

/** 判断是否为炒菜/烧菜类（外卖默认一盒≈350g，非单份食材） */
function isCookedDish(name: string): boolean {
  return /炒|烧|焖|炖|爆|煎[^饼饺包]|炸|煸|焗|煲|卤|酱爆|红烧|干锅|水煮[肉鱼牛]|回锅|宫保|鱼香|麻辣|三杯|醋溜|糖醋|锅包|干煸/.test(name);
}

/** 匹配食物 → 返回每100g的热量估值 */
function matchFood(name: string): number | null {
  // 精确匹配
  if (FOOD_CALORIES[name] !== undefined) return FOOD_CALORIES[name];
  // 子串匹配（最长优先）
  const keys = Object.keys(FOOD_CALORIES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (name.includes(key)) return FOOD_CALORIES[key];
  }
  return null;
}

function matchMacro(name: string, macro: 'carbs' | 'protein' | 'fat' | 'sodium'): number | null {
  const map = macro === 'carbs' ? FOOD_CARBS : macro === 'protein' ? FOOD_PROTEIN : macro === 'fat' ? FOOD_FAT : FOOD_SODIUM;
  if (map[name] !== undefined) return map[name];
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (!name.includes(key)) continue;
    // 钠匹配需精确：key长度>=3 或 key就是食物名本身，避免"酸菜粉"误匹配"酸菜"2000mg
    if (macro === 'sodium' && key.length < 3 && name !== key) continue;
    return map[key];
  }
  return null;
}

/** 估算一个食物的完整营养信息 */
function estimateFood(text: string): { name: string; calories: number; carbs: number; protein: number; fat: number; sodium: number; grams: number | null } {
  const { name, grams } = parseFoodItem(text);
  const calPer100 = matchFood(name) || 150; // 未知食物默认150kcal/100g
  const carbsPer100 = matchMacro(name, 'carbs');
  const proteinPer100 = matchMacro(name, 'protein');
  const fatPer100 = matchMacro(name, 'fat');

  // 份量系数：炒菜无重量→350g，米饭无重量→250g，其他默认100g
  let effectiveGrams = grams;
  if (effectiveGrams == null) {
    if (isCookedDish(name)) {
      effectiveGrams = 350; // 外卖标准餐盒
    } else if (/米饭|白饭/.test(name)) {
      effectiveGrams = 250; // 默认一碗熟米饭
    } else {
      effectiveGrams = 100;
    }
  }
  const factor = effectiveGrams / 100;

  // 热量: 按份量估算
  let estimatedCals = Math.round(calPer100 * factor);

  const carbs = carbsPer100 != null ? round1(carbsPer100 * factor) : 0;
  const protein = proteinPer100 != null ? round1(proteinPer100 * factor) : 0;
  const fat = fatPer100 != null ? round1(fatPer100 * factor) : 0;
  const sodiumPer100 = matchMacro(name, 'sodium');
  const sodium = sodiumPer100 != null ? Math.round(sodiumPer100 * factor) : 0;

  // 无份量信息的食物用总量均分（后续按比例调整）
  return { name: name || text.trim(), calories: estimatedCals, carbs, protein, fat, sodium, grams };
}

/** 将 content 字符串拆分为独立食物列表 */
function splitContent(content: string): string[] {
  // 按中文逗号、顿号、英文逗号分割
  const items = content.split(/[，,、]/).map(s => s.trim()).filter(Boolean);
  return items;
}

/** 检查 meal 是否需要拆分 */
function needsSplit(meal: any): boolean {
  if (!meal.content) return false;
  return /[，,、]/.test(meal.content);
}

async function main() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  let fixedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const meals = (data.diet && data.diet.meals) || [];

    if (meals.length === 0) {
      skippedCount++;
      continue;
    }

    // 检查是否有需要拆分的 meal
    const hasMerged = meals.some((m: any) => needsSplit(m));
    if (!hasMerged) {
      skippedCount++;
      continue;
    }

    console.log(`\n🔧 修复 ${file} ...`);

    // 备份
    const backupPath = path.join(BACKUP_DIR, file);
    fs.writeFileSync(backupPath, JSON.stringify(data, null, 2), 'utf8');

    const newMeals: any[] = [];

    for (const meal of meals) {
      if (!needsSplit(meal)) {
        newMeals.push(meal);
        continue;
      }

      const items = splitContent(meal.content);
      const originalCal = meal.calories || 0;
      const originalCarbs = meal.carbs || 0;
      const originalProtein = meal.protein || 0;
      const originalFat = meal.fat || 0;

      console.log(`  拆分 ${meal.time}: "${meal.content}" (${originalCal}kcal) → ${items.length} 个食物`);

      // 为每个食物估算营养
      const estimates = items.map(item => {
        const est = estimateFood(item);
        console.log(`    - "${est.name}" ${est.grams ? est.grams + 'g' : '?'} 估算 ${est.calories}kcal C${est.carbs}g P${est.protein}g F${est.fat}g`);
        return est;
      });

      // 按比例调整使总热量匹配原始值
      if (originalCal > 0) {
        const estTotal = estimates.reduce((s, e) => s + e.calories, 0);
        if (estTotal > 0) {
          const ratio = originalCal / estTotal;
          // 始终用原始热量做比例校准（不跳过差异<5的情况）
          console.log(`    ↳ 比例调整: 估算总计 ${estTotal} → 原始 ${originalCal} (×${ratio.toFixed(2)})`);
          for (const est of estimates) {
            est.calories = Math.round(est.calories * ratio);
          }
          // 宏量营养素：统一按热量占比从原始总量分配（字典太稀疏，混合策略会丢失数据）
          const scaledTotal = estimates.reduce((s, e) => s + e.calories, 0);
          for (const est of estimates) {
            const calShare = scaledTotal > 0 ? est.calories / scaledTotal : 1 / estimates.length;
            est.carbs = originalCarbs > 0 ? round1(originalCarbs * calShare) : (est.carbs || 0);
            est.protein = originalProtein > 0 ? round1(originalProtein * calShare) : (est.protein || 0);
            est.fat = originalFat > 0 ? round1(originalFat * calShare) : (est.fat || 0);
            // 钠不随热量比例缩放（钠来自食材本身，非烹饪用油）
          }
        }
      }

      // 创建新的独立 meal 条目
      for (const est of estimates) {
        newMeals.push({
          time: meal.time,
          content: est.grams ? `${est.name} ${est.grams}g` : est.name,
          calories: est.calories,
          carbs: est.carbs,
          protein: est.protein,
          fat: est.fat,
          sodium: est.sodium,
        });
      }
    }

    // 更新数据
    const newDiet = {
      ...data.diet,
      meals: newMeals,
      totalCalories: Math.round(newMeals.reduce((s: number, m: any) => s + (m.calories || 0), 0)),
      totalCarbs: round1(newMeals.reduce((s: number, m: any) => s + (m.carbs || 0), 0)),
      totalProtein: round1(newMeals.reduce((s: number, m: any) => s + (m.protein || 0), 0)),
      totalFat: round1(newMeals.reduce((s: number, m: any) => s + (m.fat || 0), 0)),
      totalSodium: newMeals.reduce((s: number, m: any) => s + (m.sodium || 0), 0),
    };

    data.diet = newDiet;
    data.updatedAt = Date.now();

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`  ✅ 已保存: ${newMeals.length} 个独立食物条目`);
    fixedCount++;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━`);
  console.log(`完成！修复 ${fixedCount} 天，跳过 ${skippedCount} 天`);
  console.log(`备份保存在 ${BACKUP_DIR}`);
}

main().catch(console.error);
