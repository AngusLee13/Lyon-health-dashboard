import fs from 'fs'; import path from 'path';
const dir = path.resolve(__dirname, '../.cache/xunji');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const cnt: Record<string, number> = {};
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  for (const item of raw.items || []) {
    const parts: string[] = item.raw.split(',');
    for (let i = 5; i < parts.length; i++) {
      const m = parts[i].match(/^(\d+)\.(?!\d+kg)(.+)/);
      if (m) cnt[m[2]] = (cnt[m[2]] || 0) + 1;
    }
  }
}
const sorted = Object.entries(cnt).sort((a,b) => b[1] - a[1]);
console.log('TOP 20 动作名:');
sorted.slice(0,20).forEach(([n,c]) => console.log(`  ${c}次  ${n}`));
