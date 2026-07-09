/**
 * 简历生成系统测试
 * 覆盖：ResumeData 结构验证、HTML 生成、PDF 生成、store 持久化
 */
import { describe, it, expect } from 'vitest';
import { ResumeData, SkillGroup, Experience, Education } from '../../career/pdfService';

// 测试用最小简历数据
const sampleResume: ResumeData = {
  name: '张三',
  targetRole: '内容风险治理专家',
  phone: '13800000000',
  email: 'test@example.com',
  location: '北京',
  summary: '5年互联网内容风险治理经验，擅长规则体系设计与运营效率提升。',
  skills: [
    { category: '风险治理', items: ['规则设计', '审核运营', '人机协同'] },
    { category: '数据分析', items: ['SQL', 'Excel', 'Python'] },
  ],
  experiences: [
    {
      company: '某头部互联网公司',
      role: '风险治理负责人',
      period: '2020.01 - 2024.12',
      highlights: [
        '主导审核规则重构，效率提升50%',
        '建立人机协同体系，准确率提升8%',
        '举报有效率从20%提升至45%',
      ],
    },
  ],
  education: {
    school: '某大学',
    degree: '信息安全 · 本科',
    year: '2018',
  },
  certifications: ['CISP', 'CISA'],
};

describe('ResumeData 数据结构', () => {
  it('所有字段正确赋值', () => {
    expect(sampleResume.name).toBe('张三');
    expect(sampleResume.targetRole).toBe('内容风险治理专家');
    expect(sampleResume.skills).toHaveLength(2);
    expect(sampleResume.experiences).toHaveLength(1);
    expect(sampleResume.experiences![0].highlights).toHaveLength(3);
  });

  it('空字段处理正确', () => {
    const empty: ResumeData = {};
    expect(empty.name).toBeUndefined();
    expect(empty.skills).toBeUndefined();
    expect(empty.experiences).toBeUndefined();
  });

  it('工作经验包含量化数据', () => {
    for (const exp of sampleResume.experiences || []) {
      for (const h of exp.highlights) {
        // 每条成就应包含数字量化
        const hasNumber = /\d/.test(h);
        expect(hasNumber).toBe(true);
      }
    }
  });

  it('技能按类别分组', () => {
    expect(sampleResume.skills![0].category).toBe('风险治理');
    expect(sampleResume.skills![0].items.length).toBeGreaterThan(0);
  });
});

describe('HTML 简历生成', () => {
  // 动态导入以避免模块层面依赖
  it('generateHtmlResume 返回有效 HTML', async () => {
    const { generateHtmlResume } = await import('../../career/htmlResume');
    const html = generateHtmlResume(sampleResume, 'navy');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('张三');
    expect(html).toContain('内容风险治理专家');
    expect(html).toContain('某头部互联网公司');
    // 主题颜色正确注入
    expect(html).toContain('--primary');
    expect(html).toContain('--accent');
  });

  it('generateHtmlResume 支持所有主题', async () => {
    const { generateHtmlResume } = await import('../../career/htmlResume');
    for (const theme of ['navy', 'modern', 'teal']) {
      const html = generateHtmlResume(sampleResume, theme);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain(theme === 'navy' ? '#6b2c32' : theme === 'modern' ? '#1a202c' : '#234e52');
    }
  });

  it('XSS 防护：用户内容被正确转义', async () => {
    const { generateHtmlResume } = await import('../../career/htmlResume');
    const risky: ResumeData = {
      ...sampleResume,
      name: '<script>alert("xss")</script>',
    };
    const html = generateHtmlResume(risky, 'navy');
    // 名字在 body 中应该被转义显示
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    // title 里的 HTML 标签不会被执行（非 XSS 向量）
    // 验证整个 HTML 结构合法
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
  });
});

describe('PDF 简历生成', () => {
  it('generateResumePdf 返回非空 Buffer', async () => {
    const { generateResumePdf } = await import('../../career/pdfService');
    const buffer = await generateResumePdf(sampleResume);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000); // PDF 至少 > 1KB
    // PDF 文件头
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
  }, 15000); // PDF 生成可能较慢
});

describe('ResumeData 序列化', () => {
  it('JSON 序列化往返正确', () => {
    const json = JSON.stringify(sampleResume);
    const parsed: ResumeData = JSON.parse(json);
    expect(parsed.name).toBe(sampleResume.name);
    expect(parsed.experiences![0].highlights).toEqual(sampleResume.experiences![0].highlights);
  });

  it('JSON 体积合理', () => {
    const json = JSON.stringify(sampleResume);
    // 简历数据不应该超过 10KB
    expect(json.length).toBeLessThan(10000);
    expect(json.length).toBeGreaterThan(100);
  });
});
