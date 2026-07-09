import https from 'https';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(__dirname, '../../.cache/xunji');

export interface XunjiConfig {
  apiKey: string;
  baseUrl: string;
}

export interface TrainItem {
  raw: string;
  date: string;
  localId?: string;
  trainTime?: { start: number; end: number };
  parts?: string[];
}

export interface TrainResult {
  date: string;
  items: TrainItem[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface UpsertTrainResult {
  date: string;
  res: string[];
  fetchedAt: number;
}

function ensureCacheDir(): void {
  const fs = require('fs');
  if (!existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cachePath(dateStr: string): string {
  return path.join(CACHE_DIR, `${dateStr}.json`);
}

function loadCache(dateStr: string): TrainResult | null {
  const p = cachePath(dateStr);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    if (data && Array.isArray(data.items)) {
      return { ...data, fromCache: true };
    }
  } catch {
    return null;
  }
  return null;
}

function saveCache(dateStr: string, result: TrainResult): void {
  ensureCacheDir();
  const fs = require('fs');
  fs.writeFileSync(cachePath(dateStr), JSON.stringify(result, null, 2), 'utf-8');
}

function parseTrainItem(raw: string): TrainItem {
  const parts = raw.split(',');
  const item: TrainItem = { raw, date: '', parts };

  for (const part of parts) {
    if (part.startsWith('id:')) {
      item.localId = part.slice(3);
    } else if (part.startsWith('train_time:')) {
      const times = part.slice(11).split('-');
      if (times.length === 2) {
        item.trainTime = { start: parseInt(times[0], 10), end: parseInt(times[1], 10) };
      }
    }
  }

  // 第一段通常是日期
  if (parts.length > 0 && /^\d{6}$/.test(parts[0])) {
    item.date = parts[0];
  }

  return item;
}

/** 从训练行首段提取日期，支持 YYYY-MM-DD 和 YYMMDD 格式 */
function extractDateFromTrainLine(line: string): string {
  const firstComma = line.indexOf(',');
  const dateStr = firstComma === -1 ? line : line.slice(0, firstComma);

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  if (/^\d{6}$/.test(dateStr)) {
    const yy = dateStr.slice(0, 2);
    const mm = dateStr.slice(2, 4);
    const dd = dateStr.slice(4, 6);
    return `20${yy}-${mm}-${dd}`;
  }

  throw new Error(`datestr invalid: "${dateStr}"`);
}

/** 按训练 ID 做 upsert 写回训记，返回服务端标准化结果并缓存到本地 */
export async function upsertTrains(
  trainLines: string[],
  config: XunjiConfig,
): Promise<UpsertTrainResult> {
  if (!trainLines || trainLines.length === 0) {
    throw new Error('res must be a non-empty array');
  }
  if (trainLines.length > 12) {
    throw new Error('单次最多 12 条训练记录');
  }
  for (let i = 0; i < trainLines.length; i++) {
    if (trainLines[i].length > 1500) {
      throw new Error(`第 ${i + 1} 条记录超过 1500 字符限制`);
    }
  }

  // 校验所有记录同属一个日期
  const dates = trainLines.map(extractDateFromTrainLine);
  const firstDate = dates[0];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] !== firstDate) {
      throw new Error(`all train lines must be in the same datestr: 第1条=${firstDate}, 第${i + 1}条=${dates[i]}`);
    }
  }

  const body = JSON.stringify({ res: trainLines });

  const response = await new Promise<{ headers: Record<string, any>; chunks: Buffer[] }>(
    (resolve, reject) => {
      const urlObj = new URL('/api_upsert_trains_for_llm', config.baseUrl);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ headers: res.headers, chunks }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    },
  );

  const rawBuf = Buffer.concat(response.chunks);
  let rawStr: string;
  const contentEncoding = response.headers['content-encoding'] || '';
  if (contentEncoding.includes('gzip')) {
    const zlib = require('zlib');
    rawStr = zlib.gunzipSync(rawBuf).toString('utf-8');
  } else {
    rawStr = rawBuf.toString('utf-8');
  }

  let json: any;
  try {
    json = JSON.parse(rawStr);
  } catch {
    throw new Error(`训记 API 返回非 JSON: ${rawStr.slice(0, 200)}`);
  }

  if (!json.success) {
    const msg = json.message || json.error || JSON.stringify(json).slice(0, 200);
    throw new Error(`训记 upsert 失败: ${msg}`);
  }

  if (!Array.isArray(json.res)) {
    throw new Error('训记 upsert 返回的 res 不是数组');
  }

  const result: UpsertTrainResult = {
    date: firstDate,
    res: json.res,
    fetchedAt: Date.now(),
  };

  // 以服务端返回的 res 作为最终结果缓存到本地
  saveCache(firstDate, {
    date: firstDate,
    items: (json.res as string[]).map(parseTrainItem),
    fetchedAt: result.fetchedAt,
    fromCache: false,
  });

  return result;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 缓存有效期 5 分钟

export async function fetchTrains(
  dateStr: string,
  config: XunjiConfig,
  forceRefresh = false
): Promise<TrainResult> {
  // 先查缓存（5分钟内有效，过期则重新获取）
  if (!forceRefresh) {
    const cached = loadCache(dateStr);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return cached;
    }
  }

  const body = JSON.stringify({ datestr: dateStr });

  const response = await new Promise<{ headers: Record<string, any>; chunks: Buffer[] }>(
    (resolve, reject) => {
      const urlObj = new URL('/api_trains_for_llm', config.baseUrl);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ headers: res.headers, chunks }));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    }
  );

  const rawBuf = Buffer.concat(response.chunks);
  let rawStr: string;

  // 处理 gzip
  const contentEncoding = response.headers['content-encoding'] || '';
  if (contentEncoding.includes('gzip')) {
    const zlib = require('zlib');
    rawStr = zlib.gunzipSync(rawBuf).toString('utf-8');
  } else {
    rawStr = rawBuf.toString('utf-8');
  }

  let json: any;
  try {
    json = JSON.parse(rawStr);
  } catch {
    throw new Error(`训记 API 返回非 JSON: ${rawStr.slice(0, 200)}`);
  }

  // 部分响应不包含 success 字段，直接检查 res 是否为数组
  if (!Array.isArray(json.res)) {
    const msg = json.message || json.error || JSON.stringify(json).slice(0, 200);
    throw new Error(`训记 API 返回失败: ${msg}`);
  }

  const items: TrainItem[] = (json.res as string[]).map(parseTrainItem);

  const result: TrainResult = {
    date: dateStr,
    items,
    fetchedAt: Date.now(),
    fromCache: false,
  };

  saveCache(dateStr, result);
  return result;
}
