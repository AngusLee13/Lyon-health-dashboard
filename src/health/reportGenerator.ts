import { fetchHealthData } from './service';
import { getDailyRecord, getDailyRecords } from './store';
import { calcCalorieSummary, estimateStepCalories } from './calorie';
import { config } from '../config';
import { DailyRecord, TrainingData } from './types';

// —— sparkline 微趋势图 ——

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** 用 Unicode block 字符生成迷你趋势线 */
function sparkline(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return SPARK_CHARS[3].repeat(values.length);
  return values.map(v => {
    const idx = Math.round(((v - min) / (max - min)) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[idx];
  }).join('');
}

/** 获取近7天的热量摄入和体重数据 */
function getWeekTrends(dateStr: string): {
  dates: string[];
  calories: number[];
  weights: number[];
} {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 6);
  const startDate = d.toISOString().slice(0, 10);
  const records = getDailyRecords(startDate, dateStr);

  const calMap = new Map<string, number>();
  const wMap = new Map<string, number>();

  for (const r of records) {
    if (r.diet) {
      const summary = calcCalorieSummary(r);
      if (summary.consumed > 0) calMap.set(r.date, summary.consumed);
    }
    if (r.weight) wMap.set(r.date, r.weight);
  }

  const dates: string[] = [];
  const calories: number[] = [];
  const weights: number[] = [];
  const cur = new Date(startDate);
  while (cur.toISOString().slice(0, 10) <= dateStr) {
    const ds = cur.toISOString().slice(0, 10);
    dates.push(ds.slice(5)); // MM-DD
    calories.push(calMap.get(ds) || 0);
    weights.push(wMap.get(ds) || 0);
    cur.setDate(cur.getDate() + 1);
  }

  return { dates, calories, weights };
}

function today(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function dayBefore(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 根据生日 1994-12-15 和指定日期计算实足年龄 */
function calcAge(dateStr: string): number {
  const d = new Date(dateStr);
  const birth = new Date('1994-12-15');
  let age = d.getFullYear() - birth.getFullYear();
  const m = d.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < birth.getDate())) age--;
  return age;
}

// ——— 格式化工具 ———

function bar(percent: number, width = 10): string {
  const filled = Math.round((Math.min(percent, 100) / 100) * width);
  const empty = width - filled;
  if (percent > 100) return '🔴 ' + '█'.repeat(width) + ` ${percent}%`;
  if (percent > 90) return '🟡 ' + '█'.repeat(filled) + '░'.repeat(empty) + ` ${percent}%`;
  return '🟢 ' + '█'.repeat(filled) + '░'.repeat(empty) + ` ${percent}%`;
}

function sleepScore(sleep: any): { label: string; color: string } {
  if (!sleep?.duration) return { label: '无数据', color: 'default' };
  // 有 Apple Watch 截图的真实评分时优先使用
  const score = sleep.sleepScore;
  if (score != null) {
    if (score >= 80) return { label: '优秀', color: 'blue' };
    if (score >= 65) return { label: '良好', color: 'blue' };
    if (score >= 45) return { label: '一般', color: 'yellow' };
    return { label: '较差', color: 'red' };
  }
  // 无截图评分时回退基础判定
  if (sleep.duration >= 7.5 && sleep.deepSleep >= 1.5) return { label: '良好', color: 'blue' };
  if (sleep.duration >= 6.5) return { label: '一般', color: 'yellow' };
  if (sleep.duration < 6) return { label: '不足', color: 'red' };
  return { label: '一般', color: 'yellow' };
}

// ——— 主入口 ———

export interface DailyReport {
  date: string;
  card: object;
  plainText: string;
}

export async function buildDailyReport(dateStr?: string): Promise<DailyReport> {
  const date = dateStr || today();
  const { training, record } = await fetchHealthData(date, config);
  // 读取昨日体重用于环比
  const yesterday = getDailyRecord(dayBefore(date));
  const yesterdayWeight = yesterday?.weight;
  return {
    date,
    card: buildCard(date, record, training, yesterdayWeight),
    plainText: buildPlainText(date, record, training, yesterdayWeight),
  };
}

// ——— 卡片构建 ———

function buildCard(date: string, record: DailyRecord | null, training: TrainingData | null, yesterdayWeight?: number): object {
  const calorie = calcCalorieSummary(record);
  const sleep = record?.sleep;
  const weight = record?.weight || 118;
  const dietExt = (record as any)?.diet;
  const recs: any = (record as any)?.recommendations || {};

  // 动态生成风险提示
  const risks: string[] = [];
  if (calorie.consumed > 0) {
    if (calorie.percentage > 100) {
      risks.push(`热量摄入已达目标 ${calorie.percentage}%，已超出预算，建议控制晚间进食`);
    } else if (calorie.percentage > 85) {
      risks.push(`热量摄入已达目标 ${calorie.percentage}%，接近预算上限，注意晚餐份量`);
    }
    if (calorie.carbs > 0 && calorie.protein > 0 && calorie.fat > 0) {
      const totalMacroCals = calorie.carbs * 4 + calorie.protein * 4 + calorie.fat * 9;
      const fatPct = Math.round(calorie.fat * 9 / totalMacroCals * 100);
      const carbPct = Math.round(calorie.carbs * 4 / totalMacroCals * 100);
      if (fatPct > 40) risks.push(`今日脂肪供能占比 ${fatPct}%，偏高（建议<30%）`);
      if (carbPct > 60) risks.push(`今日碳水供能占比 ${carbPct}%，偏高，注意减少精制主食`);
    }
    // 钠摄入风险
    if (calorie.sodium > 0 && calorie.sodiumTarget > 0) {
      if (calorie.sodiumPercentage > 100) {
        risks.push(`钠摄入已达 ${calorie.sodium}mg（${calorie.sodiumPercentage}%），严重超标，建议减少加工食品/外卖/调味品`);
      } else if (calorie.sodiumPercentage > 80) {
        risks.push(`钠摄入 ${calorie.sodium}mg（${calorie.sodiumPercentage}%），接近上限，注意晚餐低盐`);
      }
    }
    // 食物内容检查
    const allFoods = calorie.meals.map(m => m.content).join(' ');
    if (allFoods.includes('油条')) risks.push('早餐含油条，油炸食品属高脂高热量，建议替换为杂粮馒头/燕麦/蒸玉米');
    if (allFoods.includes('可乐') || allFoods.includes('雪碧')) risks.push('含糖饮料不利于减脂，建议替换为无糖茶或白水');
    if (allFoods.includes('薯条') || allFoods.includes('薯片')) risks.push('油炸零食热量密度极高，建议替换为水果或坚果');
  }
  if (sleep?.duration && sleep.duration < 6.5) {
    risks.push(`睡眠仅 ${sleep.duration}h，严重不足，建议今晚提前1小时就寝`);
  } else if (sleep?.duration && sleep.duration < 7) {
    risks.push(`睡眠 ${sleep.duration}h，不足7小时，午休20分钟可缓解疲劳`);
  }
  if (sleep?.bedTime) {
    const bedH = parseInt(sleep.bedTime.split(':')[0], 10);
    if (bedH >= 1 && bedH < 6) risks.push(`入睡时间 ${sleep.bedTime}，严重熬夜，长期会增加代谢紊乱风险`);
    else if (bedH >= 0 && bedH < 1) risks.push(`入睡时间 ${sleep.bedTime}，超过零点，建议提前至23:00前`);
  }
  // 训练数据优先用训记 API，其次用本地手动记录
  const effectiveStrength = training || record?.training || null;
  const effectiveCardio = record?.cardio || null;
  const totalTrainCal = Math.round((effectiveStrength?.calories || 0) + (effectiveCardio?.calories || 0));
  const hasStrength = effectiveStrength !== null;
  const hasCardio = effectiveCardio !== null;

  if (!hasStrength && !hasCardio) {
    risks.push('今日休息日，连续休息不超过2天有助于保持运动节奏');
  }
  if (record?.steps && record.steps < 3000) {
    risks.push(`今日步数仅 ${record.steps} 步，活动量偏低，建议饭后散步20分钟`);
  }

  // 基础代谢：PAL分级替代固定系数，避免高步数日TDEE失控
  const bmr = Math.round(10 * weight + 6.25 * 181 - 5 * calcAge(date) + 5);
  const steps = record?.steps || 0;
  // PAL分级：<3k→1.20  3-8k→1.35  8-15k→1.55  >15k→1.75
  let pal: number;
  if (steps < 3000) pal = 1.20;
  else if (steps < 8000) pal = 1.35;
  else if (steps < 15000) pal = 1.55;
  else pal = 1.75;
  const totalBurn = Math.round(bmr * pal + totalTrainCal);
  const activityCal = totalBurn - bmr;
  const deficit = calorie.consumed > 0 ? Math.round(totalBurn - calorie.consumed) : 0;

  const sScore = sleepScore(sleep);

  const elements: object[] = [];

  // ── 标题栏 ──
  const isFasting = !!(record as any)?.fastingDay;
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][new Date(date).getDay()];
  elements.push({
    tag: 'markdown',
    content: `**${date} 周${weekDay} · 健康日报**${isFasting ? '  🥗 断食日' : ''}`,
  });

  // 断食日提示
  if (isFasting) {
    const fastingCal = config.health.fastingCalorieTarget;
    const fastingProtein = config.health.fastingProteinTarget;
    elements.push({
      tag: 'markdown',
      content: `🥗 **今日为5+2轻断食日**  ·  热量上限 \`${fastingCal}\` kcal  ·  蛋白质 \`≥${fastingProtein}\` g  ·  多喝水  ·  以蔬菜和高蛋白低碳食物为主`,
    });
  }

  // ── 核心指标卡片（3 列）──
  elements.push({
    tag: 'column_set',
    flex_mode: 'bisect',
    background_style: 'grey',
    columns: [
      metricColumn('😴 睡眠', sleep?.duration ? `${sleep.duration}h` : '—', sScore.label,
        sleep ? `${sleep.bedTime}→${sleep.wakeTime}` : null,
        sleep?.deepSleep ? `深睡 ${sleep.deepSleep}h` : null),
      buildTrainingColumn(totalTrainCal, effectiveStrength, effectiveCardio),
      metricColumn('🍽 饮食', calorie.consumed > 0 ? `${calorie.consumed} kcal` : '—',
        calorie.consumed > 0 ? `${calorie.percentage}%` : '待记录',
        calorie.consumed > 0 ? `剩余 ${calorie.remaining} kcal` : null,
        null),
    ],
  });

  // ── 热量缺口 + 体重环比（减脂核心指标）──
  if (calorie.consumed > 0) {
    const deficitSign = deficit >= 0 ? '+' : '';
    const deficitEmoji = deficit >= 0 ? '🔥' : '⚠️';
    const deficitLabel = deficit >= 0 ? '亏' : '盈';
    const absDeficit = Math.abs(deficit);
    const weightParts: string[] = [];
    if (weight) {
      weightParts.push(`⚖️ **${weight}kg**`);
      if (yesterdayWeight) {
        const diff = weight - yesterdayWeight;
        const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
        weightParts.push(`${arrow}${Math.abs(diff).toFixed(1)} 昨`);
      } else {
        weightParts.push('—');
      }
    }
    elements.push({
      tag: 'markdown',
      content: `${deficitEmoji} 热量${deficitLabel} **\`${deficitSign}${absDeficit}\` kcal**    ${weightParts.join('  ')}`,
    });
  }

  // ── 热量进度条 ──
  if (calorie.consumed > 0) {
    // 10 格进度条，pct 超过 100 时全满但颜色变红
    const displayPct = Math.min(calorie.percentage, 100);
    const filled = Math.round(displayPct / 10);
    const remain = 10 - filled;
    const color = calorie.percentage > 100 ? '🔴' : calorie.percentage > 90 ? '🟡' : '🟢';
    // 用行内代码 `` 包裹色块确保等宽对齐
    const bar = '`' + '█'.repeat(filled) + '░'.repeat(remain) + '`';
    const progressBar = `${bar} ${color} ${calorie.percentage}%`;
    const deficitSign = deficit >= 0 ? '+' : '';
    const hasExerciseBonus = calorie.exerciseBonus > 0;
    elements.push({
      tag: 'markdown',
      content: [
        `**热量进度**  ${progressBar}`,
        `目标 \`${calorie.target}\`${hasExerciseBonus ? ` + 运动奖励 \`${calorie.exerciseBonus}\` = \`${calorie.adjustedTarget}\`` : ''}  ·  已摄入 \`${calorie.consumed}\`  ·  剩余 \`${calorie.remaining}\``,
        `总消耗 \`${totalBurn}\`（BMR \`${bmr}\` + 活动 \`${activityCal}\`）  ·  运动 \`${totalTrainCal}\` kcal  ·  缺口 **\`${deficitSign}${deficit}\` kcal**`,
        steps > 0 ? `👣 步数 \`${steps.toLocaleString()}\`  ·  活动消耗估算 \`${activityCal}\` kcal` : '👣 步数 未记录',
      ].join('  \n'),
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: `**热量进度**  ⬜ 暂无饮食记录\n请记录今日饮食数据，开启热量追踪`,
    });
  }

  // ── 近7日趋势 ──
  const trends = getWeekTrends(date);
  const hasAnyCal = trends.calories.some(v => v > 0);
  const hasAnyWt = trends.weights.some(v => v > 0);
  if (hasAnyCal || hasAnyWt) {
    const trendLines: string[] = ['**📈 近7日趋势**'];
    if (hasAnyCal) {
      const avgCal = Math.round(trends.calories.filter(v => v > 0).reduce((a, b) => a + b, 0) / trends.calories.filter(v => v > 0).length);
      trendLines.push(`热量 \`${avgCal}\` kcal  ${sparkline(trends.calories)}`);
    }
    if (hasAnyWt) {
      const firstWt = trends.weights.find(v => v > 0);
      const lastWt = [...trends.weights].reverse().find(v => v > 0);
      const diff = firstWt && lastWt ? lastWt - firstWt : null;
      const arrow = diff === null ? '' : diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
      trendLines.push(`体重 ${diff !== null ? `${arrow}${Math.abs(diff).toFixed(1)}kg` : ''}  ${sparkline(trends.weights)}`);
    }
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: trendLines.join('\n') });
  }

  // ── 饮食明细 ──
  if (calorie.meals.length > 0) {
    const mealLines = calorie.meals.map(m =>
      `▸ **${mealLabel(m.time)}** ${m.content}  —  \`${m.calories} kcal\``
    );
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `**🍽 饮食明细**\n${mealLines.join('\n')}` });
  }

  // ── 碳蛋脂比例 ──
  if (calorie.consumed > 0 && (calorie.carbs > 0 || calorie.protein > 0 || calorie.fat > 0)) {
    const carbCals = calorie.carbs * 4;
    const proteinCals = calorie.protein * 4;
    const fatCals = calorie.fat * 9;
    const totalMacroCals = carbCals + proteinCals + fatCals;
    const carbPct = totalMacroCals > 0 ? Math.round(carbCals / totalMacroCals * 100) : 0;
    const proteinPct = totalMacroCals > 0 ? Math.round(proteinCals / totalMacroCals * 100) : 0;
    const fatPct = 100 - carbPct - proteinPct;
    // 目标建议：蛋白质1.6g/kg，脂肪0.6g/kg
    const weightForMacro = weight;
    const proteinTarget = Math.round(weightForMacro * 1.6);
    const fatTarget = Math.round(weightForMacro * 0.6);
    const macroLines = [
      `**🍱 碳蛋脂比例**`,
      `🍚碳 \`${calorie.carbs.toFixed(1)}g (${carbPct}%)\`  ·  🥚蛋 \`${calorie.protein.toFixed(1)}g (${proteinPct}%)\`  ·  🥓脂 \`${calorie.fat.toFixed(1)}g (${fatPct}%)\``,
      `参考目标：🥚蛋 \`~${proteinTarget}g\`  ·  🥓脂 \`~${fatTarget}g\`  ·  🍚碳由热量预算补齐`,
    ];
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: macroLines.join('\n') });
  }

  // ── 钠摄入 ──
  if (calorie.sodium > 0 && calorie.sodiumTarget > 0) {
    const sodiumPct = calorie.sodiumPercentage;
    const sodiumEmoji = sodiumPct > 100 ? '🔴' : sodiumPct > 80 ? '🟡' : '🟢';
    // 钠进度条
    const displayPct = Math.min(sodiumPct, 100);
    const filled = Math.round(displayPct / 10);
    const remain = 10 - filled;
    const sBar = '`' + '█'.repeat(filled) + '░'.repeat(remain) + '`';
    const sodiumBar = `${sBar} ${sodiumEmoji} ${sodiumPct}%`;
    const sodiumStatus = sodiumPct > 100
      ? '⚠️ 钠摄入超标，明日需严格控制'
      : sodiumPct > 80
      ? '⚡ 接近上限，注意晚餐低盐'
      : '✅ 钠控制良好';
    const sodiumLines = [
      `**🧂 钠摄入**  ${sodiumBar}`,
      `已摄入 \`${calorie.sodium}mg\`  /  目标 \`${calorie.sodiumTarget}mg\`  ·  ${sodiumStatus}`,
      `参考：WHO 建议 <2000mg/天，高尿酸/脂肪肝患者建议 <1500mg/天`,
    ];
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: sodiumLines.join('\n') });
  }

  // ── 风险提示 ──
  if (risks.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**⚠️ 风险提示**\n${risks.map((r: string) => `· ${r}`).join('\n')}`,
    });
  }

  // ── 建议 ──
  const advices: string[] = [];
  if (sScore.label === '较差' || sScore.label === '一般') {
    advices.push('😴 睡眠质量偏低，建议提前30分钟入睡，减少睡前屏幕时间');
  }

  if (isFasting) {
    // 断食日专属建议
    const fastingProtein = config.health.fastingProteinTarget;
    if (calorie.consumed > 0) {
      if (calorie.consumed > calorie.target) {
        advices.push(`🥗 断食日热量已超 \`${calorie.target}\` kcal 上限，晚餐以纯蔬菜为主`);
      } else {
        advices.push(`🥗 断食日热量在 \`${calorie.target}\` kcal 以内，继续保持`);
      }
    }
    if (calorie.protein < fastingProtein) {
      advices.push(`🥚 断食日蛋白质需 ≥${fastingProtein}g 防止肌肉流失，当前 ${calorie.protein}g`);
    }
    advices.push('💧 断食日务必多喝水（3L+），帮助酮体代谢和尿酸排泄');
    advices.push('🥬 优先高纤维蔬菜（西兰花/菠菜/生菜），增加饱腹感');
    if (hasStrength) {
      advices.push('⚠️ 断食日不建议做大重量力量训练，可改为散步或体态纠正');
    }
  } else {
    // 正常日建议
    if (calorie.remaining < 0) {
      advices.push('🔥 热量已超标，明日控制碳水摄入，增加30分钟有氧');
    } else if (calorie.remaining < 300 && calorie.consumed > 0) {
      advices.push('⚠️ 热量余量紧张，晚餐以蔬菜和瘦肉蛋白为主');
    } else if (calorie.consumed > 0) {
      advices.push('✅ 热量控制良好，继续保持当前节奏');
    }
  }

  if (!hasStrength && !hasCardio) {
    if (!isFasting) advices.push('🏃 今日休息日，建议安排20分钟散步或体态纠正训练');
  } else {
    if (hasStrength && !isFasting) {
      advices.push(`💪 力量训练「${effectiveStrength!.bodyPart}」，注意补充蛋白质（目标体重×1.6g=190g/天）`);
    }
    if (hasCardio) {
      advices.push(`🏃 有氧训练「${effectiveCardio!.bodyPart}」，注意补充水分和电解质`);
    }
  }
  if (sleep?.duration && sleep.duration < 7) {
    advices.push('😴 睡眠不足7小时，午休20分钟可缓解疲劳');
  }
  if (recs.dinner) advices.push(`🍽 晚餐建议：${recs.dinner}`);
  if (recs.hydration) advices.push(`💧 ${recs.hydration}`);

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `**💡 今日建议**\n${advices.map(a => `· ${a}`).join('\n')}`,
  });

  // ── 页脚 ──
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `数据来源：训记 + 手动记录 · 每日 ${config.report.cronTime.split(' ')[1]}:00 自动推送` }],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 ${date} 健康日报${isFasting ? ' 🥗 断食日' : ''}` },
      template: (isFasting ? 'green' : sScore.color) as any,
    },
    elements,
  };
}

function metricColumn(
  title: string,
  value: string,
  subtitle: string,
  detail1: string | null,
  detail2: string | null,
): object {
  const contentParts: string[] = [`**${value}**`];
  if (subtitle) contentParts.push(subtitle);
  const details = [detail1, detail2].filter(Boolean).join('  \n');
  if (details) contentParts.push(details);

  return {
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'markdown',
        content: `${title}\n${contentParts.join('\n')}`,
      },
    ],
  };
}

function mealLabel(time: string): string {
  const map: Record<string, string> = {
    breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐',
  };
  return map[time] || time;
}

/** 构建训练指标列：力量和有氧分开展示 */
function buildTrainingColumn(
  totalCal: number,
  strength: TrainingData | null,
  cardio: TrainingData | null,
): object {
  const hasStrength = strength !== null;
  const hasCardio = cardio !== null;

  if (hasStrength && hasCardio) {
    const sDetail = formatTrainingDetail(strength!);
    const cDetail = formatCardioDetail(cardio!);
    return metricColumnRaw(
      '🏃 训练',
      `${totalCal} kcal`,
      '力量 + 有氧',
      `💪 ${strength!.bodyPart}  \`${strength!.calories}kcal\`  ${sDetail}`,
      `🏃 ${cardio!.bodyPart}  \`${cardio!.calories}kcal\`  ${cDetail}`,
    );
  }
  if (hasStrength) {
    return metricColumn('🏃 训练', `${totalCal} kcal`, '力量完成',
      strength!.bodyPart, formatTrainingDetail(strength!));
  }
  if (hasCardio) {
    return metricColumn('🏃 训练', `${totalCal} kcal`, '有氧完成',
      cardio!.bodyPart, formatCardioDetail(cardio!));
  }
  return metricColumn('🏃 训练', '休息日', '恢复中', null, '今日可安排轻度有氧');
}

/** 创建指标列（底层工厂），与 metricColumn 相同结构 */
function metricColumnRaw(
  title: string, value: string, subtitle: string, detail1: string, detail2: string,
): object {
  return {
    width: 'weighted',
    weight: 1,
    elements: [{
      tag: 'markdown',
      content: `${title}\n**${value}**\n${subtitle}\n${detail1}  \n${detail2}`,
    }],
  };
}

/** 格式化训练详情，避免部位和动作同名时出现重复 */
function formatTrainingDetail(t: TrainingData): string {
  const exNames = t.exercises.map(e => e.name);
  const allSameAsBody = exNames.every(n => n === t.bodyPart);
  if (allSameAsBody) {
    const parts: string[] = [];
    if (t.duration) parts.push(t.duration);
    if (t.distance) parts.push(t.distance);
    if (t.avgHeartRate) parts.push(`avgHR ${t.avgHeartRate}`);
    return parts.length > 0 ? parts.join('  · ') : t.bodyPart;
  }
  return exNames.slice(0, 2).join('、');
}

/** 格式化有氧训练详情（距离、时长、心率） */
function formatCardioDetail(t: TrainingData): string {
  const parts: string[] = [];
  if (t.duration) parts.push(t.duration);
  if (t.distance) parts.push(t.distance);
  if (t.avgHeartRate) parts.push(`avgHR ${t.avgHeartRate}`);
  if (parts.length === 0) {
    if (t.exercises.length > 0) {
      return t.exercises.map(e => e.name).join('、');
    }
    return t.bodyPart;
  }
  return parts.join('  · ');
}

// ——— 纯文本版 ———

function buildPlainText(date: string, record: DailyRecord | null, training: TrainingData | null, yesterdayWeight?: number): string {
  const calorie = calcCalorieSummary(record);
  const sleep = record?.sleep;
  const weight = record?.weight || 118;
  const effectiveStrength = training || record?.training || null;
  const effectiveCardio = record?.cardio || null;
  const bmr = Math.round(10 * weight + 6.25 * 181 - 5 * calcAge(date) + 5);
  const steps = record?.steps || 0;
  const stepCalories = steps > 0 ? estimateStepCalories(steps, weight) : 0;
  const totalTrainCal = Math.round((effectiveStrength?.calories || 0) + (effectiveCardio?.calories || 0));
  // PAL分级：<3k→1.20  3-8k→1.35  8-15k→1.55  >15k→1.75
  let pal2: number;
  if (steps < 3000) pal2 = 1.20;
  else if (steps < 8000) pal2 = 1.35;
  else if (steps < 15000) pal2 = 1.55;
  else pal2 = 1.75;
  const totalBurn = Math.round(bmr * pal2 + totalTrainCal);
  const activityCal = totalBurn - bmr;
  const deficit = calorie.consumed > 0 ? Math.round(totalBurn - calorie.consumed) : 0;

  const trainParts: string[] = [];
  if (effectiveStrength) {
    trainParts.push(`💪${effectiveStrength.bodyPart} ${effectiveStrength.calories}kcal ${formatTrainingDetail(effectiveStrength)}`);
  }
  if (effectiveCardio) {
    trainParts.push(`🏃${effectiveCardio.bodyPart} ${effectiveCardio.calories}kcal ${formatCardioDetail(effectiveCardio)}`);
  }
  const trainLine = trainParts.length > 0 ? trainParts.join(' | ') : '休息日';

  // 7日趋势
  const plainTrends = getWeekTrends(date);
  const trendLines: string[] = [];
  const hasPlainCal = plainTrends.calories.some(v => v > 0);
  const hasPlainWt = plainTrends.weights.some(v => v > 0);
  if (hasPlainCal) {
    trendLines.push(`热量趋势: ${sparkline(plainTrends.calories)}`);
  }
  if (hasPlainWt) {
    trendLines.push(`体重趋势: ${sparkline(plainTrends.weights)}`);
  }

  return [
    `${date} 健康日报`,
    '━━━━━━━━━━━━━━',
    `睡眠: ${sleep ? `${sleep.duration}h (${sleep.bedTime}→${sleep.wakeTime}) 深睡${(sleep as any).deepSleep || '?'}h` : '无数据'}`,
    `训练: ${trainLine}`,
    `饮食: ${calorie.consumed}/${calorie.adjustedTarget} kcal (${calorie.percentage}%) 基础目标${calorie.target}${calorie.exerciseBonus > 0 ? ` +运动${calorie.exerciseBonus}` : ''} 剩余${calorie.remaining} kcal`,
    `体重: ${weight}kg${yesterdayWeight ? ` (${yesterdayWeight > weight ? '↓' : yesterdayWeight < weight ? '↑' : '→'}${Math.abs(weight - yesterdayWeight).toFixed(1)} 昨)` : ''}`,
    `热量缺口: ${deficit >= 0 ? '+' : ''}${deficit} kcal（消耗 ${totalBurn} - 摄入 ${calorie.consumed}）  运动: ${totalTrainCal} kcal`,
    `步数: ${steps > 0 ? `${steps.toLocaleString()} 步  估算消耗 ${stepCalories} kcal` : '未记录'}`,
    ...(calorie.consumed > 0 && (calorie.carbs > 0 || calorie.protein > 0 || calorie.fat > 0)
      ? [`碳蛋脂: 🍚碳${calorie.carbs.toFixed(1)}g · 🥚蛋${calorie.protein.toFixed(1)}g · 🥓脂${calorie.fat.toFixed(1)}g`]
      : []),
    ...(calorie.sodium > 0
      ? [`钠: 🧂${calorie.sodium}mg / ${calorie.sodiumTarget}mg (${calorie.sodiumPercentage}%)`]
      : []),
    ...(trendLines.length > 0 ? ['── 近7日趋势 ──', ...trendLines] : []),
  ].join('\n');
}
