import https from 'https';
import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import { getTenantAccessToken } from '../health/imageRecognition';
import { config } from '../config';

const CN_FONT = path.resolve('C:/Windows/Fonts/simhei.ttf');
const PAGE_W = 595.28; // A4 width in points
const PAGE_H = 841.89;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Color palette — 现代专业风格
const C_PRIMARY = '#0f2744';    // 深蓝黑 header
const C_ACCENT = '#2563eb';     // 宝蓝 accent（更鲜明）
const C_ACCENT_LIGHT = '#dbeafe'; // 浅蓝背景
const C_DARK = '#1e293b';       // 深色文字
const C_BODY = '#475569';       // 正文灰
const C_LIGHT = '#94a3b8';      // 辅助灰
const C_BORDER = '#e2e8f0';     // 细线
const C_BG_LIGHT = '#f8fafc';   // 浅色背景
const C_TAG_BG = '#eff6ff';     // 标签背景
const C_WHITE = '#ffffff';

/** 从飞书下载文件（PDF等），返回 Buffer，可传 bot 凭据避免跨 App 400 错误 */
export async function downloadFeishuFile(messageId: string, fileKey: string, appId?: string, appSecret?: string): Promise<{ buffer: Buffer; fileName: string }> {
  const token = await getTenantAccessToken(appId, appSecret);

  let fileName = 'file.pdf';
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = https.get({
      hostname: 'open.feishu.cn',
      path: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`,
      headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const disposition = res.headers['content-disposition'] || '';
      const nameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (nameMatch) fileName = decodeURIComponent(nameMatch[1].replace(/['"]/g, ''));
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
  });

  return { buffer: Buffer.concat(chunks), fileName };
}

/** 从 PDF Buffer 提取文本 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return (result as any).text || '';
}

// ——— 专业简历 PDF 生成 ———

function drawHeader(doc: PDFKit.PDFDocument, data: ResumeData): number {
  // Dark header background
  doc.rect(0, 0, PAGE_W, 120).fill(C_PRIMARY);

  // Name
  doc.fillColor('#ffffff').font(CN_FONT).fontSize(26);
  doc.text(data.name || '姓名', MARGIN, 35, { width: CONTENT_W, align: 'center' });

  // Target role below name
  if (data.targetRole) {
    doc.font(CN_FONT).fontSize(13).fillColor('#d5e8f0');
    doc.text(data.targetRole, MARGIN, 72, { width: CONTENT_W, align: 'center' });
  }

  // Contact info row
  const contactY = data.targetRole ? 95 : 78;
  doc.font(CN_FONT).fontSize(9).fillColor('#bccfd9');
  const contacts = [data.phone, data.email, data.linkedin, data.location]
    .filter(Boolean).join('    |    ');
  doc.text(contacts, MARGIN, contactY, { width: CONTENT_W, align: 'center' });

  return 130; // Y position after header
}

function drawSection(doc: PDFKit.PDFDocument, title: string, y: number): number {
  // 浅色背景条
  doc.rect(MARGIN - 8, y - 4, CONTENT_W + 16, 26).fill(C_BG_LIGHT);
  // 左侧 accent 竖条
  doc.rect(MARGIN - 8, y - 4, 4, 26).fill(C_ACCENT);

  doc.font(CN_FONT).fontSize(14).fillColor(C_PRIMARY);
  doc.text(title, MARGIN + 4, y);

  return y + 28;
}

function drawSummary(doc: PDFKit.PDFDocument, text: string, y: number): number {
  doc.font(CN_FONT).fontSize(10).fillColor(C_BODY);
  const lines = wrapText(doc, text, CONTENT_W);
  for (const line of lines) {
    doc.text(line, MARGIN, y, { width: CONTENT_W });
    y += 14;
  }
  return y + 6;
}

function drawSkills(doc: PDFKit.PDFDocument, skills: SkillGroup[], y: number): number {
  const colW = (CONTENT_W - 20) / 2;
  let rowY = y;
  const startY = y;

  for (let i = 0; i < skills.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * (colW + 20);
    rowY = startY + row * 20;

    // 类别标签（小背景块）
    const catW = doc.widthOfString(skills[i].category) + 16;
    doc.rect(x, rowY, catW, 17).fill(C_ACCENT_LIGHT).stroke(C_ACCENT);
    doc.font(CN_FONT).fontSize(9).fillColor(C_ACCENT);
    doc.text(skills[i].category, x + 8, rowY + 3, { width: catW - 16, align: 'center' });

    // 技能项
    doc.font(CN_FONT).fontSize(9).fillColor(C_BODY);
    doc.text(skills[i].items.join('  ·  '), x + catW + 6, rowY + 3, { width: colW - catW - 6 });
  }

  return rowY + 28;
}

function drawExperiences(doc: PDFKit.PDFDocument, exps: Experience[], y: number): number {
  for (const exp of exps) {
    // Check if we need page break
    if (y > PAGE_H - 180) {
      doc.addPage();
      y = MARGIN;
    }

    // Company and role header
    doc.font(CN_FONT).fontSize(12).fillColor(C_DARK);
    doc.text(`${exp.company}`, MARGIN, y, { width: CONTENT_W, continued: false });
    const headerW = doc.widthOfString(exp.company);

    doc.font(CN_FONT).fontSize(10).fillColor(C_ACCENT);
    doc.text(`  ${exp.role}`, MARGIN + headerW, y);

    // Date range right-aligned
    doc.font(CN_FONT).fontSize(9).fillColor(C_LIGHT);
    doc.text(exp.period, MARGIN, y, { width: CONTENT_W, align: 'right' });

    y += 18;

    // Highlights
    doc.font(CN_FONT).fontSize(10).fillColor(C_BODY);
    for (const item of (exp.highlights || [])) {
      const lines = wrapText(doc, item, CONTENT_W - 12);
      for (const line of lines) {
        doc.text(`·  ${line}`, MARGIN + 8, y, { width: CONTENT_W - 8 });
        y += 14;
      }
    }
    y += 6;
  }
  return y;
}

function drawEducation(doc: PDFKit.PDFDocument, edu: Education | undefined, y: number): number {
  if (!edu) return y;

  doc.font(CN_FONT).fontSize(12).fillColor(C_DARK);
  doc.text(edu.school, MARGIN, y);

  doc.font(CN_FONT).fontSize(10).fillColor(C_ACCENT);
  doc.text(`  ${edu.degree}`, MARGIN + doc.widthOfString(edu.school), y);

  doc.font(CN_FONT).fontSize(9).fillColor(C_LIGHT);
  doc.text(edu.year, MARGIN, y, { width: CONTENT_W, align: 'right' });

  return y + 22;
}

/** 简单的中文文本自动换行 */
function wrapText(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    if (doc.widthOfString(current + char) > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}

/** 生成专业美观的 PDF 简历 */
export function generateResumePdf(data: ResumeData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = drawHeader(doc, data);

    // Professional Summary
    if (data.summary) {
      y = drawSection(doc, '个人概述', y);
      y = drawSummary(doc, data.summary, y);
    }

    // Core Competencies
    if (data.skills?.length) {
      y = drawSection(doc, '核心能力', y);
      y = drawSkills(doc, data.skills, y);
    }

    // Work Experience
    if (data.experiences?.length) {
      y = drawSection(doc, '工作经历', y);
      y = drawExperiences(doc, data.experiences, y);
    }

    // Education
    if (data.education) {
      y = drawSection(doc, '教育背景', y);
      y = drawEducation(doc, data.education, y);
    }

    // Certifications
    if (data.certifications?.length) {
      if (y > PAGE_H - 100) { doc.addPage(); y = MARGIN; }
      y = drawSection(doc, '证书与资质', y);
      for (const cert of data.certifications) {
        doc.font(CN_FONT).fontSize(10).fillColor(C_BODY);
        doc.text(`·  ${cert}`, MARGIN + 8, y, { width: CONTENT_W - 8 });
        y += 14;
      }
    }

    // Footer
    const footerY = Math.max(y + 20, PAGE_H - 40);
    doc.font(CN_FONT).fontSize(7).fillColor(C_LIGHT);
    doc.text('本简历由 AI 就业指导助手生成  ·  建议投递前再次核对内容', MARGIN, footerY, { width: CONTENT_W, align: 'center' });

    doc.end();
  });
}

// ——— 数据结构 ———

export interface ResumeData {
  name?: string;
  targetRole?: string;
  phone?: string;
  email?: string;
  linkedin?: string;
  location?: string;
  summary?: string;
  skills?: SkillGroup[];
  experiences?: Experience[];
  education?: Education;
  certifications?: string[];
}

export interface SkillGroup {
  category: string;
  items: string[];
}

export interface Experience {
  company: string;
  role: string;
  period: string;
  highlights: string[];
}

export interface Education {
  school: string;
  degree: string;
  year: string;
}

// ——— 飞书文件上传和发送 ———

/** 上传文件到飞书，返回 file_key */
async function uploadFileToFeishu(filePath: string, fileName: string, appId?: string, appSecret?: string): Promise<string> {
  const token = await getTenantAccessToken(appId, appSecret);
  const fileData = fs.readFileSync(filePath);

  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${Date.now()}`;
    const header = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file_type"`,
      '',
      'stream',
      `--${boundary}`,
      `Content-Disposition: form-data; name="file_name"`,
      '',
      fileName,
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
      'Content-Type: application/pdf',
      '',
    ].join('\r\n');
    const footer = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(header, 'utf-8');
    const footerBuf = Buffer.from(footer, 'utf-8');
    const body = Buffer.concat([headerBuf, fileData, footerBuf]);

    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/im/v1/files',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (result.code === 0 && result.data?.file_key) {
          resolve(result.data.file_key);
        } else {
          reject(new Error(`上传失败: ${result.msg || 'unknown'}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 发送文件消息到飞书 */
async function sendFileMessage(chatId: string, fileKey: string, appId: string, appSecret: string): Promise<void> {
  const token = await getTenantAccessToken(appId, appSecret);

  const body = JSON.stringify({
    receive_id: chatId,
    msg_type: 'file',
    content: JSON.stringify({ file_key: fileKey }),
  });

  await new Promise<void>((resolve, reject) => {
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: `/open-apis/im/v1/messages?receive_id_type=chat_id`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (result.code !== 0) {
          console.error(`发送文件消息失败: ${result.msg}`);
        }
        resolve();
      });
      res.on('error', () => resolve());
    });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

/** 生成简历 PDF 并发送到飞书聊天 */
export async function generateAndSendResume(
  resumeData: ResumeData,
  chatId: string,
  appId?: string,
  appSecret?: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const pdfBuffer = await generateResumePdf(resumeData);

    // 保存临时文件
    const tmpDir = path.resolve(__dirname, '../../.data/tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = `${resumeData.name || '简历'}_${new Date().toISOString().slice(0, 10)}.pdf`;
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    console.log(`[PDF] 简历已生成: ${filePath} (${pdfBuffer.length} bytes)`);

    // 上传到飞书
    const fileKey = await uploadFileToFeishu(filePath, fileName, appId, appSecret);

    // 发送文件消息
    const effectiveAppId = appId || config.feishu.appId;
    const effectiveAppSecret = appSecret || config.feishu.appSecret;
    await sendFileMessage(chatId, fileKey, effectiveAppId, effectiveAppSecret);

    // 清理临时文件
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }

    return { success: true, message: `简历「${fileName}」已生成并发送` };
  } catch (err: any) {
    console.error('[PDF] 生成或发送失败:', err.message);
    return { success: false, message: `简历生成失败: ${err.message}` };
  }
}

/** 用 DeepSeek 从用户对话中提取结构化简历数据 */
export async function extractResumeDataFromChat(
  userContext: string,
): Promise<ResumeData | null> {
  const { getDeepSeekClient } = require('../claude/client');

  const prompt = `你是一个简历结构化提取助手。从以下用户提供的对话内容中，提取简历数据，以 JSON 格式返回。

返回的 JSON 格式：
{
  "name": "姓名",
  "targetRole": "求职意向岗位",
  "phone": "手机号",
  "email": "邮箱",
  "linkedin": "LinkedIn/脉脉链接（如有）",
  "location": "所在城市",
  "summary": "个人概述（2-3句话概括核心优势和职业定位）",
  "skills": [
    { "category": "技能类别名称", "items": ["技能1", "技能2"] }
  ],
  "experiences": [
    {
      "company": "公司名称",
      "role": "职位",
      "period": "2020.01 - 2023.06",
      "highlights": ["用STAR法则描述的核心成就，量化数据", "..."]
    }
  ],
  "education": { "school": "学校名", "degree": "学历/专业", "year": "毕业年份" },
  "certifications": ["证书名称1", "证书名称2"]
}

规则：
1. 只提取实际存在的信息，不确定的字段用空字符串或省略
2. experiences 中的 highlights 每条用 STAR 法则重写，量化成果
3. skills 按类别分组（如"风险治理"、"数据分析"、"编程语言"等）
4. summary 要突出与风险治理/合规相关的经验优势
5. 只返回 JSON，不要任何其他文字

用户对话内容：
${userContext}`;

  try {
    const client = getDeepSeekClient();
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as ResumeData;
  } catch (err: any) {
    console.error('[PDF] 提取简历数据失败:', err.message);
    return null;
  }
}
