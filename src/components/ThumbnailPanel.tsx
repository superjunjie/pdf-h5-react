import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ThumbnailCache } from '../core/cache';
import { RenderQueue } from '../core/renderQueue';
import { PageThumbnail } from './PageThumbnail';
import { usePanelDismiss } from '../lib/outline';

export interface ThumbnailPanelProps {
  doc: PDFDocumentProxy;
  cache: ThumbnailCache;
  currentPage: number;
  rotation: number;
  onSelect(pageNumber: number): void;
  onClose(): void;
}

const COLUMNS = 2;
const ROW_HEIGHT = 178;
const THUMB_WIDTH = 118;

/**
 * 缩略图面板。
 *
 * 上百张缩略图不能一次性渲染：按容器滚动位置算出「可见行区间」，
 * 只渲染该区间（±2 屏），配合 ThumbnailCache，回滚时命中 dataURL 零成本。
 * 这里用位置区间而不是 IntersectionObserver —— 网格均质，算区间更稳且无观察者开销。
 */
export function ThumbnailPanel({ doc, cache, currentPage, rotation, onSelect, onClose }: ThumbnailPanelProps) {
  const { onBackdrop } = usePanelDismiss(onClose);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: 12 });
  const total = doc.numPages;

  // 面板级共享队列：缩略图之间共享并发限制，避免一次渲染几十张
  const queue = useMemo(() => new RenderQueue({ visibleConcurrency: 3, prefetchConcurrency: 2 }), []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const compute = () => {
      frame = 0;
      const viewHeight = list.clientHeight || 600;
      const scrollTop = list.scrollTop;
      const pad = ROW_HEIGHT * 2;
      const start = Math.max(0, Math.floor((scrollTop - pad) / ROW_HEIGHT) * COLUMNS);
      const end = Math.min(total, Math.ceil((scrollTop + viewHeight + pad) / ROW_HEIGHT) * COLUMNS);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(compute);
    };
    compute();
    list.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      list.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [total]);

  // 打开时把当前页滚到中间
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = Math.floor((currentPage - 1) / COLUMNS);
    list.scrollTop = Math.max(0, row * ROW_HEIGHT - list.clientHeight / 2 + ROW_HEIGHT / 2);
  }, [currentPage]);

  return (
    <div className="pdfh5-panel-backdrop" onClick={onBackdrop} role="presentation">
      <aside className="pdfh5-panel pdfh5-panel-thumbs" role="dialog" aria-label="页面缩略图">
        <header className="pdfh5-panel-head">
          <h2>页面缩略图</h2>
          <button type="button" className="pdfh5-icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="pdfh5-thumb-grid" ref={listRef} style={{ gridTemplateColumns: `repeat(${COLUMNS}, ${THUMB_WIDTH}px)` }}>
          {Array.from({ length: total }, (_, index) => {
            const pageNumber = index + 1;
            const active = index >= range.start && index < range.end;
            return (
              <PageThumbnail
                key={pageNumber}
                doc={doc}
                pageNumber={pageNumber}
                width={THUMB_WIDTH}
                cache={cache}
                queue={queue}
                active={active}
                rotation={rotation}
                current={pageNumber === currentPage}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </aside>
    </div>
  );
}
