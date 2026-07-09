import fs from 'fs';
import path from 'path';
import { ResumeData } from './pdfService';

// ─── 配色主题 ───

const THEMES: Record<string, {
  name: string;
  primary: string;
  accent: string;
  bg: string;
  text: string;
  muted: string;
  border: string;
  tagBg: string;
}> = {
  navy: {
    name: '暗红',
    primary: '#6b2c32',
    accent: '#8b4a4a',
    bg: '#fdfaf7',
    text: '#2d2a2a',
    muted: '#8c7e7e',
    border: '#e8e0e0',
    tagBg: '#fdf2f2',
  },
  modern: {
    name: '现代灰黑',
    primary: '#1a202c',
    accent: '#4a5568',
    bg: '#ffffff',
    text: '#2d3748',
    muted: '#a0aec0',
    border: '#edf2f7',
    tagBg: '#f7fafc',
  },
  teal: {
    name: '清新青绿',
    primary: '#234e52',
    accent: '#319795',
    bg: '#f7fafc',
    text: '#2d3748',
    muted: '#718096',
    border: '#e2e8f0',
    tagBg: '#e6fffa',
  },
};

// ─── HTML 简历生成 ───

export function generateHtmlResume(data: ResumeData, themeKey: string = 'navy'): string {
  const theme = THEMES[themeKey] || THEMES.navy;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${data.name || '简历'} — ${data.targetRole || ''}</title>
<style>
  :root {
    --primary: ${theme.primary};
    --accent: ${theme.accent};
    --bg: ${theme.bg};
    --text: ${theme.text};
    --muted: ${theme.muted};
    --border: ${theme.border};
    --tag-bg: ${theme.tagBg};
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    color: var(--text);
    background: #e2e8f0;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 800px;
    margin: 20px auto;
    background: var(--bg);
    box-shadow: 0 4px 24px rgba(0,0,0,0.12);
  }

  /* ── Header ── */
  .header {
    background: var(--primary);
    color: #fff;
    padding: 36px 48px 32px;
  }
  .header-name { font-size: 30px; font-weight: 700; letter-spacing: 1px; }
  .header-role { font-size: 16px; opacity: 0.85; margin-top: 6px; font-weight: 500; }
  .header-contact {
    display: flex; flex-wrap: wrap; gap: 6px 24px;
    margin-top: 14px; font-size: 13px; opacity: 0.8;
  }
  .header-contact span { white-space: nowrap; }

  /* ── Body ── */
  .body { padding: 32px 48px 40px; }

  /* ── Section ── */
  .section { margin-bottom: 28px; }
  .section-title {
    font-size: 16px; font-weight: 700; color: var(--primary);
    padding-bottom: 7px; border-bottom: 2px solid var(--accent);
    margin-bottom: 14px; letter-spacing: 0.5px;
  }
  .section-title::before {
    content: ''; display: inline-block; width: 8px; height: 8px;
    background: var(--accent); border-radius: 2px; margin-right: 8px; vertical-align: 2px;
  }

  /* ── Summary ── */
  .summary { font-size: 14px; color: var(--text); line-height: 1.7; }

  /* ── Skills Grid ── */
  .skills-grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 28px;
  }
  .skill-cat { font-size: 13px; }
  .skill-cat-name { font-weight: 600; color: var(--primary); }
  .skill-cat-items { color: var(--muted); }

  /* ── Experience ── */
  .exp-item { margin-bottom: 20px; }
  .exp-header {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 4px; flex-wrap: wrap;
  }
  .exp-company { font-size: 15px; font-weight: 700; color: var(--text); }
  .exp-role { font-size: 14px; color: var(--accent); font-weight: 500; margin-left: 8px; }
  .exp-period { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .exp-highlights { margin-top: 6px; padding-left: 0; list-style: none; }
  .exp-highlights li {
    position: relative; padding-left: 16px; font-size: 13px;
    margin-bottom: 5px; color: var(--text); line-height: 1.6;
  }
  .exp-highlights li::before {
    content: '▸'; position: absolute; left: 0; color: var(--accent);
    font-size: 10px; top: 2px;
  }

  /* ── Education ── */
  .edu-row { display: flex; justify-content: space-between; font-size: 14px; }
  .edu-school { font-weight: 600; }
  .edu-degree { color: var(--accent); margin-left: 8px; }
  .edu-year { color: var(--muted); font-size: 13px; }

  /* ── Certs ── */
  .certs { display: flex; flex-wrap: wrap; gap: 8px; }
  .cert-tag {
    display: inline-block; padding: 3px 12px;
    background: var(--tag-bg); color: var(--accent);
    border-radius: 4px; font-size: 12px; font-weight: 500;
    border: 1px solid var(--border);
  }

  /* ── Footer ── */
  .footer {
    text-align: center; padding: 16px; font-size: 11px; color: var(--muted);
    border-top: 1px solid var(--border);
  }

  /* ── Print ── */
  @media print {
    body { background: #fff; }
    .page { max-width: none; margin: 0; box-shadow: none; }
    .header { padding: 28px 36px 24px; }
    .body { padding: 24px 36px 32px; }
    @page { margin: 0; size: A4; }
  }

  /* ── Responsive ── */
  @media (max-width: 600px) {
    .page { margin: 0; }
    .header, .body { padding: 20px 20px 24px; }
    .skills-grid { grid-template-columns: 1fr; }
    .header-name { font-size: 24px; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="header-name">${esc(data.name || '姓名')}</div>
    ${data.targetRole ? `<div class="header-role">${esc(data.targetRole)}</div>` : ''}
    <div class="header-contact">
      ${[data.phone, data.email, data.location, data.linkedin].filter(Boolean).map(c => `<span>${esc(c!)}</span>`).join('')}
    </div>
  </div>

  <div class="body">

    <!-- Summary -->
    ${data.summary ? `
    <div class="section">
      <div class="section-title">个人概述</div>
      <div class="summary">${esc(data.summary)}</div>
    </div>` : ''}

    <!-- Skills -->
    ${data.skills?.length ? `
    <div class="section">
      <div class="section-title">核心能力</div>
      <div class="skills-grid">
        ${data.skills.map(s => `
        <div class="skill-cat">
          <span class="skill-cat-name">${esc(s.category)}：</span>
          <span class="skill-cat-items">${s.items.map(esc).join('、')}</span>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Experience -->
    ${data.experiences?.length ? `
    <div class="section">
      <div class="section-title">工作经历</div>
      ${data.experiences.map(e => `
      <div class="exp-item">
        <div class="exp-header">
          <div>
            <span class="exp-company">${esc(e.company)}</span>
            <span class="exp-role">${esc(e.role)}</span>
          </div>
          <span class="exp-period">${esc(e.period)}</span>
        </div>
        ${e.highlights?.length ? `
        <ul class="exp-highlights">
          ${e.highlights.map(h => `<li>${esc(h)}</li>`).join('')}
        </ul>` : ''}
      </div>`).join('')}
    </div>` : ''}

    <!-- Education -->
    ${data.education ? `
    <div class="section">
      <div class="section-title">教育背景</div>
      <div class="edu-row">
        <div>
          <span class="edu-school">${esc(data.education.school)}</span>
          <span class="edu-degree">${esc(data.education.degree)}</span>
        </div>
        <span class="edu-year">${esc(data.education.year)}</span>
      </div>
    </div>` : ''}

    <!-- Certifications -->
    ${data.certifications?.length ? `
    <div class="section">
      <div class="section-title">证书与资质</div>
      <div class="certs">
        ${data.certifications.map(c => `<span class="cert-tag">${esc(c)}</span>`).join('')}
      </div>
    </div>` : ''}

  </div>


</div>
</body>
</html>`;

  return html;
}

/** 保存 HTML 简历到文件，返回文件路径 */
export function saveHtmlResume(data: ResumeData, theme: string = 'navy'): string {
  const html = generateHtmlResume(data, theme);
  const tmpDir = path.resolve(__dirname, '../../.data/tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const safeName = (data.name || 'resume').replace(/[^\w一-鿿]/g, '_');
  const fileName = `${safeName}_${new Date().toISOString().slice(0, 10)}.html`;
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, html, 'utf-8');

  return filePath;
}

function esc(s?: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
