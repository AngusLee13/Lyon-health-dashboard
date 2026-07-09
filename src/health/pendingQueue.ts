import fs from 'fs';
import path from 'path';

/** 待处理图片存储目录（与 .data/health 同级，PM2 重启后数据不丢失） */
const PENDING_DIR = path.resolve(__dirname, '../../.data/pending-images');

/** 最大重试次数，超过后自动丢弃 */
const MAX_RETRIES = 3;

/** 队列中每张图片的元数据 */
export interface PendingImage {
  /** 飞书消息 ID，同时也是队列文件名 */
  messageId: string;
  /** 飞书图片 key，用于重新下载 */
  imageKey: string;
  /** 目标 chatId，处理完成后回复到此会话 */
  chatId: string;
  /** 接收该消息的 Bot ID */
  botId: string;
  /** 消息原始日期（从 create_time 推导），用于数据保存到正确的日期文件 */
  date: string;
  /** 已重试次数 */
  retries: number;
  /** 首次接收时间戳 */
  receivedAt: number;
}

/** 确保队列目录存在 */
function ensureDir(): void {
  if (!fs.existsSync(PENDING_DIR)) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
  }
}

/** 将图片加入待处理队列（OCR 开始前调用） */
export function addPendingImage(record: PendingImage): void {
  ensureDir();
  const filePath = path.join(PENDING_DIR, `${record.messageId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  console.log(`[待处理队列] ➕ 已登记: ${record.messageId} (日期=${record.date})`);
}

/** 处理成功后从队列移除 */
export function removePendingImage(messageId: string): void {
  const filePath = path.join(PENDING_DIR, `${messageId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`[待处理队列] ✅ 已移除: ${messageId}`);
  }
}

/** 更新重试次数（处理异常时递增） */
export function updatePendingRetries(messageId: string, retries: number): void {
  const filePath = path.join(PENDING_DIR, `${messageId}.json`);
  if (!fs.existsSync(filePath)) return;
  try {
    const record: PendingImage = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    record.retries = retries;
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  } catch {
    // 文件损坏则忽略
  }
}

/** 列出所有待处理图片（按接收时间升序） */
export function listPendingImages(): PendingImage[] {
  ensureDir();
  let files: string[];
  try {
    files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const records: PendingImage[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(PENDING_DIR, file), 'utf-8');
      const record = JSON.parse(content);
      // 基本字段校验
      if (record.messageId && record.imageKey && record.chatId) {
        records.push(record);
      }
    } catch (err) {
      console.warn(`[待处理队列] ⚠️ 读取 ${file} 失败，跳过`);
    }
  }
  return records.sort((a, b) => a.receivedAt - b.receivedAt);
}

/** 获取待处理队列统计信息 */
export function getPendingStats(): { total: number; oldestAge: number | null } {
  const records = listPendingImages();
  if (records.length === 0) return { total: 0, oldestAge: null };

  let oldest = Infinity;
  const now = Date.now();
  for (const r of records) {
    if (r.receivedAt < oldest) oldest = r.receivedAt;
  }
  return {
    total: records.length,
    oldestAge: Math.round((now - oldest) / 1000), // 秒
  };
}

/** 超过最大重试次数的图片标记为已处理（自动丢弃） */
export function dropExpiredPending(): number {
  const records = listPendingImages();
  let dropped = 0;
  for (const r of records) {
    if (r.retries >= MAX_RETRIES) {
      removePendingImage(r.messageId);
      dropped++;
    }
  }
  if (dropped > 0) {
    console.log(`[待处理队列] 🗑 已丢弃 ${dropped} 个超过最大重试次数的图片`);
  }
  return dropped;
}

export { MAX_RETRIES };
