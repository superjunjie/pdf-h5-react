import type { SearchHit } from '../types';

/**
 * 在已渲染的文本层 DOM 上做搜索高亮。
 *
 * 为什么不在 React 里重渲染文本层：文本层由 pdf.js 直接生成（几百个 span），
 * 交给 React 管理反而会破坏其精确定位。这里只对命中所在的 span 插入 <mark>，
 * 并在清理时还原 —— 代价是 O(命中数)，与页数无关。
 */
export function highlightTextNodes(root: HTMLElement, hits: readonly SearchHit[], activeIndex: number): void {
  // 先清掉上一次的高亮
  for (const mark of root.querySelectorAll('mark.pdfh5-hit')) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
  if (hits.length === 0) return;

  const byPage = new Map<number, SearchHit[]>();
  for (const hit of hits) {
    const list = byPage.get(hit.pageNumber);
    if (list) list.push(hit);
    else byPage.set(hit.pageNumber, [hit]);
  }

  const pages = root.querySelectorAll<HTMLElement>('.pdfh5-page');
  pages.forEach((pageElement) => {
    const pageNumber = Number(pageElement.dataset.pageNumber);
    const pageHits = byPage.get(pageNumber);
    if (!pageHits || pageHits.length === 0) return;

    const textHost = pageElement.querySelector<HTMLElement>('.pdfh5-textLayerHost');
    if (!textHost) return;

    // 收集文本层里的 span（pdf.js 生成的顺序与文本项一致）
    const spans = Array.from(textHost.querySelectorAll<HTMLElement>('.textLayer span'));
    if (spans.length === 0) return;

    // 计算每个 span 在整页文本里的累计起点
    const starts: number[] = [];
    let cursor = 0;
    for (const span of spans) {
      starts.push(cursor);
      cursor += (span.textContent ?? '').length;
    }

    for (const hit of pageHits) {
      const spanIndex = findSpanIndex(starts, spans, hit.start);
      const span = spans[spanIndex];
      if (!span) continue;
      const localStart = Math.max(0, hit.start - starts[spanIndex]);
      const text = span.textContent ?? '';
      const localEnd = Math.min(text.length, localStart + (hit.end - hit.start));
      if (localEnd <= localStart) continue;

      wrapRange(span, localStart, localEnd, hit === hits[activeIndex]);
    }
  });
}

function findSpanIndex(starts: readonly number[], spans: readonly HTMLElement[], position: number): number {
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    if (starts[i] <= position) return i;
  }
  return 0;
}

/** 把 span 内部的一段文字替换成 <mark> */
function wrapRange(span: HTMLElement, start: number, end: number, active: boolean): void {
  const text = span.textContent ?? '';
  if (start >= text.length) return;
  const before = text.slice(0, start);
  const middle = text.slice(start, Math.min(end, text.length));
  const after = text.slice(Math.min(end, text.length));
  if (!middle) return;

  const mark = document.createElement('mark');
  mark.className = active ? 'pdfh5-hit pdfh5-hit-active' : 'pdfh5-hit';
  mark.textContent = middle;

  span.textContent = '';
  if (before) span.appendChild(document.createTextNode(before));
  span.appendChild(mark);
  if (after) span.appendChild(document.createTextNode(after));
}
