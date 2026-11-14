import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SearchHit } from '../types';
import { findInPage, makeSnippet } from './text';

export interface PageText {
  pageNumber: number;
  /** 纯文本（已合并换行） */
  text: string;
  items: Array<{ str: string; start: number }>;
}

/**
 * 提取单页文本并记录每个文本项在整页字符串中的起始偏移。
 * 记录偏移是为了把命中位置映射回具体文本项 —— 高亮时能定位到 span。
 */
export async function extractPageText(doc: PDFDocumentProxy, pageNumber: number): Promise<PageText> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const items: Array<{ str: string; start: number }> = [];
  let text = '';
  for (const item of content.items) {
    if (!('str' in item) || typeof item.str !== 'string') continue;
    // pdf.js 用 hasEOL 表示换行；合并时补空格避免"词粘连"导致搜不到
    items.push({ str: item.str, start: text.length });
    text += item.str;
    if (item.hasEOL) text += ' ';
  }
  return { pageNumber, text, items };
}

export interface SearchOptions {
  /** 每页最多返回多少条 */
  perPageLimit?: number;
  /** 总量上限 */
  totalLimit?: number;
  /** 每页之间的让出主线程间隔（ms） */
  yieldMs?: number;
  signal?: AbortSignal;
  onProgress?: (scanned: number, total: number) => void;
}

const textCache = new Map<string, PageText>();

/**
 * 全文档搜索。
 *
 * 性能考虑：
 * 1. 逐页扫描，每页之间 await 一次宏任务，避免长任务把滚动卡住；
 * 2. 页文本缓存（同一文档同一页只提取一次），重复搜索几乎零成本；
 * 3. 命中数达到上限即停止，避免「搜 a 得到 8000 条」拖垮渲染；
 * 4. 支持 AbortSignal，用户改关键词时立即中止。
 */
export async function searchDocument(
  doc: PDFDocumentProxy,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const perPageLimit = options.perPageLimit ?? 20;
  const totalLimit = options.totalLimit ?? 300;
  const yieldMs = options.yieldMs ?? 0;
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];

  const hits: SearchHit[] = [];
  const total = doc.numPages;
  const cacheKey = doc.fingerprints?.[0] ?? `doc-${total}`;

  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    if (options.signal?.aborted) return hits;

    let pageText = textCache.get(`${cacheKey}:${pageNumber}`);
    if (!pageText) {
      try {
        pageText = await extractPageText(doc, pageNumber);
        textCache.set(`${cacheKey}:${pageNumber}`, pageText);
      } catch {
        continue;
      }
    }

    if (pageText.text.toLocaleLowerCase().includes(needle)) {
      const pageHits = findInPage(pageNumber, pageText.items, pageText.text, query, perPageLimit);
      for (const hit of pageHits) {
        hits.push({ ...hit, snippet: makeSnippet(pageText.text, hit.start, hit.end) });
        if (hits.length >= totalLimit) return hits;
      }
    }

    options.onProgress?.(pageNumber, total);
    if (yieldMs > 0) await new Promise((resolve) => setTimeout(resolve, yieldMs));
  }

  return hits;
}

/** 文档切换时清理文本缓存（避免跨文档串味 + 内存泄漏） */
export function clearSearchCache(): void {
  textCache.clear();
}
