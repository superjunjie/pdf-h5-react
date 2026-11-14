import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createThumbnailCanvas } from '../lib/thumbnail';
import type { ThumbnailCache } from '../core/cache';
import type { RenderQueue } from '../core/renderQueue';

export interface PageThumbnailProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  cache: ThumbnailCache;
  queue: RenderQueue;
  /** 进入视口才渲染 */
  active: boolean;
  rotation: number;
  onSelect(pageNumber: number): void;
  current: boolean;
}

/**
 * 单张缩略图。
 *
 * 缩略图数量可能上百，两个限制：
 * 1. 只有 active（进入视口附近）才提交渲染；
 * 2. 结果按页缓存成 dataURL（体积小），再次打开面板直接复用。
 */
export function PageThumbnail({
  doc,
  pageNumber,
  width,
  cache,
  queue,
  active,
  rotation,
  onSelect,
  current,
}: PageThumbnailProps) {
  const [src, setSrc] = useState<string | null>(() => cache.get(pageNumber)?.dataUrl ?? null);
  const [height, setHeight] = useState<number>(Math.round(width * 1.414));

  useEffect(() => {
    const cached = cache.get(pageNumber);
    if (cached) {
      setSrc(cached.dataUrl);
      return;
    }
    if (!active) return;

    let cancelled = false;
    createThumbnailCanvas(doc, pageNumber, { targetWidth: width, rotation }, queue)
      .then((result) => {
        if (cancelled) return;
        setHeight(result.height);
        cache.put(pageNumber, result.dataUrl);
        setSrc(result.dataUrl);
      })
      .catch(() => {
        /* 缩略图失败不阻断列表 */
      });

    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, width, rotation, cache, queue, active]);

  return (
    <button
      type="button"
      className={`pdfh5-thumb ${current ? 'is-current' : ''}`}
      style={{ width, height }}
      onClick={() => onSelect(pageNumber)}
      aria-label={`第 ${pageNumber} 页`}
      aria-current={current || undefined}
    >
      {src ? <img src={src} alt="" width={width} height={height} decoding="async" loading="lazy" /> : <span className="pdfh5-thumb-skeleton" />}
      <span className="pdfh5-thumb-label">{pageNumber}</span>
    </button>
  );
}
