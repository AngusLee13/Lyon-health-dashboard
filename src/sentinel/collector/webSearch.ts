/**
 * 天津城投舆情监测 — 搜索引擎采集器
 *
 * 通过 HTTP 请求抓取搜索引擎结果页（Bing/百度新闻），
 * 使用 cheerio 解析 HTML，提取标题、URL、摘要。
 *
 * 速率限制：同一关键词每 30 分钟最多请求一次。
 */

import * as cheerio from 'cheerio';
import { RawArticle, SourceType, CollectResult } from '../types';
import { keywordGroups } from '../config';
import { getMeta, saveMeta } from '../store';
import { createLogger } from '../../utils/logger';

const log = createLogger('搜索采集');

interface FetchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/** 生成 UUID v4（简易版，无 crypto 依赖） */
function generateId(): string {
  const hex = '0123456789abcdef';
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return hex[v];
  });
}

/** HTTP 请求封装（带 UA 和超时） */
async function fetchHTML(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return resp.text();
}

/** 采集 Bing 搜索结果 */
async function searchBing(keyword: string): Promise<FetchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(keyword)}&setlang=zh-cn&cc=cn`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const results: FetchResult[] = [];

  // Bing 搜索结果选择器
  $('#b_results .b_algo').each((_i, el) => {
    const titleEl = $(el).find('h2 a').first();
    const title = titleEl.text().trim();
    const href = titleEl.attr('href') || '';
    const snippet = $(el).find('.b_caption p, .b_lineclamp2').first().text().trim();

    if (title && href && !href.startsWith('javascript:')) {
      results.push({
        title,
        url: href,
        snippet: snippet || title,
        source: 'Bing搜索',
      });
    }
  });

  return results;
}

/** 采集百度新闻搜索结果 */
async function searchBaiduNews(keyword: string): Promise<FetchResult[]> {
  const url = `https://news.baidu.com/ns?word=${encodeURIComponent(keyword)}&pn=0&cl=1&ct=0`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const results: FetchResult[] = [];

  // 百度新闻搜索结果选择器
  $('.result').each((_i, el) => {
    const titleEl = $(el).find('h3 a').first();
    const title = titleEl.text().trim();
    const href = titleEl.attr('href') || '';
    const snippet = $(el).find('.c-summary, .c-abstract').first().text().trim();
    const source = $(el).find('.c-author, .c-showurl').first().text().trim();

    if (title && href) {
      results.push({
        title,
        url: href,
        snippet: snippet || title,
        source: source || '百度新闻',
      });
    }
  });

  return results;
}

/** 单关键词采集（Bing + 百度新闻双源） */
async function searchKeyword(keyword: string, groupWeight: number): Promise<RawArticle[]> {
  const articles: RawArticle[] = [];
  const now = Date.now();

  const searchFn = async (fn: (kw: string) => Promise<FetchResult[]>, sourceType: SourceType) => {
    try {
      const results = await fn(keyword);
      for (const r of results) {
        articles.push({
          id: generateId(),
          title: r.title,
          url: r.url,
          source: r.source,
          sourceType,
          snippet: r.snippet,
          collectedAt: now,
          searchKeyword: keyword,
          publishDate: new Date().toISOString().substring(0, 10),
        });
      }
    } catch (err: any) {
      log.warn(`搜索源异常 [${keyword}]: ${err.message}`);
    }
  };

  await Promise.all([
    searchFn(searchBing, 'web_search'),
    searchFn(searchBaiduNews, 'news_aggregator'),
  ]);

  return articles;
}

/** 全量关键词采集结果（含原始文章） */
export interface FullCollectResult {
  result: CollectResult;
  articles: RawArticle[];
}

/** 全量关键词采集 */
export async function collectFromSearch(): Promise<FullCollectResult> {
  const allKeywords = keywordGroups.flatMap(g =>
    g.keywords.map(k => ({ keyword: k, weight: g.weight }))
  );

  const meta = getMeta();
  const now = Date.now();
  const MIN_INTERVAL = 30 * 60 * 1000; // 30 分钟冷却

  // 过滤掉冷却期内的关键词
  const freshKeywords = allKeywords.filter(({ keyword }) => {
    const lastFetch = meta.lastSearchTimestamps[keyword] || 0;
    return (now - lastFetch) >= MIN_INTERVAL;
  });

  log.info(`搜索采集开始: 总计 ${allKeywords.length} 个关键词，${freshKeywords.length} 个待采集`);

  let totalFetched = 0;
  const allArticles: RawArticle[] = [];
  let skipped = allKeywords.length - freshKeywords.length;
  const errors: string[] = [];

  // 逐个关键词采集（间隔 0.5 秒避免被封）
  for (const { keyword, weight } of freshKeywords) {
    try {
      const articles = await searchKeyword(keyword, weight);
      totalFetched += articles.length;
      allArticles.push(...articles);

      // 更新游标
      meta.lastSearchTimestamps[keyword] = now;

      log.info(`搜索完成 [${keyword}]: 获取 ${articles.length} 条`);
    } catch (err: any) {
      errors.push(`${keyword}: ${err.message}`);
      log.error(`搜索失败 [${keyword}]: ${err.message}`);
    }

    // 间隔控制
    if (freshKeywords.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  saveMeta({
    lastSearchTimestamps: meta.lastSearchTimestamps,
    lastCollectionTime: now,
  });

  const result: CollectResult = {
    sourceType: 'web_search',
    totalFetched,
    newItems: allArticles.length,
    skipped,
    errors,
    timestamp: now,
  };

  return { result, articles: allArticles };
}
