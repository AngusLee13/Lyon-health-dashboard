/**
 * 启动前安全校验模块
 * 在应用启动时检查所有凭证和配置的有效性
 */
import fs from 'fs';
import path from 'path';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** 检查值是否为占位符（未配置） */
function isPlaceholder(value: string): boolean {
  if (!value || value.trim() === '') return true;
  const lower = value.toLowerCase();
  // 常见的占位符模式
  if (lower.startsWith('xxx') || lower.startsWith('your_')) return true;
  if (lower === 'placeholder' || lower === 'changeme' || lower === 'secret') return true;
  // 示例密钥模式
  if (/^cli_placeholder/.test(value)) return true;
  if (/^sk-[a-z]*_?placeholder/i.test(value)) return true;
  return false;
}

/** 校验 .env 环境变量 */
export function validateEnv(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 必需的环境变量
  const required = [
    { key: 'FEISHU_APP_ID', label: '飞书应用 ID' },
    { key: 'FEISHU_APP_SECRET', label: '飞书应用密钥' },
    { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API Key' },
  ];

  for (const { key, label } of required) {
    const value = process.env[key];
    if (!value) {
      errors.push(`❌ 缺少必需的环境变量 ${key}（${label}）`);
    } else if (isPlaceholder(value)) {
      errors.push(`❌ ${key} 仍为占位值，请在 .env 中配置真实的${label}`);
    }
  }

  // 可选的但有默认值的变量
  const optional = [
    { key: 'REPORT_CHAT_ID', label: '日报推送群聊 ID' },
  ];
  for (const { key, label } of optional) {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      warnings.push(`⚠️ 未配置 ${key}（${label}），相关功能将不可用`);
    }
  }

  // 检查 .env 文件权限（Windows 上 NTFS 权限）
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    try {
      fs.accessSync(envPath, fs.constants.R_OK);
    } catch {
      warnings.push('⚠️ .env 文件可能权限过宽，建议仅当前用户可读');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** 校验 bots.json 配置文件 */
export function validateBotsConfig(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const configPath = path.resolve(__dirname, '../../bots.json');

  // 文件存在性检查
  if (!fs.existsSync(configPath)) {
    errors.push('❌ 缺少 bots.json 配置文件，请从 bots.json.example 复制并填写');
    return { valid: false, errors, warnings };
  }

  // JSON 格式检查
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: any) {
    errors.push(`❌ 无法读取 bots.json: ${err.message}`);
    return { valid: false, errors, warnings };
  }

  // BOM 检查
  if (raw.charCodeAt(0) === 0xFEFF) {
    errors.push('❌ bots.json 包含 UTF-8 BOM，请用 UTF-8 without BOM 重新保存');
    errors.push('   修复方法：用 VS Code 打开 → 右下角点击编码 → 选择"UTF-8 编码保存"');
  }

  // JSON 解析检查
  let config: any;
  try {
    config = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (err: any) {
    errors.push(`❌ bots.json JSON 格式无效: ${err.message}`);
    return { valid: false, errors, warnings };
  }

  // 结构检查
  if (!config || typeof config !== 'object') {
    errors.push('❌ bots.json 根节点必须是对象');
    return { valid: false, errors, warnings };
  }
  if (!Array.isArray(config.bots)) {
    errors.push('❌ bots.json 缺少 bots 数组');
    return { valid: false, errors, warnings };
  }
  if (config.bots.length === 0) {
    errors.push('❌ bots.json 中至少需要配置一个 Bot');
    return { valid: false, errors, warnings };
  }

  // 逐个 Bot 检查
  let hasRouter = false;
  let hasValid = false;
  for (const bot of config.bots) {
    if (!bot.id) {
      errors.push(`❌ Bot 缺少 id 字段: ${JSON.stringify(bot.name || '(无名)')}`);
      continue;
    }
    if (!bot.appId) {
      errors.push(`❌ Bot "${bot.id}" 缺少 appId`);
    }
    if (!bot.appSecret) {
      errors.push(`❌ Bot "${bot.id}" 缺少 appSecret`);
    }

    // 检查是否有有效的凭据（非占位符、非空）
    const hasCreds = bot.appId && bot.appSecret
      && !isPlaceholder(bot.appId)
      && !isPlaceholder(bot.appSecret);

    if (hasCreds) {
      hasValid = true;
      if (bot.role === 'router') hasRouter = true;
    } else if (bot.enabled) {
      warnings.push(`⚠️ Bot "${bot.id}" (${bot.name || ''}) 已启用但凭据为占位值，将作为虚拟 Agent 运行`);
    }
  }

  if (!hasValid) {
    errors.push('❌ 所有 Bot 的凭据都是占位值，至少需要配置一个有效的飞书应用');
  }
  if (!hasRouter) {
    warnings.push('⚠️ 没有配置有效的路由 Bot（role: "router"），系统将使用第一个可用 Bot');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** 运行所有启动前校验，打印结果并返回是否通过 */
export function runStartupValidation(): boolean {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔒 启动前安全校验');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const envResult = validateEnv();
  const botsResult = validateBotsConfig();

  const allErrors = [...envResult.errors, ...botsResult.errors];
  const allWarnings = [...envResult.warnings, ...botsResult.warnings];

  // 打印错误
  for (const err of allErrors) {
    console.error(err);
  }
  // 打印警告
  for (const warn of allWarnings) {
    console.warn(warn);
  }

  if (allErrors.length === 0) {
    console.log('✅ 安全校验通过');
    if (allWarnings.length > 0) {
      console.log(`   ${allWarnings.length} 条警告（非致命）`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return true;
  } else {
    console.error(`\n❌ 安全校验失败：${allErrors.length} 个错误，${allWarnings.length} 条警告`);
    console.error('   请修复以上错误后重新启动');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return false;
  }
}
