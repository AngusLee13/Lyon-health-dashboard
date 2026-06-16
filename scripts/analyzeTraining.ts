import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(__dirname, '../.cache/xunji');

interface SetDetail { weight: number; reps: number; }
interface Exercise {
  name: string;
  sets: number;
  weight: number;      // 平均重量
  reps: number;        // 平均次数
  setDetails: SetDetail[];  // 每组详情
  bestE1RM: number;    // 当日最佳估算1RM
}
interface TrainingSession {
  date: string; dayOfWeek: number; bodyPart: string;
  exercises: Exercise[]; totalVolume: number; calories: number;
}

/** Epley公式估算1RM */
function e1RM(weight: number, reps: number): number {
  if (reps <= 0) return weight;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30));
}

/** 解析训记缓存 */
function parseAllSessions(): TrainingSession[] {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  const sessions: TrainingSession[] = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
    for (const item of raw.items || []) {
      const parts = item.raw.split(',');
      const bodyPart = parts[2] || '未知';
      const date = parts[0] || '';
      let calories = 0;
      const calSeg = parts.find((p: string) => p.startsWith('calorie:'));
      if (calSeg) calories = parseInt(calSeg.split(':')[1], 10) || 0;

      const exercises: Exercise[] = [];
      let current: { name: string; sets: SetDetail[] } | null = null;

      for (let i = 5; i < parts.length; i++) {
        const p = parts[i];
        const exMatch = p.match(/^(\d+)\.(?!\d+kg)(.+)/);
        if (exMatch) {
          if (current && current.sets.length > 0) {
            const avgW = Math.round(current.sets.reduce((s, x) => s + x.weight, 0) / current.sets.length);
            const avgR = Math.round(current.sets.reduce((s, x) => s + x.reps, 0) / current.sets.length);
            const best = Math.max(...current.sets.map(s => e1RM(s.weight, s.reps)));
            exercises.push({ name: current.name, sets: current.sets.length, weight: avgW, reps: avgR, setDetails: [...current.sets], bestE1RM: best });
          }
          current = { name: exMatch[2], sets: [] };
          continue;
        }
        const wtMatch = p.match(/^(\d+[.\d]*)kg$/);
        if (wtMatch && i + 1 < parts.length) {
          const repsMatch = parts[i + 1].match(/^(\d+)次$/);
          if (repsMatch && current) { current.sets.push({ weight: parseFloat(wtMatch[1]), reps: parseInt(repsMatch[1]) }); i++; }
        }
      }
      if (current && current.sets.length > 0) {
        const avgW = Math.round(current.sets.reduce((s, x) => s + x.weight, 0) / current.sets.length);
        const avgR = Math.round(current.sets.reduce((s, x) => s + x.reps, 0) / current.sets.length);
        const best = Math.max(...current.sets.map(s => e1RM(s.weight, s.reps)));
        exercises.push({ name: current.name, sets: current.sets.length, weight: avgW, reps: avgR, setDetails: [...current.sets], bestE1RM: best });
      }

      if (exercises.length > 0) {
        const totalVolume = exercises.reduce((s, e) => s + e.sets * e.weight * e.reps, 0);
        const formattedDate = `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`;
        sessions.push({ date: formattedDate, dayOfWeek: new Date(formattedDate).getDay(), bodyPart, exercises, totalVolume, calories });
      }
    }
  }
  return sessions.sort((a, b) => a.date.localeCompare(b.date));
}

// ——— 工具 ———
function bar(val: number, max: number, width = 20): string {
  const filled = Math.min(Math.round((val / (max || 1)) * width), width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
function sparkline(values: number[]): string {
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  return values.map(v => '▁▂▃▄▅▆▇█'[Math.min(Math.floor(((v - min) / range) * 7), 7)]).join('');
}
function avg(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ——— 分析 ———

function analyzeFrequency(sessions: TrainingSession[]): string {
  const byMonth: Record<string, TrainingSession[]> = {};
  for (const s of sessions) { const m = s.date.slice(0, 7); if (!byMonth[m]) byMonth[m] = []; byMonth[m].push(s); }
  const months = Object.keys(byMonth).sort();
  let out = '## 一、训练频率分析\n\n| 月份 | 训练天数 | 月均/周 | 趋势 |\n|------|---------|---------|------|\n';
  for (const m of months) {
    const days = byMonth[m].length;
    out += `| ${m} | ${days}天 | ${Math.round(days / 4.3 * 10) / 10}次/周 | ${bar(days, 24, 15)} |\n`;
  }
  out += `\n**3个月平均: ${Math.round(sessions.length / (months.length * 4.3) * 10) / 10} 次/周** | 总计 ${sessions.length} 次训练\n`;
  return out;
}

function analyzeBodyParts(sessions: TrainingSession[]): string {
  const count: Record<string, number> = {}, vol: Record<string, number> = {};
  for (const s of sessions) { count[s.bodyPart] = (count[s.bodyPart] || 0) + 1; vol[s.bodyPart] = (vol[s.bodyPart] || 0) + s.totalVolume; }
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  const maxCnt = sorted[0]?.[1] || 1;
  let out = '## 二、训练部位分布\n\n| 部位 | 次数 | 占比 | 分布 | 总容量(kg) |\n|------|------|------|------|------------|\n';
  for (const [p, c] of sorted) out += `| ${p} | ${c}次 | ${Math.round(c / sessions.length * 100)}% | ${bar(c, maxCnt, 10)} | ${(vol[p] || 0).toLocaleString()} |\n`;
  if (sorted.length > 0 && sorted[0][1] > (sorted[sorted.length - 1][1] || 1) * 3) {
    out += `\n⚠️ 部位不均衡：最多「${sorted[0][0]}」是最少「${sorted[sorted.length - 1][0]}」的 **${Math.round(sorted[0][1] / sorted[sorted.length - 1][1])}倍**\n`;
  }
  return out;
}

/** RM进阶分析 — 核心新增 */
function analyzeRMProgression(sessions: TrainingSession[]): string {
  const keyLifts = ['深蹲', '卧推', '推举', '硬拉', '杠铃划船', '引体向上', '弯举', '臂屈伸'];
  // 收集每次训练中关键动作的所有组详情
  const liftSets: Record<string, { date: string; weight: number; reps: number; e1rm: number }[]> = {};

  for (const s of sessions) {
    for (const e of s.exercises) {
      for (const lift of keyLifts) {
        if (e.name.includes(lift)) {
          if (!liftSets[lift]) liftSets[lift] = [];
          for (const set of e.setDetails) {
            liftSets[lift].push({ date: s.date, weight: set.weight, reps: set.reps, e1rm: e1RM(set.weight, set.reps) });
          }
        }
      }
    }
  }

  let out = '## 三、RM进阶分析（重量×次数）\n\n';
  out += '> RM（Repetition Maximum）进阶是力量增长的核心指标。**重量增加 + 次数不变/减少 = 绝对力量提升**；**重量不变 + 次数增加 = 肌耐力提升**。\n\n';

  const liftOrder = Object.entries(liftSets).sort((a, b) => b[1].length - a[1].length);

  for (const [lift, sets] of liftOrder) {
    if (sets.length < 5) continue;

    // 按月聚合
    const byMonth: Record<string, { weights: number[]; reps: number[]; e1rms: number[] }> = {};
    for (const s of sets) {
      const m = s.date.slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { weights: [], reps: [], e1rms: [] };
      byMonth[m].weights.push(s.weight); byMonth[m].reps.push(s.reps); byMonth[m].e1rms.push(s.e1rm);
    }
    const months = Object.keys(byMonth).sort();

    const avgWeights = months.map(m => Math.round(avg(byMonth[m].weights)));
    const avgReps = months.map(m => Math.round(avg(byMonth[m].reps) * 10) / 10);
    const avgE1RMs = months.map(m => Math.round(avg(byMonth[m].e1rms)));

    // 重量趋势
    const wFirst = avgWeights[0], wLast = avgWeights[avgWeights.length - 1];
    const rFirst = avgReps[0], rLast = avgReps[avgReps.length - 1];
    const e1First = avgE1RMs[0], e1Last = avgE1RMs[avgE1RMs.length - 1];
    const e1Change = e1Last - e1First;

    // 判断RM进阶类型
    let rmType = '';
    if (wLast > wFirst && rLast <= rFirst) rmType = '🟢 **力量型进阶**：重量↑ 次数↓或持平，绝对力量提升';
    else if (wLast > wFirst && rLast > rFirst) rmType = '🟡 **双重进阶**：重量↑ 次数↑，力量和耐力同步增长（优秀）';
    else if (wLast <= wFirst && rLast > rFirst) rmType = '🔵 **耐力型进阶**：重量持稳 次数↑，肌耐力提升';
    else if (wLast < wFirst) rmType = '🔴 **退步**：重量下降，需关注';
    else rmType = '⚪ **维持**：无明显变化';

    out += `### ${lift}\n\n`;
    out += `| 月份 | 均重(kg) | 均次 | e1RM(kg) | RM类型 |\n`;
    out += `|------|----------|------|----------|--------|\n`;

    for (let i = 0; i < months.length; i++) {
      const e1Arrow = i > 0 ? (avgE1RMs[i] > avgE1RMs[i - 1] ? '↗' : avgE1RMs[i] < avgE1RMs[i - 1] ? '↘' : '→') : '';
      out += `| ${months[i]} | ${avgWeights[i]} | ${avgReps[i]} | ${avgE1RMs[i]} ${e1Arrow} | — |\n`;
    }

    out += `\n<callout emoji="${e1Change > 0 ? '✅' : '⚠️'}" background-color="${e1Change > 0 ? 'light-green' : 'light-yellow'}">\n`;
    out += `**预估1RM**: ${e1First}kg → ${e1Last}kg (${e1Change >= 0 ? '+' : ''}${e1Change}kg  ${Math.round(e1Change / (e1First || 1) * 100)}%)\n`;
    out += `**进阶类型**: ${rmType}\n`;
    out += `**月度趋势**: ${sparkline(avgE1RMs)}  ${avgE1RMs.join(' → ')} kg\n`;
    out += `</callout>\n\n`;
  }

  if (Object.keys(liftSets).length === 0) {
    out += '未识别到可追踪的复合动作数据，请规范训记中动作命名。\n';
  }

  return out;
}

function analyzeVolume(sessions: TrainingSession[]): string {
  const byWeek: { week: string; volume: number; sessions: number }[] = [];
  for (const s of sessions) {
    const d = new Date(s.date);
    const ws = new Date(d.getTime() - d.getDay() * 86400000).toISOString().slice(0, 10);
    const ex = byWeek.find(w => w.week === ws);
    if (ex) { ex.volume += s.totalVolume; ex.sessions++; }
    else byWeek.push({ week: ws, volume: s.totalVolume, sessions: 1 });
  }
  const maxVol = Math.max(...byWeek.map(w => w.volume));
  const vols = byWeek.map(w => w.volume);
  let out = '## 四、训练容量趋势\n\n';
  out += `周容量趋势: ${sparkline(vols)}\n\n`;
  out += '| 周起始 | 训练数 | 总容量(kg) | 趋势 |\n|--------|--------|------------|------|\n';
  for (const w of byWeek.slice(-12)) out += `| ${w.week} | ${w.sessions}次 | ${w.volume.toLocaleString()} | ${bar(w.volume, maxVol, 12)} |\n`;
  if (vols.length >= 4) {
    const half = Math.floor(vols.length / 2);
    const a1 = avg(vols.slice(0, half)), a2 = avg(vols.slice(half));
    out += `\n前半段周均: **${Math.round(a1).toLocaleString()}kg** → 后半段: **${Math.round(a2).toLocaleString()}kg** (**${Math.round((a2 - a1) / a1 * 100)}%**)\n`;
  }
  return out;
}

function analyzeArrangement(sessions: TrainingSession[]): string {
  const dates = sessions.map(s => new Date(s.date).getTime());
  const intervals: number[] = [];
  for (let i = 1; i < dates.length; i++) intervals.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
  const avgRest = intervals.length > 0 ? Math.round(avg(intervals) * 10) / 10 : 0;
  let maxStreak = 0, curStreak = 1;
  for (const iv of intervals) { if (iv === 1) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); } else curStreak = 1; }
  maxStreak = Math.max(maxStreak, curStreak);

  let out = '## 五、训练安排评估\n\n';
  out += `| 指标 | 数值 | 评估 |\n|------|------|------|\n`;
  out += `| 平均训练间隔 | ${avgRest}天 | ${avgRest <= 2 ? '频率充分' : avgRest <= 3 ? '适中' : '偏低'} |\n`;
  out += `| 最长连续训练 | ${maxStreak}天 | ${maxStreak > 3 ? '⚠️ 恢复不足' : '合理'} |\n`;
  out += `| 单次平均容量 | ${Math.round(sessions.reduce((s, x) => s + x.totalVolume, 0) / sessions.length).toLocaleString()}kg | — |\n`;
  out += `| 单次平均动作 | ${Math.round(sessions.reduce((s, x) => s + x.exercises.length, 0) / sessions.length)}个 | — |\n`;
  return out;
}

function analyzeAdvice(sessions: TrainingSession[]): string {
  const byMonth: Record<string, TrainingSession[]> = {};
  for (const s of sessions) { const m = s.date.slice(0, 7); if (!byMonth[m]) byMonth[m] = []; byMonth[m].push(s); }
  const months = Object.keys(byMonth).sort();
  const may = sessions.filter(s => s.date.startsWith('2026-05'));
  const apr = sessions.filter(s => s.date.startsWith('2026-04'));
  const totalWeeks = (new Date(sessions[sessions.length - 1].date).getTime() - new Date(sessions[0].date).getTime()) / (7 * 86400000);
  const perWeek = Math.round(sessions.length / totalWeeks * 10) / 10;

  let out = '## 六、综合评价与建议\n\n';

  out += '### 整体评估\n\n';
  out += `- **训练频率**: ${perWeek}次/周 · ${perWeek >= 4 ? '优秀' : perWeek >= 3 ? '良好' : '一般'}\n`;
  out += `- **5月训练**: ${may.length}次（4月${apr.length}次，下降${Math.round((1 - may.length / (apr.length || 1)) * 100)}%）\n`;

  out += '\n### 调整建议\n\n';

  if (may.length < 12) out += '- 🔄 **恢复训练节奏**：5月断档后，前2周用70-80%重量重建动作模式，避免冲PR导致受伤。\n';
  if (perWeek < 3) out += '- 📈 **提高频率**：当前偏低，减脂期建议3-4次/周力量+2次有氧。\n';
  out += '- 📊 **关注RM进阶**：不只追求容量，更要追踪e1RM（估算1RM）的提升。每次训练尝试在某一个核心动作上增加2.5-5kg或减少1-2次重复来验证力量增长。\n';
  out += '- 🏋️ **规范动作命名**：在训记中使用标准名称（深蹲/卧推/硬拉/推举/划船），确保数据可追踪对比。\n';
  out += '- 📅 **周期性安排**：建议4周力量冲刺+1周减载的周期模式，避免长期高强度导致瓶颈。\n';

  return out;
}

// ——— 主程序 ———
function main() {
  const sessions = parseAllSessions();
  if (!sessions.length) { console.log('无数据'); return; }
  console.log(`# 训练分析报告（含RM进阶）\n`);
  console.log(`**周期**: ${sessions[0].date} → ${sessions[sessions.length - 1].date} | **总训练**: ${sessions.length}次 | **部位**: ${new Set(sessions.map(s => s.bodyPart)).size}个\n`);
  console.log(analyzeFrequency(sessions));
  console.log(analyzeBodyParts(sessions));
  console.log(analyzeRMProgression(sessions));
  console.log(analyzeVolume(sessions));
  console.log(analyzeArrangement(sessions));
  console.log(analyzeAdvice(sessions));
}
main();
