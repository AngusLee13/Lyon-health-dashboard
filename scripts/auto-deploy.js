// 每晚自动重新生成静态看板并推送到 GitHub Pages
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/** 静默执行命令——零窗口闪现 */
function run(cmd, args, opts = {}) {
  console.log('[deploy] ' + cmd + ' ' + (args||[]).join(' '));
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    windowsHide: true,
    shell: false,          // 不经过cmd.exe，彻底消除窗口
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    ...opts,
  });
  if (r.error) throw r.error;
  if (r.stderr) console.error(r.stderr.trim());
  return r.stdout || '';
}

console.log('[deploy] ========== ' + new Date().toLocaleString('zh-CN') + ' ==========');

// 0. 先编译 TypeScript，确保 dist/ 是最新的（generate-standalone-data 依赖 dist/）
console.log('[deploy] 编译 TypeScript...');
try {
  run('node', [path.join(ROOT, 'node_modules', '.bin', 'tsc')]);
  console.log('[deploy] TypeScript 编译成功');
} catch (e) {
  console.error('[deploy] TypeScript 编译失败: ' + e.message);
  console.error('[deploy] 将继续使用现有 dist/ 产物（可能不是最新）');
}

// 0.5 Git 认证：优先使用 GH_TOKEN，否则使用 Windows 凭据管理器
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (token) {
  try {
    run('git', ['remote', 'set-url', 'origin', 'https://' + token + '@github.com/AngusLee13/Lyon-health-dashboard.git']);
    console.log('[deploy] 使用 GH_TOKEN 认证');
  } catch (e) {
    console.error('[deploy] 设置 remote 失败: ' + e.message);
  }
} else {
  console.log('[deploy] 使用 Windows 凭据管理器认证');
}

// 1. 生成健康数据 JSON
console.log('[deploy] 生成健康数据...');
require('./generate-standalone-data');

// 2. 基于原始看板 HTML 嵌入数据
console.log('[deploy] 嵌入数据到看板...');
require('./build-offline-dashboard');

// 3. 确认 docs/index.html 已更新
const dst = path.join(ROOT, 'docs', 'index.html');
console.log('[deploy] docs/index.html: ' + (fs.statSync(dst).size / 1024).toFixed(1) + ' KB');

// 4. Git 操作
try {
  const status = run('git', ['status', '--porcelain', 'docs/', 'dashboard/standalone-data.json', 'dashboard/standalone.html']);
  if (!status.trim()) {
    console.log('[deploy] 数据无变化，跳过提交');
    restoreRemote();
    process.exit(0);
  }

  run('git', ['add', 'docs/', 'dashboard/standalone-data.json', 'dashboard/standalone.html']);
  const date = new Date().toISOString().slice(0, 10);
  run('git', ['commit', '-m', 'auto update: ' + date]);
  run('git', ['push', 'origin', 'master']);

  console.log('[deploy] 推送成功!');
} catch (e) {
  console.error('[deploy] Git 操作失败: ' + e.message);
} finally {
  restoreRemote();
}

function restoreRemote() {
  if (token) {
    try {
      run('git', ['remote', 'set-url', 'origin', 'https://github.com/AngusLee13/Lyon-health-dashboard.git']);
    } catch (_) {}
  }
}

console.log('[deploy] ========== 完成 ==========');
