// 将 Lark-flavored Markdown 转换为飞书 Docx v2 富文本块
const axios = require('axios');
const fs = require('fs');

const APP_ID = 'cli_aa99449da1bc1cb5';
const APP_SECRET = 'DbwA9I1XS00PnnTv8TTcseSowhRZnKLf';
const CHAT_ID = 'oc_a1301c159a9e49a37354b7524c1225d1';

// ─── 颜色映射 ───
const COLORS = {
  red: 1, orange: 2, yellow: 3, green: 4, blue: 5, purple: 6, gray: 7,
  'light-red': 6, 'light-orange': 2, 'light-yellow': 3, 'light-green': 4,
  'light-blue': 5, 'light-purple': 6,
};

// ─── 文本解析：提取粗体、颜色等内联样式 ───
function parseInline(text) {
  const elements = [];
  let remaining = text;
  while (remaining.length > 0) {
    // 匹配 **粗体**
    let m = remaining.match(/^\*\*(.+?)\*\*/);
    if (m) {
      elements.push({ text_run: { content: m[1], text_style: { bold: true } } });
      remaining = remaining.slice(m[0].length);
      continue;
    }
    // 匹配 <text color="red">...</text>
    m = remaining.match(/^<text color="(\w[\w-]*)">(.+?)<\/text>/);
    if (m) {
      const colorId = COLORS[m[1]] || 1;
      elements.push({ text_run: { content: m[2], text_style: { text_color: colorId } } });
      remaining = remaining.slice(m[0].length);
      continue;
    }
    // 普通文本（到下一个特殊标记前）
    m = remaining.match(/^(.+?)(?=\*\*|<text|$)/);
    if (m && m[1]) {
      elements.push({ text_run: { content: m[1], text_style: {} } });
      remaining = remaining.slice(m[1].length);
    } else if (m && !m[1]) {
      remaining = remaining.slice(m[0].length);
    } else {
      // 剩余纯文本
      if (remaining) elements.push({ text_run: { content: remaining, text_style: {} } });
      break;
    }
  }
  return elements;
}

// ─── 解析单行 Markdown 为 block ───
function parseBlock(line) {
  const trimmed = line.trim();
  if (!trimmed) return { block_type: 2, text: { elements: [{ text_run: { content: '', text_style: {} } }], style: {} } };

  // 分割线
  if (trimmed === '---') return { block_type: 21 };

  // 标题
  let m = trimmed.match(/^#### (.+)/);
  if (m) return { block_type: 6, heading4: { elements: parseInline(m[1]), style: {} } };
  m = trimmed.match(/^### (.+)/);
  if (m) return { block_type: 5, heading3: { elements: parseInline(m[1]), style: {} } };
  m = trimmed.match(/^## (.+)/);
  if (m) return { block_type: 4, heading2: { elements: parseInline(m[1]), style: {} } };
  m = trimmed.match(/^# (.+)/);
  if (m) return { block_type: 3, heading1: { elements: parseInline(m[1]), style: {} } };

  // 引用
  if (trimmed.startsWith('> ')) {
    return { block_type: 2, text: { elements: parseInline('📌 ' + trimmed.slice(2)), style: {} } };
  }

  // 列表项
  if (trimmed.match(/^[\-\*] /)) {
    const content = trimmed.replace(/^[\-\*] /, '• ');
    return { block_type: 2, text: { elements: parseInline(content), style: {} } };
  }
  if (trimmed.match(/^\d+\. /)) {
    return { block_type: 2, text: { elements: parseInline(trimmed), style: {} } };
  }

  // 普通段落
  return { block_type: 2, text: { elements: parseInline(trimmed), style: {} } };
}

// ─── 主流程 ───
async function main() {
  // 1. 获取 token
  const tokenResp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: APP_ID, app_secret: APP_SECRET
  });
  const token = tokenResp.data.tenant_access_token;
  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

  // 2. 创建新文档
  const docResp = await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents',
    { title: '📊 6月1-7日 · 健康周报' }, { headers });
  const docId = docResp.data.data.document.document_id;
  console.log('文档已创建:', docId);

  // 3. 读取 markdown 并转换为 blocks
  const md = fs.readFileSync('reports/weekly/2026-06-01-07-feishu.md', 'utf-8');
  const lines = md.split('\n');
  const blocks = [];

  // 处理 callout/grid/table 等容器块
  let inCallout = false, inGrid = false, inTable = false;
  let calloutLines = [], gridLines = [], tableLines = [];

  for (const line of lines) {
    const t = line.trim();

    // Callout 块
    if (t.startsWith('<callout')) {
      inCallout = true; calloutLines = [];
      // 提取 callout 属性
      const emojiMatch = t.match(/emoji=['"](.+?)['"]/);
      const bgMatch = t.match(/background-color=['"](.+?)['"]/);
      const borderMatch = t.match(/border-color=['"](.+?)['"]/);
      const calloutMeta = {
        emoji: emojiMatch ? emojiMatch[1] : '💡',
        bg: bgMatch ? COLORS[bgMatch[1]] || 5 : 5,
        border: borderMatch ? COLORS[borderMatch[1]] || 5 : 5,
      };
      calloutLines.push({meta: calloutMeta});
      continue;
    }
    if (inCallout && t === '</callout>') {
      inCallout = false;
      // 将 callout 内容作为带样式的文本块（用 emoji 标记）
      for (const cl of calloutLines) {
        if (cl.text) {
          blocks.push({
            block_type: 2,
            text: { elements: [{ text_run: { content: cl.meta.emoji + ' ' + cl.text, text_style: { bold: true, text_color: cl.meta.border } } }], style: {} }
          });
        }
      }
      continue;
    }
    if (inCallout) {
      if (t) calloutLines.push({text: t, meta: calloutLines[0]?.meta || {}});
      continue;
    }

    // Grid 块（简化为分组文本）
    if (t.startsWith('<grid')) { inGrid = true; continue; }
    if (inGrid && t === '</grid>') { inGrid = false; continue; }
    if (inGrid) {
      if (t && !t.startsWith('<')) {
        blocks.push(parseBlock(line));
      }
      continue;
    }

    // 跳过 table/lark-table 标签行，表格改为文本列表
    if (t.startsWith('<lark-table') || t.startsWith('<lark-tr>') || t.startsWith('</lark-tr>') ||
        t.startsWith('<lark-td>') || t.startsWith('</lark-td>') || t === '</lark-table>') {
      continue;
    }

    // 普通行
    blocks.push(parseBlock(line));
  }

  // 过滤掉空block
  const finalBlocks = blocks.filter(b => {
    if (b.block_type === 2) {
      const content = b.text?.elements?.[0]?.text_run?.content || '';
      return content.length > 0;
    }
    return true;
  });

  console.log('blocks:', finalBlocks.length);

  // 4. 分批写入
  for (let i = 0; i < finalBlocks.length; i += 30) {
    const batch = finalBlocks.slice(i, i + 30);
    try {
      const resp = await axios.post(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
        { children: batch, index: -1 },
        { headers }
      );
      if (resp.data.code === 0) {
        console.log(`  batch ${Math.floor(i/30)+1}: OK (${batch.length} blocks)`);
      } else {
        console.log(`  batch ${Math.floor(i/30)+1}: code=${resp.data.code} ${resp.data.msg}`);
      }
    } catch(e) {
      console.log(`  batch ${Math.floor(i/30)+1}: ERROR - ${e.response?.data?.msg || e.message}`);
      if (e.response?.data?.code === 1770029) {
        // block not supported, skip and continue
        console.log('    (skipping unsupported block)');
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 5. 发送通知
  const docUrl = 'https://bytedance.feishu.cn/docx/' + docId;
  const Lark = require('@larksuiteoapi/node-sdk');
  const client = new Lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: CHAT_ID,
      msg_type: 'text',
      content: JSON.stringify({text: '📊 6月1-7日健康周报已更新\n\n' + docUrl + '\n\n🔴 关键发现：\n1. 连吃两天熏猪肝（内脏禁忌！）\n2. 6/6钠摄入5800mg超标290%\n3. 蛋白质波动41-135g\n4. 仅3天有体重记录\n\n详细分析见文档 ↑'})
    }
  });
  console.log('通知已发送:', docUrl);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
