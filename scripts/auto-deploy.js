// 每晚自动重新生成静态看板并推送到 GitHub Pages
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function run(cmd, opts = {}) {
  console.log('[deploy] ' + cmd);
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', ...opts });
}

console.log('[deploy] ========== ' + new Date().toLocaleString('zh-CN') + ' ==========');

// 0. 确保 git 有 token 认证
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('[deploy] 缺少 GH_TOKEN 环境变量，跳过推送');
  process.exit(1);
}

// 设置带 token 的 remote
try {
  run('git remote set-url origin https://' + token + '@github.com/AngusLee13/Lyon-health-dashboard.git');
} catch (e) {
  console.error('[deploy] 设置 remote 失败: ' + e.message);
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

// 3. Git 操作
try {
  const status = run('git status --porcelain docs/');
  if (!status.trim()) {
    console.log('[deploy] 数据无变化，跳过提交');
    // 恢复不带 token 的 remote
    run('git remote set-url origin https://github.com/AngusLee13/Lyon-health-dashboard.git');
    process.exit(0);
  }

  run('git add docs/');
  const date = new Date().toISOString().slice(0, 10);
  run('git commit -m "auto update: ' + date + '"');
  run('git push origin master');

  console.log('[deploy] 推送成功!');
} catch (e) {
  console.error('[deploy] Git 操作失败: ' + e.message);
} finally {
  // 恢复不带 token 的 remote（避免 token 泄露到 git config）
  try {
    run('git remote set-url origin https://github.com/AngusLee13/Lyon-health-dashboard.git');
  } catch (_) {}
}

console.log('[deploy] ========== 完成 ==========');
