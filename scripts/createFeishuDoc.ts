import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const content = fs.readFileSync(
  path.resolve(__dirname, '../reports/feishu-doc-simple.md'),
  'utf-8'
);

// 用 node 生成命令参数数组，避免 shell 注入和转义问题
const args = [
  'docs', '+create',
  '--api-version', 'v2',
  '--as', 'bot',
  '--title', '3个月训练分析报告（2026.02-2026.05）',
  '--markdown', content,
];

try {
  const stdout = execFileSync('C:\\Users\\WINDOWS\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 60000,
  });
  console.log(stdout);
} catch (err: any) {
  console.error('STDERR:', err.stderr?.toString() || err.message);
  if (err.stdout) console.log('STDOUT:', err.stdout.toString());
}
