/**
 * 回填历史睡眠阶段数据（lightSleep/remSleep/awakeTime）
 * 基于已有的 deepSleep 和 duration 按典型睡眠结构估算
 */
import fs from 'fs';
import path from 'path';

const HEALTH_DIR = path.resolve(__dirname, '../.data/health');
const BACKUP_DIR = path.join(HEALTH_DIR, '.stage-backfill');

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const files = fs.readdirSync(HEALTH_DIR).filter(f => f.endsWith('.json') && !f.startsWith('foods'));

let fixed = 0;
for (const file of files) {
  const filePath = path.join(HEALTH_DIR, file);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const sleep = data.sleep;
  if (!sleep || !sleep.duration) continue;

  // 已有完整阶段的跳过
  if (sleep.lightSleep && sleep.remSleep && sleep.awakeTime) {
    console.log(`  ⏭️ ${file} — 阶段完整，跳过`);
    continue;
  }

  // 备份
  fs.writeFileSync(path.join(BACKUP_DIR, file), raw, 'utf-8');

  const dur = sleep.duration;
  const deep = sleep.deepSleep || dur * 0.18;

  // 按典型比例估算（以深睡为锚点）
  const deepRatio = deep / dur;
  const remEst = Math.round(dur * 0.22 * 10) / 10;    // REM ≈22%
  const awakeEst = Math.round(dur * 0.03 * 10) / 10;   // 清醒 ≈3%
  // 剩余归浅睡，但不能为负
  const lightEst = Math.max(0, Math.round((dur - deep - remEst - awakeEst) * 10) / 10);

  sleep.deepSleep = Math.round(deep * 10) / 10;
  sleep.lightSleep = lightEst;
  sleep.remSleep = remEst;
  sleep.awakeTime = awakeEst;

  // 如果没有 sleepScore，估算一个
  if (!sleep.sleepScore) {
    const deepScore = Math.min(30, Math.round(deepRatio / 0.25 * 30));
    const durScore = dur >= 7 ? 35 : dur >= 6 ? 25 : 15;
    const qMap: Record<string, number> = { excellent: 28, good: 22, fair: 15, poor: 8 };
    const qScore = qMap[sleep.quality] || 15;
    sleep.sleepScore = Math.min(100, deepScore + durScore + qScore);
  }

  // 如果没有 quality，估算
  if (!sleep.quality || sleep.quality === 'fair') {
    const score = sleep.sleepScore || 70;
    sleep.quality = score >= 80 ? 'good' : score >= 65 ? 'fair' : 'poor';
  }

  data.sleep = sleep;
  data.updatedAt = Date.now();
  (data as any)._sleepStagesEstimated = true; // 标记为估算值

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  fixed++;
  console.log(`  ✅ ${file} — 深${deep.toFixed(1)} 浅${lightEst} REM${remEst} 醒${awakeEst} 分${sleep.sleepScore}`);
}

console.log(`\n总计: ${files.length} 个文件，回填 ${fixed} 个`);
console.log(`备份: ${BACKUP_DIR}`);
