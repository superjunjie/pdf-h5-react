import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PageProxyCache } from '../core/cache';
import { rafBatch } from '../core/throttle';
import type { PageMetric } from '../types';

export interface UsePageMetricsResult {
  metrics: ReadonlyArray<PageMetric | undefined>;
  /** 已解析尺寸的页数（用于进度显示） */
  resolved: number;
  /** 取页面代理（带 LRU + 并发合并） */
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  peekPage(pageNumber: number): PDFPageProxy | undefined;
  /** 请求解析某一页的尺寸（幂等，滚动接近时调用） */
  ensurePage(pageNumber: number): void;
}

export interface UsePageMetricsOptions {
  /** 首屏并发解析的页数，默认 4 */
  initialPages?: number;
}

/**
 * 渐进式页面度量。
 *
 * 大文档不可能一次性 getPage() 全部页面（等于把整份文件解析一遍）。
 * 这里分三层：
 * 1. 首屏并发解析前 N 页，拿到真实尺寸；
 * 2. 其余页先用「已解析页的平均尺寸」占位（layout 里传 fallback），滚动时不至于跳动；
 * 3. 滚动接近某页时 ensurePage() 解析它 —— 尺寸校正走 rafBatch，一帧合并多页，
 *    避免「多页尺寸同时到达 → 每页一次 setState → 布局抖动」。
 */
export function usePageMetrics(doc: PDFDocumentProxy | null, options: UsePageMetricsOptions = {}): UsePageMetricsResult {
  const initialPages = Math.max(1, options.initialPages ?? 4);

  const [metrics, setMetrics] = useState<Array<PageMetric | undefined>>([]);
  const [resolved, setResolved] = useState(0);

  // 文档切换时重建页面缓存
  const cacheRef = useRef<PageProxyCache | null>(null);
  const pendingRef = useRef(new Set<number>());
  const resolvedRef = useRef(new Set<number>());
  const batchRef = useRef<ReturnType<typeof rafBatch<{ pageNumber: number; metric: PageMetric }>> | null>(null);

  useEffect(() => {
    if (!doc) {
      cacheRef.current = null;
      setMetrics([]);
      setResolved(0);
      return;
    }

    const cache = new PageProxyCache(doc, 64);
    cacheRef.current = cache;
    pendingRef.current.clear();
    resolvedRef.current.clear();
    setMetrics(new Array(doc.numPages).fill(undefined));
    setResolved(0);

    const batch = rafBatch<{ pageNumber: number; metric: PageMetric }>((items) => {
      setMetrics((prev) => {
        const next = prev.slice();
        for (const { pageNumber, metric } of items) next[pageNumber - 1] = metric;
        return next;
      });
      setResolved(resolvedRef.current.size);
    }, 16);
    batchRef.current = batch;

    return () => {
      batch.cancel();
      batchRef.current = null;
      cacheRef.current = null;
    };
  }, [doc]);

  const loadMetric = useCallback(async (pageNumber: number): Promise<void> => {
    const cache = cacheRef.current;
    if (!cache) return;
    if (resolvedRef.current.has(pageNumber) || pendingRef.current.has(pageNumber)) return;
    pendingRef.current.add(pageNumber);
    try {
      const page = await cache.get(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      resolvedRef.current.add(pageNumber);
      batchRef.current?.push({
        pageNumber,
        metric: {
          pageNumber,
          width: viewport.width / viewport.userUnit,
          height: viewport.height / viewport.userUnit,
          rotate: page.rotate,
          userUnit: viewport.userUnit,
        },
      });
    } catch {
      /* 单页失败留空，由 fallback 顶替 */
    } finally {
      pendingRef.current.delete(pageNumber);
    }
  }, []);

  const ensurePage = useCallback(
    (pageNumber: number) => {
      void loadMetric(pageNumber);
    },
    [loadMetric],
  );

  // 首屏：并发解析前 N 页
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const run = async () => {
      const limit = Math.min(initialPages, doc.numPages);
      const tasks: Promise<void>[] = [];
      for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
        tasks.push(loadMetric(pageNumber));
      }
      await Promise.all(tasks);
      if (cancelled) return;
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [doc, initialPages, loadMetric]);

  const getPage = useCallback(async (pageNumber: number) => {
    const cache = cacheRef.current;
    if (!cache) throw new Error('document not ready');
    return cache.get(pageNumber);
  }, []);

  const peekPage = useCallback((pageNumber: number) => cacheRef.current?.peek(pageNumber), []);

  return { metrics, resolved, getPage, peekPage, ensurePage };
}
