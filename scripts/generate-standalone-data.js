// 从 .data/health/ 原始数据重新生成 dashboard/standalone-data.json
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.data', 'health');
const OUTPUT = path.join(ROOT, 'dashboard', 'standalone-data.json');

// 使用编译后的模块
const { getDailyRecords, listRecordDates } = require('../dist/health/store');
const { calcCalorieSummary } = require('../dist/health/calorie');

console.log('[生成数据] 读取健康记录...');

// 获取所有记录日期
const dates = listRecordDates();
if (dates.length === 0) {
  console.error('[生成数据] 没有找到健康记录');
  process.exit(1);
}

console.log('[生成数据] 共 ' + dates.length + ' 天记录: ' + dates[0] + ' ~ ' + dates[dates.length - 1]);

// 读取所有数据
const allData = dates.map(date => {
  const record = getDailyRecords(date, date)[0];
  if (!record) return null;
  return {
    ...record,
    calorieSummary: calcCalorieSummary(record),
  };
}).filter(Boolean);

// 计算统计
const sleepDurations = allData.filter(r => r.sleep.duration > 0).map(r => r.sleep.duration);
const weights = allData.filter(r => r.weight).map(r => r.weight);
const trainingDays = allData.filter(r => r.training || (r.cardio && r.cardio.calories > 0));

const stats = {
  totalDays: allData.length,
  dateRange: dates[0] + ' ~ ' + dates[dates.length - 1],
  avgSleep: sleepDurations.length > 0
    ? (sleepDurations.reduce((a, b) => a + b, 0) / sleepDurations.length).toFixed(1)
    : '0',
  avgWeight: weights.length > 0
    ? (weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(1)
    : '0',
  trainingDays: trainingDays.length,
  weightChange: weights.length >= 2
    ? (weights[weights.length - 1] - weights[0]).toFixed(1)
    : '0',
};

// 生成趋势数据（简化版，包含关键指标）
function buildTrendRecord(r) {
  const cs = r.calorieSummary;
  const tdee = cs.adjustedTarget || cs.target || 2000;
  const consumed = cs.consumed || 0;
  const trainCal = (r.training?.calories || 0) + (r.cardio?.calories || 0);
  const deficit = consumed > 0 ? tdee - consumed : null;

  return {
    date: r.date,
    consumed,
    target: cs.target || 2000,
    tdee,
    trainCal,
    deficit,
    carbs: cs.carbs || 0,
    protein: cs.protein || 0,
    fat: cs.fat || 0,
    steps: r.steps || 0,
    sleepDuration: r.sleep.duration || 0,
    deepSleep: r.sleep.deepSleep || 0,
    lightSleep: r.sleep.lightSleep || 0,
    remSleep: r.sleep.remSleep || 0,
    sleepScore: r.sleep.sleepScore || 0,
    bedtimeHour: r.sleep.bedTime
      ? parseFloat(r.sleep.bedTime.split(':')[0]) + parseFloat(r.sleep.bedTime.split(':')[1]) / 60
      : 0,
    bedTime: r.sleep.bedTime || '',
    weight: r.weight || null,
    sodium: cs.sodium || 0,
    sodiumTarget: cs.sodiumTarget || 2000,
    fastingDay: r.fastingDay || false,
  };
}

const trends14 = allData.slice(-14).map(buildTrendRecord);
const trends30 = allData.slice(-30).map(buildTrendRecord);
const trends90 = allData.slice(-90).map(buildTrendRecord);

// 组装输出
const output = {
  generatedAt: new Date().toISOString(),
  stats,
  allData,
  trends14,
  trends30,
  trends90,
};

fs.writeFileSync(OUTPUT, JSON.stringify(output));
const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log('[生成数据] ✅ 已写入 dashboard/standalone-data.json (' + size + ' KB)');
console.log('[生成数据] 统计: ' + allData.length + ' 天, 训练 ' + stats.trainingDays + ' 天, 体重 ' + stats.weightChange + 'kg');
