import type { SearchHit } from '../types';

export interface PageMetricsState {
  /** index 0 = 第 1 页 */
  metrics: Array<{ width: number; height: number; rotate: number; userUnit: number } | undefined>;
  /** 已经拿到的页数（用于渐进式布局：先按默认尺寸占位，再逐页校正） */
  resolved: number;
}

/** 用最小/中位数估计未加载页的尺寸，避免滚动条跳变 */
export function estimateFallback(
  metrics: ReadonlyArray<{ width: number; height: number } | undefined>,
  pageCount: number,
): { width: number; height: number } {
  let widths = 0;
  let heights = 0;
  let count = 0;
  let last: { width: number; height: number } | null = null;
  for (const metric of metrics) {
    if (!metric) continue;
    if (metric.width > 0 && metric.height > 0) {
      widths += metric.width;
      heights += metric.height;
      count += 1;
      last = metric;
    }
  }
  if (count > 0) return { width: widths / count, height: heights / count };
  if (last) return last;
  // 兜底：A4
  return { width: 595.28, height: 841.89 * (pageCount > 0 ? 1 : 1) };
}

/** 文本片段：命中处用 \u0000 包裹，渲染时转成 <mark> */
export function makeSnippet(text: string, start: number, end: number, radius = 24): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  const head = text.slice(from, start);
  const hit = text.slice(start, end);
  const tail = text.slice(end, to);
  return `${from > 0 ? '…' : ''}${head}\u0000${hit}\u0000${tail}${to < text.length ? '…' : ''}`;
}

export function splitSnippet(snippet: string): Array<{ text: string; hit: boolean }> {
  const parts = snippet.split('\u0000');
  return parts.map((text, index) => ({ text, hit: index % 2 === 1 })).filter((part) => part.text.length > 0);
}

/** 在某一页的纯文本里找出全部命中 */
export function findInPage(
  pageNumber: number,
  items: ReadonlyArray<{ str: string; start: number }>,
  joined: string,
  query: string,
  limit = 50,
): SearchHit[] {
  const hits: SearchHit[] = [];
  if (!query) return hits;
  const needle = query.toLocaleLowerCase();
  const haystack = joined.toLocaleLowerCase();
  let from = 0;
  while (hits.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    // 找到该字符位置所属的文本项
    let itemIndex = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].start <= index) {
        itemIndex = i;
        break;
      }
    }
    hits.push({
      pageNumber,
      text: joined.slice(index, index + query.length),
      itemIndex,
      start: index,
      end: index + query.length,
      snippet: makeSnippet(joined, index, index + query.length),
    });
    from = index + Math.max(1, needle.length);
  }
  return hits;
}

export interface OutlineNode {
  title: string;
  bold: boolean;
  italic: boolean;
  /** 解析后的目标页码（1 基），null 表示无法定位 */
  pageNumber: number | null;
  url: string | null;
  children: OutlineNode[];
}
