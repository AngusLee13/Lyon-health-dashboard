import { fetchTrains, TrainResult } from '../src/xunji/client';
import { config } from '../src/config';

/** 生成日期范围 */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function main() {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 3);
  const start = startDate.toISOString().slice(0, 10);

  console.log(`批量拉取训记数据: ${start} → ${endDate}`);
  const dates = dateRange(start, endDate);
  const results: { date: string; items: number }[] = [];

  for (const date of dates) {
    try {
      const result: TrainResult = await fetchTrains(date, config.xunji, true);
      if (result.items.length > 0) {
        results.push({ date, items: result.items.length });
        process.stdout.write(`✅ ${date}: ${result.items.length}条训练记录\n`);
      }
    } catch (err: any) {
      process.stdout.write(`❌ ${date}: ${err.message}\n`);
    }
    // 延迟避免请求过快
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n共 ${results.length} 天有训练数据`);
  // 输出有数据日期的JSON方便后续分析
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
