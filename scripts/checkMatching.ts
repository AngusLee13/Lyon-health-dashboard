import fs from 'fs';
import path from 'path';

const dir = path.resolve(__dirname, '../.cache/xunji');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const matched = new Set<string>();

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  for (const item of raw.items || []) {
    const parts: string[] = item.raw.split(',');
    for (let i = 5; i < parts.length; i++) {
      const m = parts[i].match(/^(\d+)\.(?!\d+kg)(.+)/);
      if (m && m[2].includes('卧推')) matched.add(m[2]);
    }
  }
}

console.log('匹配到"卧推"的动作名:');
[...matched].sort().forEach(n => console.log('  -', n));

// Also check 硬拉
const dl = new Set<string>();
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  for (const item of raw.items || []) {
    const parts: string[] = item.raw.split(',');
    for (let i = 5; i < parts.length; i++) {
      const m = parts[i].match(/^(\d+)\.(?!\d+kg)(.+)/);
      if (m && (m[2].includes('硬拉') || m[2].includes('划船') || m[2].includes('引体'))) dl.add(m[2]);
    }
  }
}
console.log('\n拉类复合动作:');
[...dl].sort().forEach(n => console.log('  -', n));
