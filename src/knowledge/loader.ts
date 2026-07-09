/**
 * Obsidian 知识加载器
 *
 * 从 Obsidian Vault 中读取知识文件，自动注入到对应 agent 的 systemPrompt 中。
 * 约定：bots.json 中每个 bot 可配置 obsidianKnowledgePaths，指向 Vault 中的知识目录。
 *
 * 设计原则：
 *   1. 静态知识（营养学、方法论等）→ 启动时完整注入 systemPrompt
 *   2. 动态知识（日报、偏好变化）→ 通过 memory bridge 同步
 *   3. Obsidian 是知识管理的唯一源头（single source of truth）
 */

import fs from 'fs';
import path from 'path';

/** Obsidian Vault 根目录 */
const OBSIDIAN_VAULT = path.resolve(
  process.env.OBSIDIAN_VAULT || 'C:/Users/WINDOWS/Documents/Obsidian Vault'
);

/** 需跳过的文件名模式（索引文件、模板等） */
const SKIP_FILES = ['00-知识索引.md', '模板.md', 'template.md'];

/** 单个知识文件 */
export interface KnowledgeFile {
  /** 相对于 Vault 的路径 */
  relativePath: string;
  /** 相对于 knowledge 目录的路径，用作标题 */
  displayPath: string;
  /** Markdown 内容 */
  content: string;
  /** 文件大小（字节） */
  size: number;
}

/** 加载结果 */
export interface KnowledgeBundle {
  /** 拼接后的知识正文，可直接追加到 systemPrompt */
  text: string;
  /** 加载的文件列表 */
  files: KnowledgeFile[];
  /** 总字符数 */
  totalChars: number;
}

/**
 * 递归读取目录中的所有 .md 文件
 */
function readMdFiles(dir: string, basePath: string): KnowledgeFile[] {
  if (!fs.existsSync(dir)) {
    console.warn(`[知识加载] 目录不存在: ${dir}`);
    return [];
  }

  const results: KnowledgeFile[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readMdFiles(fullPath, basePath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // 跳过索引文件和模板
      if (SKIP_FILES.some(skip => entry.name.includes(skip.replace('.md', '')) && entry.name.includes('索引'))) {
        console.log(`[知识加载] 跳过索引文件: ${entry.name}`);
        continue;
      }
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relativePath = path.relative(OBSIDIAN_VAULT, fullPath);
        const displayPath = path.relative(basePath, fullPath).replace(/\\/g, ' › ').replace('.md', '');
        results.push({
          relativePath,
          displayPath,
          content,
          size: Buffer.byteLength(content, 'utf-8'),
        });
      } catch (err: any) {
        console.warn(`[知识加载] 读取失败: ${fullPath}: ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * 从 Obsidian Vault 中加载指定路径的知识文件
 * @param vaultPaths - 相对于 Vault 的路径列表，如 ['knowledge/sports-nutrition']
 * @param maxTotalChars - 最大总字符数限制（防止 systemPrompt 过长），默认 30000
 */
export function loadObsidianKnowledge(
  vaultPaths: string[],
  maxTotalChars: number = 30000
): KnowledgeBundle {
  const allFiles: KnowledgeFile[] = [];

  for (const vaultPath of vaultPaths) {
    const fullPath = path.join(OBSIDIAN_VAULT, vaultPath);
    const files = readMdFiles(fullPath, fullPath);
    allFiles.push(...files);
  }

  // 按路径排序，保证确定性
  allFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  let totalChars = 0;
  let truncated = false;
  const includedFiles: KnowledgeFile[] = [];

  for (const file of allFiles) {
    if (totalChars + file.content.length > maxTotalChars) {
      truncated = true;
      break;
    }
    totalChars += file.content.length;
    includedFiles.push(file);
  }

  // 构建知识正文
  const sections = includedFiles.map(f => {
    const header = `### ${f.displayPath}`;
    return `${header}\n${f.content}`;
  });

  const header = [
    '---',
    '## 📚 知识库（来自 Obsidian Vault，启动时自动加载）',
    `> 共加载 ${includedFiles.length} 个知识文件，${totalChars} 字符`,
    truncated ? `> ⚠️ 超出 ${maxTotalChars} 字符限制，部分文件未加载` : '',
    '---',
    '',
  ].filter(Boolean).join('\n');

  const text = header + sections.join('\n\n');

  console.log(
    `[知识加载] ${vaultPaths.join(', ')} → ${includedFiles.length} 个文件, ` +
    `${totalChars} 字符 (${allFiles.length - includedFiles.length} 个跳过)`
  );

  return { text, files: includedFiles, totalChars };
}

/**
 * 加载指定 agent role 对应的知识
 * @param role - agent role，对应 knowledge/{role}/ 目录
 */
export function loadKnowledgeForRole(role: string, vaultPaths?: string[]): string {
  // 如果显式指定了路径，使用指定路径；否则按约定查找 knowledge/{role}/
  const paths = vaultPaths && vaultPaths.length > 0
    ? vaultPaths
    : [`knowledge/${role}`];

  try {
    const bundle = loadObsidianKnowledge(paths);
    if (bundle.files.length === 0) {
      console.log(`[知识加载] role="${role}" 未找到知识文件`);
      return '';
    }
    return bundle.text;
  } catch (err: any) {
    console.error(`[知识加载] role="${role}" 加载失败: ${err.message}`);
    return '';
  }
}
