import fs from 'fs';
import path from 'path';
import { FoodItem, NutritionFacts } from './types';

const DATA_DIR = path.resolve(__dirname, '../../.data/health');
const FOODS_FILE = path.join(DATA_DIR, 'foods.json');
const BACKUP_DIR = path.join(DATA_DIR, '.backup');

// 内存缓存
let cachedFoods: FoodItem[] | null = null;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/** 从磁盘加载食物库 */
export function loadFoodLibrary(): FoodItem[] {
  if (cachedFoods !== null) return cachedFoods;

  ensureDir();
  if (!fs.existsSync(FOODS_FILE)) {
    cachedFoods = [];
    return cachedFoods;
  }

  try {
    const raw = fs.readFileSync(FOODS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    cachedFoods = (data.foods || []) as FoodItem[];
  } catch (err: any) {
    console.warn(`[食物库] 读取 foods.json 失败: ${err.message}，返回空列表`);
    cachedFoods = [];
  }
  return cachedFoods;
}

/** 保存食物库到磁盘（写入前备份旧文件，保留最近 10 个版本） */
export function saveFoodLibrary(foods: FoodItem[]): void {
  ensureDir();

  // 写入前备份旧文件
  if (fs.existsSync(FOODS_FILE)) {
    ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `foods__${ts}.json`;
    fs.copyFileSync(FOODS_FILE, path.join(BACKUP_DIR, backupName));

    // 清理旧备份，只保留最近 10 个
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('foods__'))
      .sort()
      .reverse();
    for (const old of backups.slice(10)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
  }

  fs.writeFileSync(FOODS_FILE, JSON.stringify({ foods }, null, 2), 'utf-8');
  // 刷新内存缓存
  cachedFoods = foods;
}

/** 手动刷新缓存（下次读取会重新从磁盘加载） */
export function invalidateCache(): void {
  cachedFoods = null;
}

/** 添加或更新食物（按名称 upsert） */
export function addFood(item: Omit<FoodItem, 'createdAt'> & { createdAt?: number }): FoodItem {
  const foods = loadFoodLibrary();
  const now = Date.now();
  const existingIdx = foods.findIndex(f => f.name === item.name);

  if (existingIdx >= 0) {
    // 更新已有食物
    foods[existingIdx] = {
      ...foods[existingIdx],
      ...item,
      updatedAt: now,
    };
    saveFoodLibrary(foods);
    return foods[existingIdx];
  } else {
    // 新增
    const newFood: FoodItem = {
      ...item,
      createdAt: item.createdAt || now,
    };
    foods.push(newFood);
    saveFoodLibrary(foods);
    return newFood;
  }
}

/** 按名称删除食物 */
export function deleteFood(name: string): boolean {
  const foods = loadFoodLibrary();
  const idx = foods.findIndex(f => f.name === name);
  if (idx < 0) return false;
  foods.splice(idx, 1);
  saveFoodLibrary(foods);
  return true;
}

/** 列出食物库，支持按分类筛选 */
export function listFoods(category?: string): FoodItem[] {
  const foods = loadFoodLibrary();
  if (!category) return [...foods];
  return foods.filter(f => f.category === category);
}

/** 按名称查找食物：先精确匹配，再子串匹配 */
export function findFood(query: string): FoodItem | null {
  const foods = loadFoodLibrary();
  if (foods.length === 0) return null;

  const q = query.trim();
  // 精确匹配
  const exact = foods.find(f => f.name === q);
  if (exact) return exact;

  // 子串匹配（query 包含在食物名中，或食物名包含在 query 中）
  let best: FoodItem | null = null;
  let bestLen = 0;
  for (const f of foods) {
    if (q.includes(f.name) || f.name.includes(q)) {
      if (f.name.length > bestLen) {
        best = f;
        bestLen = f.name.length;
      }
    }
  }
  return best;
}

/** 从食物名称匹配动态库，返回完整宏量营养素数据 */
export function matchCalorieFromLibrary(foodName: string): {
  caloriesPer100g: number;
  carbsPer100g: number;
  proteinPer100g: number;
  fatPer100g: number;
  sodiumPer100g: number | null;
  source: string;
  /** 模糊匹配时附带的参考食物名 */
  referenceName?: string;
} | null {
  const food = findFood(foodName);
  if (food) {
    return {
      caloriesPer100g: food.caloriesPer100g,
      carbsPer100g: food.carbsPer100g,
      proteinPer100g: food.proteinPer100g,
      fatPer100g: food.fatPer100g,
      sodiumPer100g: food.sodiumPer100g ?? null,
      source: food.source,
    };
  }

  // 模糊匹配：按关键词相似度查找最接近的食物作为参考
  const similar = findSimilarFood(foodName);
  if (similar) {
    console.log(`[食物库] 模糊匹配: "${foodName}" → "${similar.name}" (相似度参考)`);
    return {
      caloriesPer100g: similar.caloriesPer100g,
      carbsPer100g: similar.carbsPer100g,
      proteinPer100g: similar.proteinPer100g,
      fatPer100g: similar.fatPer100g,
      sodiumPer100g: similar.sodiumPer100g ?? null,
      source: 'library_similar',
      referenceName: similar.name,
    };
  }

  return null;
}

/** 模糊匹配：在食物库中查找与 query 最相似的食物（按关键词重叠度） */
function findSimilarFood(query: string): FoodItem | null {
  const foods = loadFoodLibrary();
  if (foods.length === 0) return null;

  const q = query.trim().toLowerCase();
  // 提取查询中的关键词（去除常见量词和标点）
  const qWords = q
    .replace(/[0-9]+(\.)?[0-9]*/g, '')  // 去数字
    .replace(/[g克毫升ml升l份包袋盒瓶罐杯勺]/gi, '')  // 去量词
    .replace(/[，,、。．\s/()（）\-—]+/g, ' ')  // 去标点
    .split(' ')
    .filter(w => w.length >= 2);  // 至少2个字符的关键词

  if (qWords.length === 0) return null;

  let bestScore = 0;
  let bestFood: FoodItem | null = null;

  for (const food of foods) {
    const fName = food.name.toLowerCase();
    let score = 0;
    for (const word of qWords) {
      if (fName.includes(word)) score += word.length;  // 匹配到的字符数作为分数
    }
    // 如果查询完全包含食物名的一部分，额外加分
    if (q.includes(fName)) score += 10;
    if (fName.includes(q)) score += 15;

    if (score > bestScore && score >= 3) {  // 至少匹配3个字符才算
      bestScore = score;
      bestFood = food;
    }
  }

  return bestFood;
}

/** 从营养成分表识别结果导入食物库 */
export function importFromNutritionFacts(facts: NutritionFacts): FoodItem {
  return addFood({
    name: facts.foodName,
    category: facts.category || '其他',
    caloriesPer100g: facts.caloriesPer100g,
    carbsPer100g: facts.carbsPer100g,
    proteinPer100g: facts.proteinPer100g,
    fatPer100g: facts.fatPer100g,
    sodiumPer100g: facts.sodiumPer100g,
    servingSize: facts.servingSize,
    servingCalories: facts.servingCalories,
    source: 'nutrition_label',
  });
}

// ─── 品牌包装食物查询（基于 AI 知识库） ───

/** 品牌食物查询结果 */
export interface PackagedFoodResult {
  success: boolean;
  food?: FoodItem;
  message: string;
  error?: string;
  /** AI 返回的原始参考信息 */
  rawNote?: string;
}

const PACKAGED_FOOD_PROMPT = `你是食品营养数据库助手。用户给你一个市售包装食品的"品牌+商品名"，你返回该产品标准营养成分表数据（每100g或每100ml）。

请返回严格 JSON 格式：
{
  "foodName": "品牌 商品名（如：伊利 纯牛奶）",
  "category": "分类（乳制品/零食/饮品/速食/调味品/主食/肉类/蔬菜/水果/其他）",
  "caloriesPer100g": 数字(kcal),
  "carbsPer100g": 数字(g),
  "proteinPer100g": 数字(g),
  "fatPer100g": 数字(g),
  "sodiumPer100g": 数字(mg, 如不确定可填null),
  "servingSize": 数字(每份克数或毫升数, 如不确定填null),
  "servingCalories": 数字(每份热量, 如不确定填null),
  "note": "简短注明数据来源（如：产品标准营养成分表 / 同类产品估算）"
}

规则：
1. 优先使用该产品官方营养成分表数据
2. 如果找不到该具体产品，使用同类产品估算并在 note 说明
3. 热量计算：蛋白4kcal/g + 碳水4kcal/g + 脂肪9kcal/g，总和应与 caloriesPer100g 大致吻合
4. 「每份」指包装上标注的一份量（如 250ml/25g/45g）
5. 只返回 JSON，不要其他文字`;

/**
 * 通过 AI 知识库查询市售品牌包装食品的营养成分
 * 查询结果自动存入本地食物库，下次相同食物直接本地匹配
 */
export async function lookupPackagedFood(query: string): Promise<PackagedFoodResult> {
  // 先查本地库
  const local = findFood(query);
  if (local) {
    return {
      success: true,
      food: local,
      message: `📦 食物库已有记录：**${local.name}**\n📊 每100g：${local.caloriesPer100g}kcal | 碳${local.carbsPer100g}g | 蛋${local.proteinPer100g}g | 脂${local.fatPer100g}g${local.sodiumPer100g ? ' | 钠' + local.sodiumPer100g + 'mg' : ''}\n🔖 来源：${local.source === 'nutrition_label' ? '营养成分表' : local.source === 'ai_lookup' ? 'AI知识库' : '手动录入'}`,
    };
  }

  // 调用 DeepSeek 查询
  try {
    const { getDeepSeekClient } = await import('../claude/client');
    const { config } = await import('../config');
    const client = getDeepSeekClient();

    console.log(`[食物查询] AI 查询: "${query}"`);
    const response = await client.chat.completions.create({
      model: config.deepseek.model,
      messages: [
        { role: 'user', content: `${PACKAGED_FOOD_PROMPT}\n\n查询食物：${query}` },
      ],
      max_tokens: 1000,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content || '';
    console.log(`[食物查询] AI 返回: ${content.substring(0, 300)}`);

    // 提取 JSON
    let jsonStr: string | null = null;
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      const inner = codeBlockMatch[1].trim();
      const innerJson = inner.match(/\{[\s\S]*\}/);
      if (innerJson) jsonStr = innerJson[0];
    }
    if (!jsonStr) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }

    if (!jsonStr) {
      return { success: false, error: 'AI 未返回有效数据', message: '' };
    }

    const data = JSON.parse(jsonStr);
    if (!data.foodName || !data.caloriesPer100g) {
      return { success: false, error: 'AI 返回数据不完整（缺少食品名或热量）', message: '' };
    }

    // 存入食物库
    const foodItem = addFood({
      name: data.foodName,
      category: data.category || '其他',
      caloriesPer100g: data.caloriesPer100g,
      carbsPer100g: data.carbsPer100g || 0,
      proteinPer100g: data.proteinPer100g || 0,
      fatPer100g: data.fatPer100g || 0,
      sodiumPer100g: data.sodiumPer100g ?? undefined,
      servingSize: data.servingSize ?? undefined,
      servingCalories: data.servingCalories ?? undefined,
      source: 'ai_lookup',
      createdAt: Date.now(),
    });

    const servingInfo = foodItem.servingSize
      ? `，每份 ${foodItem.servingSize}g/${foodItem.servingCalories}kcal`
      : '';
    const message = `✅ 已录入食物库：**${foodItem.name}**
📊 每100g：${foodItem.caloriesPer100g}kcal | 碳${foodItem.carbsPer100g}g | 蛋${foodItem.proteinPer100g}g | 脂${foodItem.fatPer100g}g${foodItem.sodiumPer100g ? ' | 钠' + foodItem.sodiumPer100g + 'mg' : ''}${servingInfo}
🔖 来源：AI 知识库${data.note ? '（' + data.note + '）' : ''}
💡 下次输入相同食物将直接匹配，无需再次查询`;

    console.log(`[食物查询] ✅ ${message.replace(/\*\*/g, '').replace(/\n/g, ' ')}`);
    return { success: true, food: foodItem, message, rawNote: data.note };
  } catch (err: any) {
    console.error(`[食物查询] AI 查询失败: ${err.message}`);
    return { success: false, error: `查询失败: ${err.message}`, message: '' };
  }
}
