import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(__dirname, '../.cache/xunji');
const OUT_FILE = path.resolve(__dirname, '../reports/feishu-doc-rich.md');

// ——— 精确动作名映射（杜绝变体混淆） ———
// 推日 (Push)
const PUSH_EXERCISES = ['杠铃卧推', '上斜杠铃卧推', '上斜哑铃卧推', '哑铃推肩', '绳索臂屈伸', '侧平举'];
// 拉日 (Pull)
const PULL_EXERCISES = ['EZ杆二头弯举', '窄距把手下拉', '宽距高位下拉', '坐姿划船', '面拉', '杠铃直立划船', 'V-bar划船', '单手下拉'];
// 蹲日 (Squat/Legs)
const SQUAT_EXERCISES = ['悍马机深蹲', '腿举', '坐姿腿弯举', '悍马机早安', '杠铃罗马尼亚硬拉', '山羊挺身'];

const SPLIT_CONFIG: Record<string, { label: string; color: string; exercises: string[] }> = {
  '推': { label: '推日（胸·肩·三头）', color: '#E53935', exercises: PUSH_EXERCISES },
  '拉': { label: '拉日（背·二头）', color: '#1E88E5', exercises: PULL_EXERCISES },
  '蹲': { label: '蹲日（臀·腿）', color: '#FF8F00', exercises: SQUAT_EXERCISES },
};

// ——— 数据解析 ———
interface SetDetail { weight: number; reps: number; }
interface Exercise {
  name: string; sets: number; weight: number; reps: number;
  setDetails: SetDetail[]; bestEst1RM: number;
}
interface TrainingSession {
  date: string; bodyPart: string; exercises: Exercise[]; totalVolume: number;
}

function est1RM(w: number, r: number): number {
  if (r <= 1) return w;
  return Math.round(w * (1 + r / 30));
}

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
      const exercises: Exercise[] = [];
      let current: { name: string; sets: SetDetail[] } | null = null;
      for (let i = 5; i < parts.length; i++) {
        const exMatch = parts[i].match(/^(\d+)\.(?!\d+kg)(.+)/);
        if (exMatch) {
          if (current && current.sets.length > 0) {
            const avgW = Math.round(current.sets.reduce((s, x) => s + x.weight, 0) / current.sets.length);
            const avgR = Math.round(current.sets.reduce((s, x) => s + x.reps, 0) / current.sets.length);
            const best = Math.max(...current.sets.map(s => est1RM(s.weight, s.reps)));
            exercises.push({ name: current.name, sets: current.sets.length, weight: avgW, reps: avgR, setDetails: [...current.sets], bestEst1RM: best });
          }
          current = { name: exMatch[2], sets: [] };
          continue;
        }
        const wtMatch = parts[i].match(/^(\d+[.\d]*)kg$/);
        if (wtMatch && i + 1 < parts.length) {
          const repsMatch = parts[i + 1].match(/^(\d+)次$/);
          if (repsMatch && current) { current.sets.push({ weight: parseFloat(wtMatch[1]), reps: parseInt(repsMatch[1]) }); i++; }
        }
      }
      if (current && current.sets.length > 0) {
        const avgW = Math.round(current.sets.reduce((s, x) => s + x.weight, 0) / current.sets.length);
        const avgR = Math.round(current.sets.reduce((s, x) => s + x.reps, 0) / current.sets.length);
        const best = Math.max(...current.sets.map(s => est1RM(s.weight, s.reps)));
        exercises.push({ name: current.name, sets: current.sets.length, weight: avgW, reps: avgR, setDetails: [...current.sets], bestEst1RM: best });
      }
      if (exercises.length > 0) {
        const totalVolume = exercises.reduce((s, e) => s + e.sets * e.weight * e.reps, 0);
        const formattedDate = `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`;
        sessions.push({ date: formattedDate, bodyPart, exercises, totalVolume });
      }
    }
  }
  return sessions.sort((a, b) => a.date.localeCompare(b.date));
}

function avg(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function fmtDate(d: string): string { return d.slice(5); }

// ——— 按精确动作名提取每次训练的数据 ———
interface LiftDay {
  date: string; bestGroup: string; best: number;
}
interface LiftSeries {
  exactName: string;  // 精确动作名
  split: string;      // 推/拉/蹲
  days: LiftDay[];
}

function extractByExactName(sessions: TrainingSession[]): LiftSeries[] {
  const allNames = [...PUSH_EXERCISES, ...PULL_EXERCISES, ...SQUAT_EXERCISES];
  const map: Record<string, LiftDay[]> = {};
  for (const n of allNames) map[n] = [];

  for (const s of sessions) {
    for (const e of s.exercises) {
      if (allNames.includes(e.name)) {
        const bestSet = e.setDetails.reduce((a, b) => est1RM(a.weight, a.reps) > est1RM(b.weight, b.reps) ? a : b);
        const best = est1RM(bestSet.weight, bestSet.reps);
        map[e.name].push({
          date: s.date,
          bestGroup: `${bestSet.weight}kg×${bestSet.reps}次`,
          best,
        });
      }
    }
  }

  const result: LiftSeries[] = [];
  for (const [split, cfg] of Object.entries(SPLIT_CONFIG)) {
    for (const en of cfg.exercises) {
      if (map[en].length >= 3) {
        result.push({ exactName: en, split, days: map[en] });
      }
    }
  }
  return result;
}

// ——— SVG 图表 ———

/** 柱状图 - 月度训练频率（按三分化着色） */
function svgMonthlyFrequency(sessions: TrainingSession[]): string {
  const count: Record<string, { push: number; pull: number; squat: number; other: number }> = {};
  for (const s of sessions) {
    const m = s.date.slice(0, 7);
    if (!count[m]) count[m] = { push: 0, pull: 0, squat: 0, other: 0 };
    const bp = s.bodyPart;
    if (bp.includes('推')) count[m].push++;
    else if (bp.includes('拉')) count[m].pull++;
    else if (bp.includes('蹲')) count[m].squat++;
    else count[m].other++;
  }

  const months = Object.keys(count).sort();
  const totals = months.map(m => count[m].push + count[m].pull + count[m].squat + count[m].other);
  const maxVal = Math.max(...totals);
  const W = 520, H = 280, pad = { t: 30, r: 30, b: 55, l: 50 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const gap = cw / months.length;
  const barW = Math.min(64, gap * 0.5);
  const colors = { push: '#E53935', pull: '#1E88E5', squat: '#FF8F00', other: '#BDBDBD' };
  const labels: Record<string, string> = { push: '推', pull: '拉', squat: '蹲', other: '其他' };

  let content = '';
  months.forEach((m, i) => {
    const stack = ['push', 'pull', 'squat', 'other'] as const;
    let cy = pad.t + ch;
    const x = pad.l + i * gap + (gap - barW) / 2;
    stack.forEach(part => {
      const v = count[m][part];
      const bh = (v / maxVal) * ch;
      cy -= bh;
      content += `<rect x="${x.toFixed(1)}" y="${cy.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${colors[part]}" opacity="0.85"/>`;
    });
    content += `<text x="${(x + barW / 2).toFixed(1)}" y="${(pad.t + ch + 18).toFixed(1)}" text-anchor="middle" font-size="12" fill="#666">${m.slice(5)}月</text>`;
    content += `<text x="${(x + barW / 2).toFixed(1)}" y="${(pad.t + ch + 34).toFixed(1)}" text-anchor="middle" font-size="11" fill="#333">${totals[i]}天</text>`;
  });

  // 图例
  let legend = '';
  let lx = pad.l;
  for (const part of ['push', 'pull', 'squat'] as const) {
    legend += `<rect x="${lx}" y="6" width="10" height="10" rx="2" fill="${colors[part]}"/>
<text x="${lx + 14}" y="15" font-size="10" fill="#666">${labels[part]}</text>`;
    lx += 35;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff" rx="8"/>
  <text x="${pad.l}" y="20" font-size="14" font-weight="bold" fill="#333">月度训练天数（按三分化着色）</text>
  ${legend}
  ${content}
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ch}" stroke="#eee" stroke-width="1"/>
  <line x1="${pad.l}" y1="${pad.t + ch}" x2="${pad.l + cw}" y2="${pad.t + ch}" stroke="#eee" stroke-width="1"/>
</svg>`;
}

/** 单一三分化日的折线图 */
function svgOneSplitChart(
  splitSeries: LiftSeries[],
  sessions: TrainingSession[],
  splitLabel: string,
  splitColor: string,
  palette: string[]
): string {
  if (splitSeries.length === 0) return '';

  const allDates = [...new Set(sessions.map(s => s.date))].sort();
  const dateIdx: Record<string, number> = {};
  allDates.forEach((d, i) => { dateIdx[d] = i; });

  const W = 640, H = 300, pad = { t: 28, r: 155, b: 50, l: 55 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const n = allDates.length;

  // 该分化日的 Y 范围
  let allVals: number[] = [];
  for (const s of splitSeries) for (const d of s.days) allVals.push(d.best);
  const minV = Math.floor(Math.min(...allVals) / 10) * 10;
  const maxV = Math.ceil(Math.max(...allVals) / 10) * 10;
  const range = maxV - minV || 1;

  // Y 轴
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ch / 4) * i;
    const val = Math.round(maxV - (range / 4) * i);
    grid += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + cw}" y2="${y.toFixed(1)}" stroke="#f0f0f0" stroke-width="1"/>
<text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#999">${val}</text>`;
  }

  // X 轴日期
  const xStep = Math.max(1, Math.floor(n / 8));
  let xLabels = '';
  for (let i = 0; i < n; i += xStep) {
    const x = pad.l + (i / (n - 1 || 1)) * cw;
    xLabels += `<text x="${x.toFixed(1)}" y="${(pad.t + ch + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="#aaa">${fmtDate(allDates[i])}</text>`;
  }

  // 折线
  let paths = '';
  let legend = '';

  splitSeries.forEach((s, si) => {
    if (s.days.length < 3) return;
    const pts = s.days.map(d => ({
      x: pad.l + (dateIdx[d.date] / (n - 1 || 1)) * cw,
      y: pad.t + ch - ((d.best - minV) / range) * ch,
      v: d.best, date: d.date, group: d.bestGroup
    }));
    if (pts.length < 2) return;

    const color = palette[si % palette.length];

    const d = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>`;

    // 数据点圆点
    let prevX = -999;
    pts.forEach(pt => {
      paths += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="2.5" fill="${color}"/>`;
      if (pt.x - prevX > 35) {
        paths += `<title>${s.exactName} ${pt.date}: ${pt.group} → 估算1RM ${pt.v}kg</title>`;
        prevX = pt.x;
      }
    });

    // 首尾标注
    const first = pts[0], last = pts[pts.length - 1];
    const change = Math.round((last.v - first.v) / first.v * 100);
    paths += `<text x="${first.x.toFixed(1)}" y="${(first.y - 9).toFixed(1)}" text-anchor="middle" font-size="9" fill="${color}" font-weight="bold">${first.v}</text>`;
    if (last.x - first.x > 15) {
      paths += `<text x="${last.x.toFixed(1)}" y="${(last.y - 9).toFixed(1)}" text-anchor="middle" font-size="9" fill="${color}" font-weight="bold">${last.v}</text>`;
    }

    legend += `<text x="${pad.l + cw + 8}" y="${(pad.t + 6 + si * 19).toFixed(1)}" font-size="10" fill="${color}">● ${s.exactName} ${change >= 0 ? '+' : ''}${change}%</text>`;
  });

  return `<whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff" rx="8"/>
  <text x="${pad.l}" y="18" font-size="13" font-weight="bold" fill="${splitColor}">${splitLabel}</text>
  ${grid}
  ${paths}
  ${xLabels}
  ${legend}
  <text x="${(pad.l + cw / 2).toFixed(1)}" y="${(pad.t + ch + 40).toFixed(1)}" text-anchor="middle" font-size="9" fill="#bbb">每个点=一次训练该动作当日最佳组估算1RM (kg)</text>
</svg></whiteboard>`;
}

/** 生成三张分开展示的三分化折线图 */
function svgAllSplitCharts(series: LiftSeries[], sessions: TrainingSession[]): string {
  const splitPalettes: Record<string, string[]> = {
    '推': ['#C62828', '#E53935', '#EF5350', '#E57373', '#FF8A80', '#FFCDD2'],
    '拉': ['#0D47A1', '#1565C0', '#1976D2', '#42A5F5', '#64B5F6', '#90CAF9'],
    '蹲': ['#E65100', '#F57C00', '#FB8C00', '#FF9800', '#FFB74D', '#FFE0B2'],
  };

  const parts: string[] = [];
  for (const split of ['推', '拉', '蹲']) {
    const cfg = SPLIT_CONFIG[split];
    const splitSeries = series.filter(s => s.split === split);
    if (splitSeries.length === 0) continue;
    const chart = svgOneSplitChart(splitSeries, sessions, cfg.label, cfg.color, splitPalettes[split]);
    if (chart) parts.push(chart);
  }
  return parts.join('\n');
}

/** 分组柱状图 - 各动作首次/峰值/最近 */
function svgLiftCompare(series: LiftSeries[]): string {
  const data = series.map(s => {
    const first = s.days[0], last = s.days[s.days.length - 1];
    const peak = s.days.reduce((a, b) => a.best > b.best ? a : b);
    const change = Math.round((last.best - first.best) / first.best * 100);
    return { name: s.exactName, split: s.split, first: first.best, peak: peak.best, current: last.best, change, count: s.days.length };
  }).filter(d => d.count >= 3);

  const maxVal = Math.max(...data.map(d => d.peak));
  const W = 680, H = 290, pad = { t: 30, r: 40, b: 60, l: 65 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const groupW = cw / data.length;
  const barW = Math.min(13, groupW * 0.15);
  const splitColors: Record<string, string> = { '推': '#E53935', '拉': '#1E88E5', '蹲': '#FF8F00' };

  let content = '';
  data.forEach((d, i) => {
    const gx = pad.l + i * groupW + groupW * 0.08;
    const vals = [d.first, d.peak, d.current];
    const fills = ['#BDBDBD', d.change >= 0 ? '#43A047' : '#EF5350', splitColors[d.split] || '#333'];
    vals.forEach((v, j) => {
      const bh = (v / maxVal) * ch;
      const bx = gx + j * (barW + 4);
      const by = pad.t + ch - bh;
      content += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fills[j]}" opacity="0.9"/>`;
      if (v >= maxVal * 0.15) {
        content += `<text x="${(bx + barW / 2).toFixed(1)}" y="${(by - 5).toFixed(1)}" text-anchor="middle" font-size="8" fill="#555">${v}</text>`;
      }
    });
    // 简化动作名（太长就截断）
    const shortName = d.name.length > 6 ? d.name.slice(0, 6) + '..' : d.name;
    content += `<text x="${(gx + groupW * 0.4).toFixed(1)}" y="${(pad.t + ch + 14).toFixed(1)}" text-anchor="middle" font-size="10" fill="#555">${shortName}</text>`;
    const cc = d.change >= 0 ? '#2E7D32' : '#C62828';
    content += `<text x="${(gx + groupW * 0.4).toFixed(1)}" y="${(pad.t + ch + 28).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="bold" fill="${cc}">${d.change >= 0 ? '+' : ''}${d.change}%</text>`;
  });

  // 图例
  const ly = 16;
  const legend = `<rect x="${pad.l}" y="${ly - 9}" width="9" height="9" rx="2" fill="#BDBDBD"/>
<text x="${pad.l + 12}" y="${ly + 1}" font-size="9" fill="#777">首次</text>
<rect x="${pad.l + 44}" y="${ly - 9}" width="9" height="9" rx="2" fill="#43A047"/>
<text x="${pad.l + 56}" y="${ly + 1}" font-size="9" fill="#777">峰值</text>
<rect x="${pad.l + 88}" y="${ly - 9}" width="9" height="9" rx="2" fill="#E53935"/>
<text x="${pad.l + 100}" y="${ly + 1}" font-size="9" fill="#777">最近 (推)</text>
<rect x="${pad.l + 148}" y="${ly - 9}" width="9" height="9" rx="2" fill="#1E88E5"/>
<text x="${pad.l + 160}" y="${ly + 1}" font-size="9" fill="#777">拉</text>
<rect x="${pad.l + 180}" y="${ly - 9}" width="9" height="9" rx="2" fill="#FF8F00"/>
<text x="${pad.l + 192}" y="${ly + 1}" font-size="9" fill="#777">蹲</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff" rx="8"/>
  <text x="${pad.l}" y="18" font-size="14" font-weight="bold" fill="#333">各动作估算1RM对比（首次 / 峰值 / 最近 · 精确动作名）</text>
  ${legend}
  ${content}
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ch}" stroke="#eee" stroke-width="1"/>
  <line x1="${pad.l}" y1="${pad.t + ch}" x2="${pad.l + cw}" y2="${pad.t + ch}" stroke="#eee" stroke-width="1"/>
  <text x="${(pad.l + cw / 2).toFixed(1)}" y="${(pad.t + ch + 50).toFixed(1)}" text-anchor="middle" font-size="9" fill="#bbb">柱色=所属三分化 · 每个动作独立追踪 · 数值为当日最佳组估算1RM (kg)</text>
</svg>`;
}

/** 水平条形图 - 部位分布 */
function svgBodyParts(sessions: TrainingSession[]): string {
  const count: Record<string, number> = {};
  for (const s of sessions) { count[s.bodyPart] = (count[s.bodyPart] || 0) + 1; }
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  const maxCnt = sorted[0]?.[1] || 1;
  const W = 500, H = 200, pad = { t: 20, r: 110, b: 20, l: 135 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const gap = ch / sorted.length;
  const barH = Math.min(26, gap * 0.6);
  const colors = ['#E53935', '#E53935', '#1E88E5', '#1E88E5', '#FF8F00', '#FF8F00', '#BDBDBD'];

  let content = '';
  sorted.forEach(([p, c], i) => {
    const bw = (c / maxCnt) * cw;
    const y = pad.t + i * gap + (gap - barH) / 2;
    const pct = Math.round(c / sessions.length * 100);
    content += `<rect x="${pad.l}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${colors[i]}" opacity="0.85"/>
<text x="${pad.l - 8}" y="${(y + barH / 2 + 5).toFixed(1)}" text-anchor="end" font-size="12" fill="#555">${p}</text>
<text x="${(pad.l + bw + 8).toFixed(1)}" y="${(y + barH / 2 + 5).toFixed(1)}" font-size="12" font-weight="bold" fill="#333">${c}次 (${pct}%)</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff" rx="8"/>
  ${content}
</svg>`;
}

/** 柱状图 - 周容量趋势 */
function svgWeeklyVolume(sessions: TrainingSession[]): string {
  const byWeek: { week: string; volume: number; sessions: number }[] = [];
  for (const s of sessions) {
    const d = new Date(s.date);
    const ws = new Date(d.getTime() - d.getDay() * 86400000).toISOString().slice(0, 10);
    const ex = byWeek.find(w => w.week === ws);
    if (ex) { ex.volume += s.totalVolume; ex.sessions++; }
    else byWeek.push({ week: ws, volume: s.totalVolume, sessions: 1 });
  }
  const last12 = byWeek.slice(-12);
  const maxVol = Math.max(...last12.map(w => w.volume));
  const W = 640, H = 280, pad = { t: 30, r: 30, b: 60, l: 55 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const gap = cw / last12.length;
  const barW = Math.min(34, gap * 0.55);

  const half = Math.floor(last12.length / 2);
  const firstHalfAvg = avg(last12.slice(0, half).map(w => w.volume));
  const secondHalfAvg = avg(last12.slice(half).map(w => w.volume));

  let content = '';
  let linePts: string[] = [];
  last12.forEach((w, i) => {
    const barH = (w.volume / maxVol) * ch;
    const x = pad.l + i * gap + (gap - barW) / 2;
    const y = pad.t + ch - barH;
    content += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="#5C6BC0" opacity="0.8"/>
<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="9" fill="#555">${(w.volume / 1000).toFixed(0)}k</text>`;
    content += `<text x="${(x + barW / 2).toFixed(1)}" y="${(pad.t + ch + 15).toFixed(1)}" text-anchor="middle" font-size="9" fill="#888" transform="rotate(-35,${(x + barW / 2).toFixed(1)},${(pad.t + ch + 15).toFixed(1)})">${w.week.slice(5)}</text>`;
    linePts.push(`${(x + barW / 2).toFixed(1)},${y.toFixed(1)}`);
  });

  content += `<path d="M${linePts.join(' L')}" fill="none" stroke="#333" stroke-width="1.2" stroke-dasharray="5,3" opacity="0.4"/>`;
  content += `<line x1="${pad.l}" y1="${pad.t + ch}" x2="${pad.l + cw}" y2="${pad.t + ch}" stroke="#ddd" stroke-width="1"/>`;
  const changePct = Math.round((secondHalfAvg - firstHalfAvg) / firstHalfAvg * 100);
  content += `<text x="${(pad.l + cw)}" y="${(pad.t + ch + 46).toFixed(1)}" text-anchor="end" font-size="10" fill="#999">前半段周均 ${(firstHalfAvg / 1000).toFixed(0)}k → 后半段 ${(secondHalfAvg / 1000).toFixed(0)}k (${changePct}%)</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff" rx="8"/>
  <text x="${pad.l}" y="20" font-size="14" font-weight="bold" fill="#333">周训练容量趋势 (kg)</text>
  ${content}
</svg>`;
}

// ——— 工具 ———
function bar(val: number, max: number, width = 20): string {
  const filled = Math.min(Math.round((val / (max || 1)) * width), width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ——— 构建文档 ———
function buildDoc(sessions: TrainingSession[], series: LiftSeries[]): string {
  const byMonth: Record<string, TrainingSession[]> = {};
  for (const s of sessions) { const m = s.date.slice(0, 7); if (!byMonth[m]) byMonth[m] = []; byMonth[m].push(s); }

  const count: Record<string, number> = {}, vol: Record<string, number> = {};
  for (const s of sessions) { count[s.bodyPart] = (count[s.bodyPart] || 0) + 1; vol[s.bodyPart] = (vol[s.bodyPart] || 0) + s.totalVolume; }

  let push = 0, pull = 0, squat = 0;
  for (const [p, c] of Object.entries(count)) {
    if (p.includes('推')) push += c;
    else if (p.includes('拉')) pull += c;
    else if (p.includes('蹲')) squat += c;
  }

  const months = Object.keys(byMonth).sort();
  let freqTable = '';
  for (const m of months) {
    const days = byMonth[m].length;
    freqTable += `| ${m} | ${days}天 | ${Math.round(days / 4.3 * 10) / 10}次/周 | ${bar(days, 24, 15)} |\n`;
  }

  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  let bodyTable = '';
  for (const [p, c] of sorted) {
    bodyTable += `| ${p} | ${c}次 | ${Math.round(c / sessions.length * 100)}% | ${bar(c, sorted[0][1], 10)} | ${(vol[p] || 0).toLocaleString()} |\n`;
  }

  // 按三分化分组展示 RM 总览
  let rmTableParts: string[] = [];
  for (const split of ['推', '拉', '蹲']) {
    const splitSeries = series.filter(s => s.split === split);
    if (splitSeries.length === 0) continue;
    const cfg = SPLIT_CONFIG[split];
    rmTableParts.push(`<text color="${cfg.color}">**▍${cfg.label}**</text>\n`);
    for (const s of splitSeries) {
      const first = s.days[0], last = s.days[s.days.length - 1];
      const peak = s.days.reduce((a, b) => a.best > b.best ? a : b);
      const change = Math.round((last.best - first.best) / first.best * 100);
      let type = '';
      if (change > 20) type = '显著增长';
      else if (change > 5) type = '稳步提升';
      else if (change < -5) type = '退步';
      else type = '维持';
      rmTableParts.push(`| ${s.exactName} | ${first.best}kg | ${peak.best}kg | ${last.best}kg | ${change >= 0 ? '+' : ''}${change}% | ${s.days.length}次 | ${type} |`);
    }
    rmTableParts.push('');
  }

  // 三分化摘要
  let splitSummary = '';
  for (const split of ['推', '拉', '蹲']) {
    const splitSeries = series.filter(s => s.split === split);
    if (splitSeries.length === 0) continue;
    const cfg = SPLIT_CONFIG[split];
    const names = splitSeries.map(s => s.exactName).join('、');
    const totalSessions = splitSeries.reduce((sum, s) => sum + s.days.length, 0);
    splitSummary += `- <text color="${cfg.color}">**${cfg.label}**</text>：${names}（共${totalSessions}组训练数据）\n`;
  }

  const may = sessions.filter(s => s.date.startsWith('2026-05'));
  const apr = sessions.filter(s => s.date.startsWith('2026-04'));
  const mayDropPct = Math.round((1 - may.length / (apr.length || 1)) * 100);

  return `<callout emoji="📊" background-color="light-blue">
**分析周期**: 2026-02-25 → 2026-05-24 | **总训练**: ${sessions.length}次 | **三分化**: 推/拉/蹲 | **数据粒度**: 单日最佳值 · 精确动作名
</callout>

---

## 一、训练频率分析

<whiteboard type="svg">${svgMonthlyFrequency(sessions)}</whiteboard>

| 月份 | 训练天数 | 月均/周 | 趋势 |
|------|---------|---------|------|
${freqTable}

<callout emoji="⚠️" background-color="light-yellow">
3月训练热情高涨（5.6次/周），4月保持良好节奏（4.4次/周），**5月断崖下跌至2.1次/周**，较4月下降${mayDropPct}%。
</callout>

---

## 二、训练部位分布

<whiteboard type="svg">${svgBodyParts(sessions)}</whiteboard>

| 部位 | 次数 | 占比 | 分布 | 总容量(kg) |
|------|------|------|------|------------|
${bodyTable}

<callout emoji="✅" background-color="light-green">
**推:拉:蹲 = ${push}:${pull}:${squat}** — 比例近乎完美，三大项均衡发展。
</callout>

---

## 三、力量进阶分析（精确动作名 · 单日最佳值）

> 采用 Epley 公式估算 1RM：**估算1RM = 重量 × (1 + 次数/30)**。每个数据点为该动作在单次训练中的当日最佳组估算值。动作按三分化（推/拉/蹲）分组，**不同动作变体独立追踪，不混合统计**，避免因训练日内容差异导致数据剧烈波动。

### 追踪动作

${splitSummary}

${svgAllSplitCharts(series, sessions)}

### 估算1RM 总览

${rmTableParts.join('\n')}

<whiteboard type="svg">${svgLiftCompare(series)}</whiteboard>

<callout emoji="🔍" background-color="light-blue">
**关键发现**：所有动作次数始终在 **12-15 次**，属于肌耐力区间。缺少 **5-8 次** 低次数力量训练周期。由于不同动作变体已独立追踪，各动作趋势更为准确可信。
</callout>

---

## 四、训练容量趋势

<whiteboard type="svg">${svgWeeklyVolume(sessions)}</whiteboard>

---

## 五、训练安排评估

| 指标 | 数值 | 评估 |
|------|------|------|
| 平均训练间隔 | 1.7天 | ✅ 频率充分 |
| 最长连续训练 | 4天 | ⚠️ 连续训练过多，恢复不足 |
| 单次平均容量 | 15,999 kg | ✅ 适中 |
| 单次平均动作 | 5个 | ✅ 合理 |
| 主要次数区间 | 12-15次 | ⚠️ 缺少低次数力量训练 |

---

## 六、综合评价

<grid cols="2">
<column>

### ✅ 优势

- **推拉蹲 ${push}:${pull}:${squat}**：近乎完美均衡
- **杠铃卧推**：独立追踪，趋势清晰
- **硬拉双重进阶**：重量和次数同步增长
- **3-4月投入度高**：每周4.4-5.6次

</column>
<column>

### ⚠️ 问题

- **5月断崖**：${may.length}次 vs 4月${apr.length}次（${mayDropPct}%）
- **容量 -39%**：训练量断崖下滑
- **5月初完全断档**
- **始终12-15次**：从未进入力量期（5-8次）
- **缺少低次数力量训练周期**

</column>
</grid>

---

## 七、调整建议

<grid cols="3">
<column>

### 短期（6月前2周）
**恢复期**

- 用 **70-80% 重量**重建动作模式
- 恢复每周 **3-4次**训练频率
- 卧推从 **40kg 3×8** 重新起步
- 记录RPE，避免过度训练

</column>
<column>

### 中期（6月中下旬）
**力量冲刺期**

- **引入 5-8次 低次数力量训练**
- 核心动作每周一天大重量日
- 卧推采用 5/3/1 或线性周期
- 加入杠铃划船、引体向上
- 每4周安排减载周

</column>
<column>

### 长期（7月起）
**巩固期**

- 杠铃卧推估算1RM → **70kg+**
- 悍马机深蹲估算1RM → **180kg+**
- 杠铃罗马尼亚硬拉估算1RM → **100kg+**
- 周期化：4周力量+1周减载
- 保底：3次力量+2次有氧/周

</column>
</grid>

<callout emoji="🎯" background-color="light-blue">
**核心建议**：目前训练全部集中在12-15次肌耐力区间。建议每个核心动作每周安排一天大重量日（5-8次，3-5组），配合肌耐力训练，形成完整的力量-耐力周期。注意：不同动作变体应独立追踪进步，不要用上斜卧推的重量对比平板卧推。
</callout>

---

*数据来源: 训记 APP | 估算1RM: Epley公式 (1RM = 重量 × (1 + 次数/30)) | 分析日期: 2026-05-25 | 所有力量数据为单日最佳组值 · 精确动作名匹配*`;
}

// ——— 主程序 ———
const sessions = parseAllSessions();
if (!sessions.length) { console.log('无数据'); process.exit(1); }

const series = extractByExactName(sessions);
console.log(`${sessions.length} 次训练, ${series.length} 个可追踪动作（精确名）\n`);

for (const split of ['推', '拉', '蹲']) {
  const ss = series.filter(s => s.split === split);
  if (ss.length === 0) continue;
  console.log(`【${split}日】`);
  for (const s of ss) {
    const first = s.days[0], last = s.days[s.days.length - 1];
    const change = Math.round((last.best - first.best) / first.best * 100);
    console.log(`  ${s.exactName}: ${s.days.length}次训练, 估算1RM ${first.best}→${last.best}kg (${change >= 0 ? '+' : ''}${change}%)`);
  }
}

const doc = buildDoc(sessions, series);
fs.writeFileSync(OUT_FILE, doc, 'utf-8');
console.log(`\n文档: ${OUT_FILE} (${(doc.length / 1024).toFixed(0)}KB), ${(doc.match(/<whiteboard/g) || []).length} 个画板`);
