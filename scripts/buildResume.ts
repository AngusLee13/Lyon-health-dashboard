/**
 * 简历构建脚本
 * 从结构化的 ResumeData 生成 HTML（3套主题）和 PDF 简历。
 *
 * 用法:
 *   npx tsx scripts/buildResume.ts              # 使用已保存的 resume.json
 *   npx tsx scripts/buildResume.ts --from-bot   # 从飞书对话自动提取
 *
 * 输出:
 *   reports/resume-navy.html     经典深蓝
 *   reports/resume-modern.html   现代灰黑
 *   reports/resume-teal.html     清新青绿
 *   reports/resume.pdf           PDF 版本
 *   .data/career/resume.json     结构化数据（方便后续修改）
 */

import fs from 'fs';
import path from 'path';
import { generateHtmlResume, saveHtmlResume } from '../src/career/htmlResume';
import { generateResumePdf, ResumeData } from '../src/career/pdfService';
import { saveResumeData, getResumeData } from '../src/career/store';

// ─── 将 Bot 生成的 Markdown 简历转换为结构化 ResumeData ───

function buildDefaultResumeData(): ResumeData {
  return {
    name: '',
    targetRole: '内容风险治理 / 平台治理 / 运营安全专家',
    phone: '',
    email: '',
    location: '',
    summary: '拥有多年互联网内容风险治理实战经验，主导审核规则体系重构与人机协同架构设计。擅长通过规则分层、流程优化和数据驱动，系统化提升审核效率与准确率。',
    skills: [
      {
        category: '风险治理',
        items: ['内容安全策略', '规则体系设计', '人机协同流程', '投诉/举报运营', '审核质量管理'],
      },
      {
        category: '数据分析',
        items: ['SQL（基础查询、自定义查询）', 'Excel（数据清洗、透视表、图表分析）', '飞书文档（协同规则迭代）'],
      },
      {
        category: '工具',
        items: ['飞书', '内部运营后台', '正则表达式（基础）', 'A/B测试平台'],
      },
    ],
    experiences: [
      {
        company: '某头部互联网平台',
        role: '内容风险治理负责人',
        period: '',
        highlights: [
          '主导13个审核单元规则重构，建立"红线-黄线-绿线"三级分层规则库，规则查询效率提升50%，新审核员上手时间缩短40%，规则理解偏差率下降35%',
          '引入"二分法"模型，根据风险元素在内容中的占比动态定义边界，消除规则冲突与歧义',
          '设计60%机审预审+40%人审专审的协同体系，人审准确率从84%提升至92%，单案审核时间下降25%，误判率下降27%',
          '调整绩效考核KPI权重（降低速度占比，提高准确率），结合双周案例研判会议拉齐各方风险认知',
          '重构举报审核队列为"专人专队列专审"模式，同步评估内容风险与举报行为合理性，举报有效率从20%提升至45%',
          '建立优质作者/头部作者专审渠道，独立审核流减少敏感话题误伤，头部作者误判率下降60%，申诉处理时效缩短40%',
          '对误判case归因分析：50%人员尺度不统一→双周拉齐会+定期推送提醒；50%规则边界模糊→规则迭代闭环解决',
        ],
      },
    ],
    education: {
      school: '',
      degree: '',
      year: '',
    },
    certifications: [],
  };
}

// ─── 主流程 ───

async function main() {
  const args = process.argv.slice(2);
  const reportsDir = path.resolve(__dirname, '../reports');

  // 确保输出目录存在
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  let data: ResumeData;

  // 1. 获取简历数据
  if (args.includes('--from-bot')) {
    // 从飞书对话提取
    console.log('🔍 从飞书对话提取简历数据...');
    const { extractResumeDataFromChat } = require('../src/career/pdfService');
    // 这里需要传入对话文本，通过 API 获取
    console.log('⚠️  请通过 /api/memory/search 获取对话，或使用已保存的数据');
    const saved = getResumeData();
    if (!saved) {
      console.log('📝 未找到已保存数据，使用默认模板...');
      data = buildDefaultResumeData();
    } else {
      data = saved;
    }
  } else {
    // 优先使用已保存的数据，否则用默认模板
    const saved = getResumeData();
    if (saved) {
      console.log('📂 加载已保存的简历数据');
      data = saved;
    } else {
      console.log('📝 使用默认简历模板（请填写个人信息后运行 --update）');
      data = buildDefaultResumeData();
    }
  }

  // 2. 持久化简历数据
  saveResumeData(data);
  console.log('💾 简历数据已保存到 .data/career/resume.json');

  // 3. 生成 HTML（3 套主题）
  const themes = ['navy', 'modern', 'teal'] as const;
  const themeNames: Record<string, string> = {
    navy: '经典深蓝',
    modern: '现代灰黑',
    teal: '清新青绿',
  };

  for (const theme of themes) {
    const html = generateHtmlResume(data, theme);
    const filePath = path.join(reportsDir, `resume-${theme}.html`);
    fs.writeFileSync(filePath, html, 'utf-8');
    console.log(`✅ HTML (${themeNames[theme]}): reports/resume-${theme}.html`);
  }

  // 4. 生成 PDF
  console.log('📄 正在生成 PDF...');
  try {
    const pdfBuffer = await generateResumePdf(data);
    const pdfPath = path.join(reportsDir, 'resume.pdf');
    fs.writeFileSync(pdfPath, pdfBuffer);
    console.log(`✅ PDF: reports/resume.pdf (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
  } catch (err: any) {
    console.error(`❌ PDF 生成失败: ${err.message}`);
    console.log('   （可能需要安装中文字体 C:/Windows/Fonts/simhei.ttf）');
  }

  console.log('\n🎉 简历生成完毕！');
  console.log('   浏览器打开: reports/resume-navy.html');
  console.log('   修改内容后运行: npx tsx scripts/buildResume.ts');
  console.log('   编辑数据文件: .data/career/resume.json');
}

main().catch(err => {
  console.error('构建失败:', err);
  process.exit(1);
});
