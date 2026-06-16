/**
 * 种子数据注入脚本 — 绕过 HTTP 层直接注入（避免编码问题）
 * 运行: npx tsx scripts/seedSentinel.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { RawArticle } from '../src/sentinel/types';
import { runAnalysisPipeline } from '../src/sentinel/analyzer';

const seedPath = path.resolve(__dirname, '../.data/sentinel/seed.json');
const raw = fs.readFileSync(seedPath, 'utf-8');
const { articles } = JSON.parse(raw) as { articles: RawArticle[] };

console.log(`加载种子数据: ${articles.length} 篇`);

// 检查编码
for (const a of articles) {
  console.log(`  ✓ ${a.title.substring(0, 60)}`);
}

runAnalysisPipeline(articles)
  .then(({ analyzed, errors }) => {
    console.log(`\n分析完成: ${analyzed.length} 篇入库, ${errors.length} 个错误`);
    for (const a of analyzed) {
      console.log(`  [${a.sentiment}] [${a.riskLevel}级] ${a.title.substring(0, 50)}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('注入失败:', err);
    process.exit(1);
  });
