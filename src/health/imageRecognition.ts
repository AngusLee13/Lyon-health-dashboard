import https from 'https';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { config } from '../config';
import { getDeepSeekClient } from '../claude/client';
import { generateHealthAnalysis } from './service';
import { SleepData, DietData, DietMeal, NutritionFacts } from './types';
import { addFood, findFood, loadFoodLibrary } from './foodLibrary';

/** 获取 tenant_access_token */
export async function getTenantAccessToken(appId?: string, appSecret?: string): Promise<string> {
  const body = JSON.stringify({
    app_id: appId || config.feishu.appId,
    app_secret: appSecret || config.feishu.appSecret,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (data.code === 0 && data.tenant_access_token) {
          resolve(data.tenant_access_token);
        } else {
          reject(new Error(`获取token失败: ${data.msg || 'unknown'}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 从飞书下载图片，返回 data URL */
async function downloadFeishuImage(messageId: string, imageKey: string): Promise<{ dataUrl: string; buffer: Buffer }> {
  const token = await getTenantAccessToken();

  let contentType = 'image/png';
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = https.get({
      hostname: 'open.feishu.cn',
      path: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
      headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      contentType = res.headers['content-type'] || 'image/png';
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
  });

  const buffer = Buffer.concat(chunks);
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${contentType};base64,${base64}`;
  return { dataUrl, buffer };
}

const VISION_PROMPT = `你是一个健康数据提取助手。请仔细分析以下从健康App截图中OCR提取的文字，将这些数据整理为 JSON 格式返回。

## ⚠️ 第一步：判断截图类型（必须执行！）

在提取数据之前，先根据 OCR 文字的关键词判断截图来源：
- **睡眠类**：含"睡眠""就寝""入睡""醒来""深睡""核心睡眠""REM""清醒次数""睡眠评分"等 → 只提取 sleep 数据
- **运动类**：含"训练""运动""锻炼""跑步""骑行""游泳""拳击""跳绳""HIIT""椭圆机""划船""爬楼""徒步""卡路里""动态千卡""心率""平均心率""有氧""力量""组""次""kg""哑铃""杠铃""器械"等 → 只提取 training 数据
- **饮食类**：含食物名称、热量、宏量营养素、"早餐""午餐""晚餐""加餐"等 → 只提取 diet 数据
- **混合仪表盘**：同时包含多种类型（如 Apple Health 首页）→ 可同时提取多种数据

**🔥 关键规则：单功能 App 截图（如训记、Keep、运动相机、单独的睡眠 App）只产生一种数据类型！** 不要把运动时长误判为睡眠时长，不要把消耗的卡路里数字误判为睡眠评分！

## 可提取的数据类型：

1. **睡眠数据** → sleep: { bedTime (HH:mm), wakeTime (HH:mm), duration (小时数), deepSleep (深睡小时数), lightSleep (浅睡小时数), coreSleep (核心睡眠小时数,Apple Watch用此名), remSleep (REM小时数), awakeTime (清醒小时数), awakeCount (清醒次数,整数), quality (poor/fair/good/excellent), sleepScore (0-100睡眠评分) }
   - ⚠️ 仅当截图明确来自睡眠追踪 App / Apple Health 睡眠页面时才提取
   - 所有睡眠阶段都必须提取。如"深睡 1h20min"→deepSleep=1.33。"核心睡眠"对应 lightSleep 字段
   - 清醒次数必须提取（如"清醒 2次"→awakeCount=2），清醒时长（如"清醒 15min"→awakeTime=0.25）
   - 🔥 sleepScore 只在睡眠上下文中提取（如"睡眠评分 71""睡眠 71分"），运动消耗的热量数字绝对不能当作睡眠评分！

2. **训练数据** → training: { bodyPart (训练部位), calories (消耗热量), duration (运动时长,分钟), avgHeartRate (平均心率), exercises: [{ name (动作名), sets (组数,力量训练), reps (次数,力量训练), weight (重量kg,力量训练), duration (时长,有氧运动如"45分钟") }] }
   - 🔥 **有氧运动/搏击类（拳击、HIIT、跳绳、跑步、骑行、游泳等）通常没有 sets/reps/weight**，exercises 数组中只需填 name 和 duration，bodyPart 填运动类型名称
   - 例如拳击训练：bodyPart="拳击", calories=xxx, exercises=[{name:"拳击", duration:"45分钟"}]（不要填 sets/reps/weight！）
   - 关键词识别：遇到"动态千卡""总千卡""平均心率""拳击""搏击""HIIT""有氧""跑步""游泳""骑行""跳绳""划船""椭圆机"等 → 判定为运动截图
   - 力量训练才有组数/次数/重量，有氧运动记录时长即可
   - 🔥 **热量取值规则（极其重要！）**：运动手表/健康App截图中通常同时显示"动态消耗"（纯运动消耗）和"总消耗"（动态+基础代谢）。**calories 字段只能取「动态消耗」的值！** 因为基础代谢已在每日 TDEE 中计算，取总消耗会导致重复计算。例如图中显示"动态消耗 376千卡""总消耗 700千卡"→ calories=376，绝对不能取 700！

3. **饮食数据** → diet: { meals: [{ time (breakfast/lunch/dinner/snack), content (食物名称), calories (热量kcal), carbs (碳水g), protein (蛋白质g), fat (脂肪g) }], totalCarbs, totalProtein, totalFat }

4. **体重数据** → weight: 数字(kg)

5. **补剂数据** → supplements: "补剂名称和用量"

## 通用规则：
- 时间格式 HH:mm（如 23:00），餐次用英文
- **重要：图中识别到的每一个食物都必须逐一列出，不能遗漏任何一个！** 每餐食物要估算热量和宏量营养素，参考：包子≈200kcal(C30 P8 F9), 鸡蛋≈70kcal(C0.5 P6 F5), 牛奶≈150kcal(C12 P8 F8), 米饭1碗≈175kcal(C38 P4 F0.5), 鸡胸肉150g≈200kcal(C0 P46 F4), 馒头≈220kcal(C44 P7 F1), 猪肉100g≈240kcal(C0 P22 F16), 面条1碗≈220kcal(C44 P8 F1)
- **carbs/protein/fat 字段必填**，每个食物都必须估算这三个值。同时在 diet 层级输出 totalCarbs/totalProtein/totalFat 汇总
- 只返回 JSON，不要其他任何文字
- 如果实在没有识别到任何健康数据，返回：{"rawText":"图中看到的文字内容"}`;

// ─── 营养成分表识别 ───

/** 营养成分表识别专用 Prompt */
const NUTRITION_LABEL_PROMPT = `你是一个食品营养成分表解析助手。从OCR提取的文字中识别食品包装上的营养成分表，整理为 JSON 格式。

需要提取的字段（每100g或每100ml的值）：
- foodName: 食品名称（品牌+产品名，如"蒙牛纯牛奶""奥利奥原味夹心饼干"）
- category: 分类（主食/肉类/零食/饮品/乳制品/蔬菜/水果/调味品/速食/其他）
- caloriesPer100g: 每100g热量(kcal)，如果标注为kJ则除以4.184换算
- proteinPer100g: 蛋白质(g)
- fatPer100g: 脂肪(g)
- carbsPer100g: 碳水化合物(g)
- sodiumPer100g: 钠(mg)
- servingSize: 每份克数（如有标注"每份XXg"）
- servingCalories: 每份热量（如有）

规则：
- **严格使用 OCR 文字中出现的数值**，不要自行计算或修改
- 能量单位：如果标注的是"能量 kJ"，除以 4.184 换算为 kcal，四舍五入到整数
- 如果只标注了每份的数值，反推算出每100g的值（每份值 / 每份克数 * 100）
- 优先提取完整品牌名（如"蒙牛纯牛奶"不要只写"纯牛奶"）
- 如果图中包含品牌名/产品名，务必完整提取
- 只返回 JSON，不要其他任何文字

示例输出：
{"foodName":"蒙牛纯牛奶","category":"乳制品","caloriesPer100g":65,"proteinPer100g":3.2,"fatPer100g":3.8,"carbsPer100g":5.0,"sodiumPer100g":50,"servingSize":250,"servingCalories":163}`;

/** 检测 OCR 文字是否来自食品营养成分表 */
function isNutritionLabelImage(ocrText: string): boolean {
  // 精确特征模式（清晰 OCR）
  const strongPatterns = [
    /营养成分表/,
    /营养成份表/,
    /Nutrition Facts/i,
    /每\s*100\s*(克|g|毫升|ml)/i,
    /项目.*每.*100/,
    /能量.*蛋白质.*脂肪.*碳水/,
    /Energy.*Protein.*Fat.*Carb/i,
    /NRV\s*%/,
  ];

  // 弱特征模式：OCR 乱码时仍可能命中的单个营养关键词
  const weakPatterns = [
    /蛋白[质贡]/,
    /脂肪[的肋]/,
    /碳水[化合]/,
    /钠[含]/,
    /能[量国]/,
    /膳食[纤]/,
    /反式[脂]/,
    /饱和[脂]/,
    /胆[固甾]/,
    /[Nn][Rr][Vv]/,
    /[Kk][Jj]/,
    /[Kk]cal/,
    /每.*份/,
    /[克gG]\s*[\/／]\s*100/,
    /[0-9]{2,}\s*%/,
  ];

  const strongCount = strongPatterns.filter(p => p.test(ocrText)).length;
  const weakCount = weakPatterns.filter(p => p.test(ocrText)).length;

  // 命中 ≥1 个强特征，或 ≥3 个弱特征
  const matched = strongCount >= 1 || weakCount >= 3;
  if (matched) {
    console.log(`[营养成分检测] 命中: 强特征=${strongCount}, 弱特征=${weakCount}, 判定为营养成分表`);
  }
  return matched;
}

/** 营养成分表识别结果 */
export interface NutritionLabelResult {
  success: boolean;
  /** 已存入食物库的食物信息 */
  food?: NutritionFacts;
  /** 确认消息 */
  message: string;
  error?: string;
}

/** 从 OCR 文字中提取营养成分表数据并存入食物库 */
export async function recognizeNutritionLabel(
  ocrText: string,
): Promise<NutritionLabelResult> {
  console.log(`[营养成分识别] 开始解析营养成分表...`);

  const client = getDeepSeekClient();
  let content: string;
  try {
    const response = await client.chat.completions.create({
      model: config.deepseek.model,
      messages: [
        { role: 'user', content: `${NUTRITION_LABEL_PROMPT}\n\nOCR提取的文字：\n${ocrText.substring(0, 3000)}` },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    });
    content = response.choices[0]?.message?.content || '';
  } catch (err: any) {
    return { success: false, message: '', error: `AI 解析失败: ${err.message}` };
  }

  console.log(`[营养成分识别] AI 返回: ${content.substring(0, 500)}`);

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
    return { success: false, message: '', error: 'AI 未返回有效的营养成分 JSON' };
  }

  let facts: NutritionFacts;
  try {
    facts = JSON.parse(jsonStr);
  } catch {
    return { success: false, message: '', error: 'AI 返回的 JSON 格式异常' };
  }

  // 验证必填字段
  if (!facts.foodName) {
    return { success: false, message: '', error: '未能识别食品名称' };
  }
  if (!facts.caloriesPer100g && !facts.servingCalories) {
    return { success: false, message: '', error: '未能识别热量数据' };
  }

  // 如果没有 per100g 但有 serving 数据，反推 per100g
  if (!facts.caloriesPer100g && facts.servingCalories && facts.servingSize) {
    facts.caloriesPer100g = Math.round(facts.servingCalories / facts.servingSize * 100);
  }
  if (facts.caloriesPer100g && !facts.proteinPer100g) facts.proteinPer100g = 0;
  if (facts.caloriesPer100g && !facts.fatPer100g) facts.fatPer100g = 0;
  if (facts.caloriesPer100g && !facts.carbsPer100g) facts.carbsPer100g = 0;

  // 存入食物库
  const existing = findFood(facts.foodName);
  const foodItem = addFood({
    name: facts.foodName,
    category: facts.category || '其他',
    caloriesPer100g: facts.caloriesPer100g,
    carbsPer100g: facts.carbsPer100g || 0,
    proteinPer100g: facts.proteinPer100g || 0,
    fatPer100g: facts.fatPer100g || 0,
    sodiumPer100g: facts.sodiumPer100g,
    servingSize: facts.servingSize,
    servingCalories: facts.servingCalories,
    source: 'nutrition_label',
    createdAt: Date.now(),
  });

  const action = existing ? '已更新' : '已录入';
  const servingInfo = foodItem.servingSize
    ? `，每份 ${foodItem.servingSize}g/${foodItem.servingCalories}kcal`
    : '';
  const message = `✅ ${action}食物库：**${foodItem.name}**
📊 每100g：${foodItem.caloriesPer100g}kcal | 碳${foodItem.carbsPer100g}g | 蛋${foodItem.proteinPer100g}g | 脂${foodItem.fatPer100g}g${foodItem.sodiumPer100g ? ' | 钠' + foodItem.sodiumPer100g + 'mg' : ''}${servingInfo}
🔖 来源：营养成分表`;

  console.log(`[营养成分识别] ${message.replace(/\*\*/g, '').replace(/\n/g, ' ')}`);
  return { success: true, food: facts, message };
}

export interface ImageRecognitionResult {
  success: boolean;
  data?: {
    sleep?: Partial<SleepData>;
    diet?: { meals: DietMeal[]; adherence?: string };
    training?: { bodyPart: string; exercises: { name: string; sets: number; reps: number; weight: number }[]; calories: number };
    weight?: number;
    supplements?: string;
  };
  /** 营养成分表识别结果（独立于健康数据） */
  nutritionLabel?: NutritionLabelResult;
  rawText?: string;
  error?: string;
}

/** 图像预处理：放大 + 灰度 + 对比度增强 → 提升 OCR 识别率 */
async function preprocessImage(buffer: Buffer, upscale = 3): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  const width = (metadata.width || 400) * upscale;
  const height = (metadata.height || 800) * upscale;

  return sharp(buffer)
    .resize(width, height, { kernel: 'lanczos3' })  // 高质量放大
    .grayscale()                                      // 转灰度
    .normalize()                                      // 拉伸对比度
    .sharpen({ sigma: 0.8, m1: 0.3, m2: 0.3 })      // 轻微锐化
    .toBuffer();
}

/** 图像预处理（包装专用）：放大 + 自适应阈值二值化 → 适合印刷体营养成分表 */
async function preprocessForLabel(buffer: Buffer, upscale = 3): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  const width = (metadata.width || 400) * upscale;
  const height = (metadata.height || 800) * upscale;

  return sharp(buffer)
    .resize(width, height, { kernel: 'lanczos3' })
    .grayscale()
    .normalize()
    .linear(1.3, -(128 * 0.3))  // 提升对比度：高对比让印刷文字更清晰
    .sharpen({ sigma: 1.2, m1: 0.5, m2: 0.5 })      // 更强锐化
    .toBuffer();
}

/** 判断 OCR 输出质量：有效中英文字符占比过低视为乱码 */
function ocrQualityScore(text: string): number {
  if (!text || text.length < 10) return 0;
  // 统计有效字符：中文、英文、数字、常见标点
  const valid = (text.match(/[一-鿿\w\d\s:.\-→/%%,，、()（）[\]【】]+/g) || []).join('');
  return valid.length / text.length;
}

/** 执行 OCR，支持多 PSM 模式回退 */
async function ocrWithRetry(buffer: Buffer, lang: string): Promise<string> {
  const psms = [Tesseract.PSM.SINGLE_BLOCK, Tesseract.PSM.AUTO];
  let bestText = "";
  let bestScore = 0;

  for (const psm of psms) {
    try {
      const worker = await Tesseract.createWorker(lang, undefined, { logger: () => {} });
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const result = await worker.recognize(buffer);
      const text = result.data.text?.trim() || "";
      await worker.terminate();
      const score = ocrQualityScore(text);

      console.log("[OCR] PSM=" + psm + " len=" + text.length + " quality=" + (score * 100).toFixed(0) + "%");

      if (score > bestScore) {
        bestScore = score;
        bestText = text;
      }
      if (score > 0.4) break;
    } catch (err: any) {
      console.warn("[OCR] PSM=" + psm + " failed: " + err.message);
    }
  }
  return bestText;
}

/** 执行 OCR（营养标签专用）：优先使用稀疏文本模式，更适合表格类排版 */
async function ocrForLabel(buffer: Buffer, lang: string): Promise<string> {
  // PSM 11 (SPARSE_TEXT): 适合营养成分表这种稀疏排版的表格文字
  // PSM 4 (SINGLE_COLUMN): 适合文字按列排列
  // PSM 3 (AUTO): 全自动
  const psms = [Tesseract.PSM.SPARSE_TEXT, Tesseract.PSM.SINGLE_COLUMN, Tesseract.PSM.AUTO];
  let bestText = "";
  let bestScore = 0;

  for (const psm of psms) {
    try {
      const worker = await Tesseract.createWorker(lang, undefined, { logger: () => {} });
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const result = await worker.recognize(buffer);
      const text = result.data.text?.trim() || "";
      await worker.terminate();
      const score = ocrQualityScore(text);

      console.log("[OCR-Label] PSM=" + psm + " len=" + text.length + " quality=" + (score * 100).toFixed(0) + "%");

      if (score > bestScore) {
        bestScore = score;
        bestText = text;
      }
      if (score > 0.5) break;
    } catch (err: any) {
      console.warn("[OCR-Label] PSM=" + psm + " failed: " + err.message);
    }
  }
  return bestText;
}

/** 睡眠相关关键词：OCR 文字中至少命中 1 个才认可 AI 提取的睡眠数据 */
const SLEEP_KEYWORDS = [
  '睡眠', '就寝', '入睡', '醒来', '起床', '深睡', '浅睡',
  '核心睡眠', 'REM', '清醒次数', '清醒', '卧床', '夜间',
  'sleep', 'bedtime', 'wake', 'deep sleep', 'light sleep',
];

/** 运动相关关键词：用于交叉校验 */
const EXERCISE_KEYWORDS = [
  '训练', '运动', '锻炼', '跑步', '骑行', '游泳', '拳击', '跳绳',
  'HIIT', '椭圆机', '划船', '爬楼', '徒步', '卡路里', '动态千卡',
  '动态消耗', '总消耗', '心率', '平均心率', '有氧', '力量',
  '组', '次', 'kg', '哑铃', '杠铃', '器械', '搏击', '健身',
];

/** 校验 AI 提取的数据与 OCR 原文是否一致，剔除 AI 幻觉数据 */
function validateExtractedData(extracted: any, ocrText: string): { discarded: string[]; warnings: string[] } {
  const discarded: string[] = [];
  const warnings: string[] = [];
  const ocrLower = ocrText.toLowerCase();

  // 校验睡眠数据：只有 OCR 明确是运动截图（有运动关键词 + 无睡眠关键词）时才丢弃
  // 如果两者都没有（OCR 质量差），保留数据，避免误杀睡眠截图
  if (extracted.sleep) {
    const hasSleepKeyword = SLEEP_KEYWORDS.some(kw => ocrText.includes(kw) || ocrLower.includes(kw.toLowerCase()));
    const hasExerciseKeyword = EXERCISE_KEYWORDS.some(kw => ocrText.includes(kw) || ocrLower.includes(kw.toLowerCase()));

    if (!hasSleepKeyword && hasExerciseKeyword) {
      // OCR 明确是运动类截图，AI 幻觉出睡眠数据 → 丢弃
      console.log(`[数据校验] ⚠️ OCR 明确为运动截图(无睡眠关键词)，丢弃 AI 幻觉的睡眠数据: ${JSON.stringify(extracted.sleep).substring(0, 120)}`);
      delete extracted.sleep;
      discarded.push('睡眠(AI幻觉)');
    } else if (!hasSleepKeyword && !hasExerciseKeyword) {
      // OCR 质量差，两者都没有 → 保留但警告，可能是睡眠关键词被 OCR 误识别
      console.log(`[数据校验] ⚠️ OCR 中未找到睡眠/运动关键词，保留睡眠数据（可能 OCR 质量不足）`);
      warnings.push('OCR质量可能不足，睡眠数据未校验');
    }
    // hasSleepKeyword → 正常通过，不输出日志
  }

  // 校验训练数据：OCR 有运动关键词但 AI 没提取 → 警告
  if (!extracted.training) {
    const hasExerciseKeyword = EXERCISE_KEYWORDS.some(kw => ocrText.includes(kw) || ocrLower.includes(kw.toLowerCase()));
    if (hasExerciseKeyword) {
      console.log(`[数据校验] ⚠️ OCR 含运动关键词但 AI 未提取 training，可能漏检`);
      warnings.push('OCR含运动关键词但未提取训练数据');
    }
  }

  return { discarded, warnings };
}

export async function recognizeHealthImage(messageId: string, imageKey: string): Promise<ImageRecognitionResult> {
  // 步骤1：下载图片
  let dataUrl: string;
  let imageBuffer: Buffer;
  try {
    const result = await downloadFeishuImage(messageId, imageKey);
    dataUrl = result.dataUrl;
    imageBuffer = result.buffer;
    console.log(`[图片识别] 图片下载完成, 大小: ${imageBuffer.length} bytes`);
  } catch (err: any) {
    return { success: false, error: `图片下载失败: ${err.message}` };
  }

  // 步骤2：OCR 提取文字（预处理放大 + 多 PSM 回退）
  let ocrText: string;
  try {
    console.log(`[图片识别] 开始图像预处理...`);
    const processed = await preprocessImage(imageBuffer, 3);
    console.log(`[图片识别] 预处理完成, 开始 OCR...`);
    ocrText = await ocrWithRetry(processed, 'chi_sim+eng');
    console.log(`[图片识别] OCR 完成, 文字长度: ${ocrText.length}`);
    console.log(`[OCR 原始文字] ${ocrText.substring(0, 500)}`);
  } catch (err: any) {
    return { success: false, error: `OCR 识别失败: ${err.message}` };
  }

  if (!ocrText) {
    return { success: false, error: '图片中未识别到文字，请确认图片清晰度' };
  }

  // 步骤2.5：检测是否为食品营养成分表
  // 如果第一次 OCR 未能检出营养成分表，尝试包装专用预处理再 OCR 一次
  let ocrForNutrition = ocrText;
  if (!isNutritionLabelImage(ocrText)) {
    console.log(`[图片识别] 常规 OCR 未检出营养成分表，尝试包装专用预处理...`);
    try {
      const labelProcessed = await preprocessForLabel(imageBuffer, 3);
      const labelOcrText = await ocrForLabel(labelProcessed, 'chi_sim+eng');
      console.log(`[图片识别] 包装专用 OCR 完成, 文字长度: ${labelOcrText.length}`);
      console.log(`[包装OCR 原始文字] ${labelOcrText.substring(0, 500)}`);
      if (isNutritionLabelImage(labelOcrText)) {
        console.log(`[图片识别] ✅ 包装专用 OCR 检出营养成分表，使用二次 OCR 结果`);
        ocrForNutrition = labelOcrText;
      } else {
        console.log(`[图片识别] 包装专用 OCR 仍未检出营养成分表`);
        // 保留二次 OCR 结果如果它更长（说明提取到了更多信息）
        if (labelOcrText.length > ocrText.length * 1.2) {
          ocrForNutrition = labelOcrText;
        }
      }
    } catch (err: any) {
      console.log(`[图片识别] 包装专用 OCR 失败: ${err.message}，继续使用常规OCR`);
    }
  }

  if (isNutritionLabelImage(ocrForNutrition)) {
    console.log(`[图片识别] 检测到营养成分表，切换到营养标签识别模式`);
    const nutritionResult = await recognizeNutritionLabel(ocrForNutrition);
    if (nutritionResult.success) {
      return {
        success: true,
        nutritionLabel: nutritionResult,
        rawText: ocrForNutrition,
      };
    }
    // 营养成分识别失败，继续尝试健康数据提取（可能是混合内容）
    console.log(`[图片识别] 营养成分识别失败: ${nutritionResult.error}，继续尝试健康数据提取`);
  }

  // 步骤3：将 OCR 文字发给 DeepSeek 做结构化提取
  try {
    console.log(`[图片识别] 发送 OCR 文字到 DeepSeek...`);

    const client = getDeepSeekClient();
    const response = await client.chat.completions.create({
      model: config.deepseek.model,
      messages: [
        {
          role: 'user',
          content: `${VISION_PROMPT}\n\nOCR提取的文字：\n${ocrText}`,
        },
      ],
      max_tokens: 4000,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content || '';
    console.log(`[图片识别] DeepSeek 返回: ${content.substring(0, 500)}`);

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
      console.log('[图片识别] 未在响应中找到 JSON');
      return { success: false, error: 'AI 未返回有效数据', rawText: content };
    }

    let extracted: any;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (parseErr: any) {
      console.error(`[图片识别] JSON 解析失败: ${parseErr.message}`);
      return { success: false, error: 'AI 返回的 JSON 格式异常', rawText: content };
    }

    console.log(`[图片识别] JSON 字段: ${Object.keys(extracted).join(', ') || '(无)'}`);

    if (extracted.error) {
      return { success: false, error: extracted.error, rawText: extracted.rawText };
    }

    const hasData = extracted.sleep || extracted.diet || extracted.training || extracted.weight || extracted.supplements;
    if (!hasData) {
      return {
        success: false,
        error: extracted.rawText
          ? `未识别到健康数据。图中文字：${extracted.rawText.substring(0, 200)}`
          : `未识别到健康数据。OCR 文字：${ocrText.substring(0, 200)}`,
        rawText: extracted.rawText || ocrText,
      };
    }

    console.log(`[图片识别] 提取结果:`, JSON.stringify(extracted).substring(0, 500));

    // 🔒 硬校验：OCR 文字中无睡眠关键词则丢弃 AI 幻觉的睡眠数据
    const validation = validateExtractedData(extracted, ocrText);
    if (validation.discarded.length > 0) {
      console.log(`[图片识别] 已丢弃 AI 幻觉数据: ${validation.discarded.join(', ')}`);
      // 丢弃睡眠后重新检查是否还有有效数据
      const stillHasData = extracted.sleep || extracted.diet || extracted.training || extracted.weight || extracted.supplements;
      if (!stillHasData) {
        return {
          success: false,
          error: `AI 幻觉数据已过滤。图中文字：${ocrText.substring(0, 200)}`,
          rawText: ocrText,
        };
      }
    }

    return {
      success: true,
      data: {
        sleep: extracted.sleep,
        diet: extracted.diet,
        training: extracted.training,
        weight: extracted.weight,
        supplements: extracted.supplements,
      },
      rawText: extracted.rawText || ocrText,
    };
  } catch (err: any) {
    console.error(`[图片识别] AI 解析异常:`, err.message);
    return { success: false, error: `AI 解析失败: ${err.message}` };
  }
}

/** 通用图片分析：接收 Buffer 进行 OCR + AI 结构化提取（不依赖飞书） */
export async function analyzeImageBuffer(imageBuffer: Buffer): Promise<ImageRecognitionResult> {
  console.log(`[图片分析] 图片大小: ${imageBuffer.length} bytes`);

  // OCR 提取文字（预处理放大 + 多 PSM 回退）
  let ocrText: string;
  try {
    console.log(`[图片分析] 开始图像预处理...`);
    const processed = await preprocessImage(imageBuffer, 3);
    console.log(`[图片分析] 预处理完成, 开始 OCR...`);
    ocrText = await ocrWithRetry(processed, 'chi_sim+eng');
    console.log(`[图片分析] OCR 完成, 文字长度: ${ocrText.length}`);
    console.log(`[OCR 原始文字] ${ocrText.substring(0, 500)}`);
  } catch (err: any) {
    return { success: false, error: `OCR 识别失败: ${err.message}` };
  }

  if (!ocrText) {
    return { success: false, error: '图片中未识别到文字，请确认图片清晰度' };
  }

  // DeepSeek 结构化提取
  try {
    console.log(`[图片分析] 发送 OCR 文字到 DeepSeek...`);
    const client = getDeepSeekClient();
    const response = await client.chat.completions.create({
      model: config.deepseek.model,
      messages: [{ role: 'user', content: `${VISION_PROMPT}\n\nOCR提取的文字：\n${ocrText}` }],
      max_tokens: 4000,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content || '';
    console.log(`[图片分析] DeepSeek 返回: ${content.substring(0, 500)}`);

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
      return { success: false, error: 'AI 未返回有效数据', rawText: content };
    }

    let extracted: any;
    try { extracted = JSON.parse(jsonStr); } catch (parseErr: any) {
      return { success: false, error: 'AI 返回的 JSON 格式异常', rawText: content };
    }

    if (extracted.error) {
      return { success: false, error: extracted.error, rawText: extracted.rawText };
    }

    const hasData = extracted.sleep || extracted.diet || extracted.training || extracted.weight || extracted.supplements;
    if (!hasData) {
      return { success: false, error: '未识别到健康数据', rawText: extracted.rawText || ocrText };
    }

    console.log(`[图片分析] 提取结果:`, JSON.stringify(extracted).substring(0, 500));

    // 🔒 硬校验：OCR 文字中无睡眠关键词则丢弃 AI 幻觉的睡眠数据
    const validation = validateExtractedData(extracted, ocrText);
    if (validation.discarded.length > 0) {
      console.log(`[图片分析] 已丢弃 AI 幻觉数据: ${validation.discarded.join(', ')}`);
      const stillHasData = extracted.sleep || extracted.diet || extracted.training || extracted.weight || extracted.supplements;
      if (!stillHasData) {
        return { success: false, error: 'AI 幻觉数据已过滤', rawText: ocrText };
      }
    }

    return {
      success: true,
      data: {
        sleep: extracted.sleep,
        diet: extracted.diet,
        training: extracted.training,
        weight: extracted.weight,
        supplements: extracted.supplements,
      },
      rawText: extracted.rawText || ocrText,
    };
  } catch (err: any) {
    return { success: false, error: `AI 解析失败: ${err.message}` };
  }
}

/** 将识别结果保存到当日健康记录 */
export async function saveRecognizedData(
  date: string,
  result: ImageRecognitionResult,
): Promise<string> {
  if (!result.success || !result.data) {
    return `未保存：${result.error || '无有效数据'}`;
  }

  const { sleep, diet, training, weight, supplements } = result.data;
  const savedItems: string[] = [];

  await generateHealthAnalysis(date, config, {
    sleep: sleep as SleepData,
    diet: diet as DietData,
    training: training as any,
    weight,
    supplements: supplements || undefined,
  });

  if (sleep) savedItems.push('睡眠');
  if (diet) savedItems.push('饮食');
  if (training) savedItems.push('训练');
  if (weight) savedItems.push(`体重(${weight}kg)`);
  if (supplements) savedItems.push('补剂');

  if (savedItems.length === 0) {
    return `未保存：图片中未识别到可保存的健康数据`;
  }

  return `已保存 ${savedItems.join('、')} 到 ${date}`;
}
