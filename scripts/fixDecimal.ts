/**
 * 历史数据修复脚本：将所有营养成分数值四舍五入到小数点后1位
 * 解决 AI 返回的浮点数如 76.89999999999999 的问题
 *
 * 用法：npx ts-node scripts/fixDecimal.ts
 */
import fs from 'fs';
import path from 'path';

const HEALTH_DIR = path.resolve(__dirname, '../.data/health');
const BACKUP_DIR = path.join(HEALTH_DIR, '.fix-backup');

// 创建备份目录
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/** 递归遍历对象，将所有数字四舍五入到小数点后1位 */
function roundAllNumbers(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number') {
    // 跳过整数（组数、次数、步数、时间戳等）
    if (Number.isInteger(obj)) return obj;
    return Math.round(obj * 10) / 10;
  }
  if (Array.isArray(obj)) {
    return obj.map(roundAllNumbers);
  }
  if (typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // 跳过时间戳和 ID 字段（不需要取整）
      if (key === 'createdAt' || key === 'updatedAt' || key === 'message_id' || key === 'id') {
        result[key] = value;
        continue;
      }
      result[key] = roundAllNumbers(value);
    }
    return result;
  }
  return obj;
}

/** 处理单个文件 */
function fixFile(filePath: string): { file: string; changed: number } {
  const fileName = path.basename(filePath);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const original = JSON.parse(raw);

  // 备份原始文件
  const backupPath = path.join(BACKUP_DIR, fileName);
  fs.writeFileSync(backupPath, raw, 'utf-8');

  // 修复
  const fixed = roundAllNumbers(original);
  const newRaw = JSON.stringify(fixed, null, 2);

  // 统计修改数量
  let changed = 0;
  if (raw !== newRaw + '\n' && raw !== newRaw) {
    changed = 1;
  }

  if (changed > 0) {
    fs.writeFileSync(filePath, newRaw + '\n', 'utf-8');
  } else {
    // 没有变化，删除备份
    fs.unlinkSync(backupPath);
  }

  return { file: fileName, changed };
}

// 主流程
console.log('=== 历史健康数据小数修复 ===\n');

const files = fs.readdirSync(HEALTH_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('foods'));

let fixedCount = 0;
const results: { file: string; changed: number }[] = [];

for (const file of files) {
  const filePath = path.join(HEALTH_DIR, file);
  try {
    const result = fixFile(filePath);
    results.push(result);
    if (result.changed > 0) {
      fixedCount++;
      console.log(`  ✅ ${result.file} — 已修复`);
    } else {
      console.log(`  ⏭️ ${result.file} — 无需修复`);
    }
  } catch (err: any) {
    console.log(`  ❌ ${file} — 错误: ${err.message}`);
  }
}

// 也处理 foods.json
const foodsPath = path.join(HEALTH_DIR, 'foods.json');
if (fs.existsSync(foodsPath)) {
  try {
    const result = fixFile(foodsPath);
    results.push(result);
    if (result.changed > 0) {
      fixedCount++;
      console.log(`  ✅ foods.json — 已修复`);
    } else {
      console.log(`  ⏭️ foods.json — 无需修复`);
    }
  } catch (err: any) {
    console.log(`  ❌ foods.json — 错误: ${err.message}`);
  }
}

console.log(`\n总计: ${files.length + 1} 个文件，修复 ${fixedCount} 个`);
if (fixedCount > 0) {
  console.log(`备份保存在: ${BACKUP_DIR}`);
}
