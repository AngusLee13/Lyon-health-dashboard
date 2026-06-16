import fs from 'fs';
import path from 'path';

const dir = path.resolve(__dirname, '../.cache/xunji');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

function est1RM(w: number, r: number) { return r <= 1 ? w : Math.round(w * (1 + r / 30)); }

// 收集所有出现的动作名 → 用于精确匹配
const allExNames = new Set<string>();
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  for (const item of raw.items || []) {
    const parts: string[] = item.raw.split(',');
    for (let i = 5; i < parts.length; i++) {
      const m = parts[i].match(/^(\d+)\.(?!\d+kg)(.+)/);
      if (m) allExNames.add(m[2]);
    }
  }
}

// 分类每个动作属于哪个分化日
const pushEx: string[] = [];  // 推
const pullEx: string[] = [];  // 拉
const squatEx: string[] = []; // 蹲

// 关键词归类
for (const name of allExNames) {
  const n = name.toLowerCase();
  if (n.includes('卧推') || n.includes('推举') || n.includes('臂屈伸') || n.includes('飞鸟') || n.includes('推胸') || n.includes('夹胸') || n.includes('三头') || n.includes('前平举') || n.includes('侧平举')) {
    pushEx.push(name);
  } else if (n.includes('划船') || n.includes('弯举') || n.includes('下拉') || n.includes('引体') || n.includes('二头') || n.includes('面拉') || n.includes('后束')) {
    pullEx.push(name);
  } else if (n.includes('深蹲') || n.includes('硬拉') || n.includes('腿') || n.includes('臀') || n.includes('举重') || n.includes('弓步') || n.includes('小腿')) {
    squatEx.push(name);
  }
}

console.log('=== 推日动作 ===');
pushEx.forEach(n => console.log('  ' + n));
console.log('\n=== 拉日动作 ===');
pullEx.forEach(n => console.log('  ' + n));
console.log('\n=== 蹲日动作 ===');
squatEx.forEach(n => console.log('  ' + n));
