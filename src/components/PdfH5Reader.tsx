import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { usePdfDocument } from '../hooks/usePdfDocument';
import { usePageMetrics } from '../hooks/usePageMetrics';
import { useVirtualPages } from '../hooks/useVirtualPages';
import { useElementSize } from '../hooks/useElementSize';
import { usePinchGesture } from '../hooks/usePinchGesture';
import { BitmapCache, TextLayerCache, ThumbnailCache } from '../core/cache';
import { RenderQueue } from '../core/renderQueue';
import { buildLayout, estimateFallbackSafe, offsetForPage } from '../core/layoutAdapter';
import { clamp } from '../core/gestures';
import { debounce, rafThrottle, throttle } from '../core/throttle';
import { PageCanvas } from './PageCanvas';
import { TextLayer } from './TextLayer';
import { LinkLayer } from './LinkLayer';
import { Toolbar } from './Toolbar';
import { OutlinePanel } from './OutlinePanel';
import { ThumbnailPanel } from './ThumbnailPanel';
import { SearchPanel } from './SearchPanel';
import { StatusOverlay } from './StatusOverlay';
import { highlightTextNodes } from '../lib/highlight';
import { searchDocument } from '../lib/search';
import { countEvent, countHandled, readCounters } from '../core/metrics';
import type { CacheStatsSnapshot, PdfH5ReaderHandle, PdfSource, SearchHit, ThemeMode, ViewerMode } from '../types';
import type { FitMode } from '../types';

export interface PdfH5ReaderProps {
  /** PDF 来源：URL / 二进制 / 参数对象 */
  src: PdfSource | null | undefined;
  /** 连续滚动 / 单页翻页 */
  mode?: ViewerMode;
  /** 适配方式，默认 width */
  fitMode?: FitMode;
  initialPage?: number;
  /** 初始缩放倍率（相对适配尺寸），默认 1 */
  initialZoom?: number;
  minZoom?: number;
  maxZoom?: number;
  doubleTapZoom?: number;
  rotation?: number;
  theme?: ThemeMode;
  gap?: number;
  padding?: number;
  /** 文本层（可选中 / 可复制），默认开启 */
  textLayer?: boolean;
  /** 链接层，默认开启 */
  links?: boolean;
  /** 是否显示内置工具栏，默认 true */
  toolbar?: boolean;
  /** 是否显示页码 / 缩放浮层，默认 true */
  showControls?: boolean;
  /** 位图缓存上限（字节），默认 96MB */
  bitmapCacheBytes?: number;
  /** 文本层缓存条目上限，默认 24 */
  textLayerCacheEntries?: number;
  maxCanvasPixels?: number;
  maxCanvasDimension?: number;
  className?: string;
  style?: React.CSSProperties;
  onDocumentLoad?: (doc: PDFDocumentProxy) => void;
  onPageChange?: (page: number, total: number) => void;
  onProgress?: (loaded: number, total: number) => void;
  onError?: (error: Error) => void;
  onZoomChange?: (zoom: number) => void;
  onInternalLink?: (dest: string | unknown[] | null) => void;
  onExternalLink?: (url: string) => void;
  /** 自定义空状态 / 加载失败渲染 */
  renderError?: (error: Error, retry: () => void) => React.ReactNode;
}

const THEME_ATTR: Record<Exclude<ThemeMode, 'auto'>, string> = {
  light: 'light',
  dark: 'dark',
};

function useResolvedTheme(theme: ThemeMode): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false,
  );
  useEffect(() => {
    if (theme !== 'auto' || typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);
  if (theme === 'auto') return systemDark ? 'dark' : 'light';
  return theme;
}

/**
 * 移动端优先的 PDF 阅读器。
 *
 * 三层性能结构：
 *  文档层  usePdfDocument   —— 加载 / 密码 / 进度（进度事件节流）
 *  度量层  usePageMetrics   —— 首屏 N 页真实尺寸 + 其余页渐进解析（rAF 批量校正）
 *  视图层  useVirtualPages  —— 只挂载可视区内的页面 DOM，位图走 LRU，渲染走双并发队列
 */
export const PdfH5Reader = forwardRef<PdfH5ReaderHandle, PdfH5ReaderProps>(function PdfH5Reader(props, ref) {
  const {
    src,
    mode = 'scroll',
    fitMode = 'width',
    initialPage = 1,
    initialZoom = 1,
    minZoom = 0.5,
    maxZoom = 5,
    doubleTapZoom = 2.5,
    rotation = 0,
    theme = 'auto',
    gap = 12,
    padding = 12,
    textLayer = true,
    links = true,
    toolbar = true,
    showControls = true,
    bitmapCacheBytes,
    textLayerCacheEntries,
    maxCanvasPixels,
    maxCanvasDimension,
    className,
    style,
    onDocumentLoad,
    onPageChange,
    onProgress,
    onError,
    onZoomChange,
    onInternalLink,
    onExternalLink,
    renderError,
  } = props;

  const resolvedTheme = useResolvedTheme(theme);

  const { ref: viewportRef, width: containerWidth, height: containerHeight } = useElementSize<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 文档
  const docState = usePdfDocument(src);
  const { doc } = docState;

  // 缓存（跨文档复用一份，切文档时清空）
  const bitmapCache = useMemo(
    () => new BitmapCache({ maxBytes: bitmapCacheBytes ?? 96 * 1024 * 1024 }),
    [bitmapCacheBytes],
  );
  const textLayerCache = useMemo(
    () => new TextLayerCache({ maxEntries: textLayerCacheEntries ?? 24 }),
    [textLayerCacheEntries],
  );
  const thumbnailCache = useMemo(() => new ThumbnailCache(), []);
  const renderQueue = useMemo(() => new RenderQueue({ visibleConcurrency: 2, prefetchConcurrency: 1 }), []);

  const [zoom, setZoom] = useState(initialZoom);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const [currentPage, setCurrentPage] = useState(initialPage);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  const [panel, setPanel] = useState<'outline' | 'thumbnails' | 'search' | null>(null);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [pageProxyMap, setPageProxyMap] = useState<Record<number, PDFPageProxy>>({});
  const [cacheStats, setCacheStats] = useState<CacheStatsSnapshot | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  const { metrics, resolved, getPage, peekPage, ensurePage } = usePageMetrics(doc, { initialPages: 6 });

  // 设备像素比：限制到 3，避免高 DPR 安卓机渲染超大画布
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3)));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => setDpr(Math.min(window.devicePixelRatio || 1, 3));
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  const fallback = useMemo(() => estimateFallbackSafe(metrics), [metrics]);

  // 基础缩放：连续模式按容器宽度适配
  const baseScale = useMemo(() => {
    if (fitMode === 'none') return 1;
    if (containerWidth <= 0) return 1;
    const first = metrics[0];
    const usable = Math.max(1, containerWidth - padding * 2);
    if (!first) return 1;
    const width = rotation % 180 === 0 ? first.width : first.height;
    const height = rotation % 180 === 0 ? first.height : first.width;
    const byWidth = usable / width;
    return fitMode === 'width' ? byWidth : Math.min(byWidth, (containerHeight - padding * 2) / height);
  }, [fitMode, metrics, containerWidth, containerHeight, padding, rotation]);

  const layout = useMemo(
    () =>
      buildLayout({
        mode,
        metrics,
        fallback,
        scale: baseScale,
        zoom,
        containerWidth,
        containerHeight,
        gap,
        padding,
        rotation,
        fitMode,
        pageCount: doc?.numPages ?? 0,
      }),
    [mode, metrics, fallback, baseScale, zoom, containerWidth, containerHeight, gap, padding, rotation, fitMode, doc?.numPages],
  );

  const virtual = useVirtualPages(scrollRef, {
    boxes: layout.boxes,
    mode,
    viewportWidth: containerWidth,
    viewportHeight: containerHeight,
  });

  // 内容比视口宽时（混排了横向页），把横向滚动位置居中，
  // 否则默认停在最左侧，看起来像页面被裁掉了右半边。
  const centeringRef = useRef(false);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const overflow = layout.contentWidth - containerWidth;
    if (overflow <= 1) {
      centeringRef.current = false;
      return;
    }
    // 只在「用户没有主动横向拖动过」时自动居中，避免抢走用户的滚动意图
    const atEdge = scroller.scrollLeft <= 1 || scroller.scrollLeft >= overflow - 1;
    if (!centeringRef.current && !atEdge && scroller.scrollLeft > 1) return;
    centeringRef.current = true;
    scroller.scrollLeft = overflow / 2;
  }, [layout.contentWidth, containerWidth, layout.boxes.length]);

  // 滚动位置 + 最大滚动量的 ref（手势 hook 需要同步读取，不能依赖 state）
  const scrollInfoRef = useRef({ left: 0, top: 0 });
  const maxScrollRef = useRef({ left: 0, top: 0 });

  useEffect(() => {
    maxScrollRef.current = {
      left: Math.max(0, layout.contentWidth - containerWidth),
      top: Math.max(0, layout.contentHeight - containerHeight),
    };
  }, [layout.contentWidth, layout.contentHeight, containerWidth, containerHeight]);

  // 滚动 → 当前页（rAF 节流，一帧最多一次）
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = rafThrottle(() => {
      countHandled('scroll');
      scrollInfoRef.current = { left: scroller.scrollLeft, top: scroller.scrollTop };
      const horizontal = mode === 'page';
      const offset = horizontal ? scroller.scrollLeft : scroller.scrollTop;
      const viewSize = horizontal ? containerWidth : containerHeight;
      const page = virtual.current;
      void offset;
      void viewSize;
      if (page !== currentPageRef.current) {
        setCurrentPage(page);
        onPageChange?.(page, doc?.numPages ?? 0);
      }
    });
    const onScrollEvent = () => {
      countEvent('scroll');
      onScroll();
    };
    scroller.addEventListener('scroll', onScrollEvent, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScrollEvent);
      onScroll.cancel();
    };
  }, [mode, containerWidth, containerHeight, virtual.current, onPageChange, doc?.numPages]);

  // 虚拟窗口变化时预取页面代理
  const ensureRef = useRef(ensurePage);
  ensureRef.current = ensurePage;
  useEffect(() => {
    for (const pageNumber of virtual.prefetch) ensureRef.current(pageNumber);
  }, [virtual.prefetch]);

  // 预取页面的 proxy（只保留窗口内的，避免 state 无限增长）
  useEffect(() => {
    let cancelled = false;
    const wanted = new Set(virtual.mounted);
    (async () => {
      const updates: Record<number, PDFPageProxy> = {};
      await Promise.all(
        virtual.mounted.map(async (pageNumber) => {
          const cached = peekPage(pageNumber);
          if (cached) {
            updates[pageNumber] = cached;
            return;
          }
          try {
            updates[pageNumber] = await getPage(pageNumber);
          } catch {
            /* ignore */
          }
        }),
      );
      if (cancelled) return;
      setPageProxyMap((prev) => {
        const next: Record<number, PDFPageProxy> = {};
        for (const pageNumber of wanted) {
          const proxy = updates[pageNumber] ?? prev[pageNumber];
          if (proxy) next[pageNumber] = proxy;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [virtual.mounted, getPage, peekPage]);

  // 文档变化：重置状态、清缓存
  useEffect(() => {
    if (!doc) return;
    renderQueue.cancelAll();
    bitmapCache.clear();
    textLayerCache.clear();
    thumbnailCache.clear();
    setPageProxyMap({});
    setSearchHits([]);
    onDocumentLoad?.(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  useEffect(() => {
    if (docState.error) onError?.(docState.error);
  }, [docState.error, onError]);

  const throttledProgress = useMemo(() => throttle((loaded: number, total: number) => onProgress?.(loaded, total), 150), [onProgress]);
  useEffect(() => {
    if (docState.progress) throttledProgress(docState.progress.loaded, docState.progress.total ?? 0);
  }, [docState.progress, throttledProgress]);
  useEffect(() => () => throttledProgress.cancel(), [throttledProgress]);

  // 缩放到指定倍率并保持锚点
  const commitZoom = useCallback(
    (nextZoom: number, left?: number, top?: number) => {
      const scroller = scrollRef.current;
      const clamped = clamp(nextZoom, minZoom, maxZoom);
      setZoom(clamped);
      onZoomChange?.(clamped);
      if (!scroller) return;
      if (left !== undefined && top !== undefined) {
        // 先写 zoom，下一帧布局更新后再恢复滚动位置，保证内容已按新尺寸排好
        requestAnimationFrame(() => {
          scroller.scrollLeft = clamp(left, 0, maxScrollRef.current.left);
          scroller.scrollTop = clamp(top, 0, maxScrollRef.current.top);
        });
      }
    },
    [minZoom, maxZoom, onZoomChange],
  );

  // 模式 / 适配方式切换时重置缩放：
  // 否则从「连续模式放大 2 倍」切到翻页模式，页面会超出屏幕而看起来被裁切。
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    setZoom(1);
    onZoomChange?.(1);
    const scroller = scrollRef.current;
    if (scroller) {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const jumpToPage = useCallback(
    (pageNumber: number, smooth = false) => {
      const target = clamp(Math.round(pageNumber), 1, doc?.numPages ?? 1);
      const scroller = scrollRef.current;
      if (!scroller) return;
      const horizontal = mode === 'page';
      const offset = offsetForPage(layout, target, horizontal ? 'x' : 'y');
      if (smooth) {
        scroller.scrollTo({ [horizontal ? 'left' : 'top']: offset, behavior: 'smooth' } as ScrollToOptions);
      } else if (horizontal) {
        scroller.scrollLeft = offset;
      } else {
        scroller.scrollTop = offset;
      }
      setCurrentPage(target);
      onPageChange?.(target, doc?.numPages ?? 0);
    },
    [doc?.numPages, layout, mode, onPageChange],
  );

  // 初次进入跳到 initialPage
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current || !doc || layout.boxes.length === 0 || containerWidth <= 0) return;
    didInitRef.current = true;
    if (initialPage > 1) {
      // 等一帧让盒子尺寸生效
      requestAnimationFrame(() => jumpToPage(initialPage));
    }
  }, [doc, layout.boxes.length, containerWidth, initialPage, jumpToPage]);

  useEffect(() => {
    didInitRef.current = false;
  }, [src]);

  // 目录跳转：dest 可能是页引用或数组
  const handleInternalLink = useCallback(
    async (dest: string | unknown[] | null) => {
      if (!doc || !dest) return;
      try {
        let resolvedDest: unknown = dest;
        if (typeof dest === 'string') {
          resolvedDest = await doc.getDestination(dest);
        }
        if (!Array.isArray(resolvedDest) || resolvedDest.length === 0) return;
        const ref = resolvedDest[0];
        let pageNumber: number | null = null;
        if (typeof ref === 'number') pageNumber = ref + 1;
        else if (ref && typeof ref === 'object' && 'num' in (ref as object)) {
          const index = await doc.getPageIndex(ref as never);
          pageNumber = index + 1;
        }
        if (pageNumber) jumpToPage(pageNumber, true);
        onInternalLink?.(dest);
      } catch {
        /* 目标无效时忽略 */
      }
    },
    [doc, jumpToPage, onInternalLink],
  );

  // 搜索
  const runSearch = useCallback(
    async (query: string): Promise<SearchHit[]> => {
      if (!doc || !query.trim()) {
        setSearchHits([]);
        return [];
      }
      const hits = await searchDocument(doc, query.trim());
      setSearchHits(hits);
      setSearchIndex(0);
      if (hits.length > 0) jumpToPage(hits[0].pageNumber, true);
      return hits;
    },
    [doc, jumpToPage],
  );

  const clearSearch = useCallback(() => {
    setSearchHits([]);
    setSearchIndex(0);
    const scroller = scrollRef.current;
    if (scroller) {
      for (const mark of scroller.querySelectorAll('.pdfh5-textLayerHost mark')) {
        const parent = mark.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
        parent.normalize();
      }
    }
  }, []);

  // 搜索结果高亮：在文本层 DOM 上做标记
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (searchHits.length === 0) return;
    highlightTextNodes(scroller, searchHits, searchIndex);
  }, [searchHits, searchIndex, renderTick, virtual.mounted]);

  // 工具方法：缓存统计（低频，按需拉取）
  const readStats = useCallback((): CacheStatsSnapshot => {
    const bitmap = bitmapCache.stats();
    const text = textLayerCache.stats();
    const thumbnail = thumbnailCache.stats();
    const renders = renderQueue.getStats();
    return {
      bitmap: {
        entries: bitmap.entries,
        bytes: bitmap.bytes,
        maxBytes: bitmap.maxBytes,
        hits: bitmap.hits,
        misses: bitmap.misses,
        evictions: bitmap.evictions,
      },
      text: {
        entries: text.entries,
        bytes: text.bytes,
        maxBytes: text.maxBytes,
        hits: text.hits,
        misses: text.misses,
        evictions: text.evictions,
      },
      page: { entries: 0, bytes: 0, maxBytes: 0, hits: 0, misses: 0, evictions: 0 },
      thumbnail: {
        entries: thumbnail.entries,
        bytes: thumbnail.bytes,
        maxBytes: thumbnail.maxBytes,
        hits: thumbnail.hits,
        misses: thumbnail.misses,
        evictions: thumbnail.evictions,
      },
      metrics: { entries: resolved },
      renders: {
        started: renders.started,
        completed: renders.completed,
        cancelled: renders.cancelled,
        cacheHits: bitmap.hits,
        cacheMisses: bitmap.misses,
      },
      throttle: readCounters(),
    };
  }, [bitmapCache, textLayerCache, thumbnailCache, renderQueue, resolved]);

  // 每 1s 刷新一次统计（只在面板打开时需要）
  useEffect(() => {
    if (panel !== 'search') return;
    const id = setInterval(() => setCacheStats(readStats()), 1000);
    setCacheStats(readStats());
    return () => clearInterval(id);
  }, [panel, readStats]);

  useImperativeHandle(
    ref,
    () => ({
      getDocument: () => doc,
      getCurrentPage: () => currentPageRef.current,
      goToPage: (page: number, options?: { smooth?: boolean }) => jumpToPage(page, options?.smooth),
      nextPage: () => jumpToPage(currentPageRef.current + 1, true),
      prevPage: () => jumpToPage(currentPageRef.current - 1, true),
      setZoom: (value: number, anchor?: { x: number; y: number }) => {
        if (!anchor) {
          commitZoom(value);
          return;
        }
        const scroller = scrollRef.current;
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        const ratio = clamp(value, minZoom, maxZoom) / zoomRef.current;
        const contentX = anchor.x - rect.left + scroller.scrollLeft;
        const contentY = anchor.y - rect.top + scroller.scrollTop;
        commitZoom(value, contentX * ratio - (anchor.x - rect.left), contentY * ratio - (anchor.y - rect.top));
      },
      zoomIn: (step = 1.25) => commitZoom(zoomRef.current * step),
      zoomOut: (step = 1.25) => commitZoom(zoomRef.current / step),
      resetZoom: () => commitZoom(1),
      search: runSearch,
      clearSearch,
      getCacheStats: readStats,
      clearCaches: () => {
        bitmapCache.clear();
        textLayerCache.clear();
        thumbnailCache.clear();
        setRenderTick((tick) => tick + 1);
      },
      openPanel: (next: 'outline' | 'thumbnails' | 'search' | null) => setPanel(next),
    }),
    [doc, jumpToPage, commitZoom, minZoom, maxZoom, runSearch, clearSearch, readStats, bitmapCache, textLayerCache, thumbnailCache],
  );

  const pinch = usePinchGesture({
    scrollRef,
    contentRef,
    enabled: Boolean(doc) && !panel,
    zoom,
    minZoom,
    maxZoom,
    doubleTapZoom,
    maxScroll: () => maxScrollRef.current,
    onCommit: (nextZoom, left, top) => commitZoom(nextZoom, left, top),
  });

  const handleRendered = useCallback(() => {
    setRenderTick((tick) => tick + 1);
  }, []);

  // 尺寸变化后（旋转屏幕）重新定位到当前页，避免「翻页后回到第 1 页」
  const resizeRef = useRef({ width: containerWidth, height: containerHeight });
  const relayoutDebounced = useMemo(
    () =>
      debounce((pageNumber: number) => {
        jumpToPage(pageNumber);
      }, 120),
    [jumpToPage],
  );
  useEffect(() => {
    const prev = resizeRef.current;
    if (prev.width === 0 || prev.height === 0) {
      resizeRef.current = { width: containerWidth, height: containerHeight };
      return;
    }
    if (prev.width !== containerWidth || prev.height !== containerHeight) {
      resizeRef.current = { width: containerWidth, height: containerHeight };
      relayoutDebounced(currentPageRef.current);
    }
  }, [containerWidth, containerHeight, relayoutDebounced]);
  useEffect(() => () => relayoutDebounced.cancel(), [relayoutDebounced]);

  const totalPages = doc?.numPages ?? 0;

  const centerAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const rect = scroller.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, []);

  if (docState.loading || docState.needPassword || docState.error || !doc) {
    return (
      <div
        className={`pdfh5-root pdfh5-theme-${resolvedTheme} ${className ?? ''}`}
        style={style}
        data-pdfh5-theme={THEME_ATTR[resolvedTheme]}
      >
        <StatusOverlay
          loading={docState.loading}
          needPassword={docState.needPassword}
          passwordReason={docState.passwordReason}
          error={docState.error}
          progress={docState.progress}
          onSubmitPassword={docState.submitPassword}
          onCancelPassword={docState.cancelPassword}
          renderError={renderError}
        />
      </div>
    );
  }

  return (
    <div
      className={`pdfh5-root pdfh5-theme-${resolvedTheme} ${className ?? ''}`}
      style={style}
      data-mode={mode}
      data-pdfh5-theme={THEME_ATTR[resolvedTheme]}
    >
      <div
        className="pdfh5-viewport"
        ref={(node) => {
          (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          // useElementSize 的 ref 是 callback ref，必须调用它才能挂上 ResizeObserver
          viewportRef(node);
        }}
      >
        <div
          className="pdfh5-content"
          ref={contentRef}
          style={{ width: layout.contentWidth, height: layout.contentHeight }}
        >
          {layout.boxes
            .filter((box) => virtual.mounted.includes(box.pageNumber))
            .map((box) => {
              const page = pageProxyMap[box.pageNumber] ?? null;
              const isVisible = virtual.visible.includes(box.pageNumber);
              const isPrefetch = !isVisible && virtual.prefetch.includes(box.pageNumber);
              const displayScale = box.width / (metrics[box.pageNumber - 1]?.width ?? fallback.width);
              return (
                <div
                  key={box.pageNumber}
                  className="pdfh5-page"
                  data-page-number={box.pageNumber}
                  data-visible={isVisible || undefined}
                  style={{
                    transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
                    width: box.width,
                    height: box.height,
                  }}
                >
                  <PageCanvas
                    page={page}
                    pageNumber={box.pageNumber}
                    width={box.width}
                    height={box.height}
                    displayScale={displayScale}
                    devicePixelRatio={dpr}
                    rotation={rotation}
                    bitmapCache={bitmapCache}
                    renderQueue={renderQueue}
                    priority={isVisible ? 'visible' : 'prefetch'}
                    shouldRender={isVisible || isPrefetch}
                    maxCanvasPixels={maxCanvasPixels}
                    maxCanvasDimension={maxCanvasDimension}
                    onRendered={handleRendered}
                  />
                  {textLayer ? (
                    <TextLayer
                      page={page}
                      pageNumber={box.pageNumber}
                      width={box.width}
                      height={box.height}
                      displayScale={displayScale}
                      rotation={rotation}
                      textLayerCache={textLayerCache}
                      renderQueue={renderQueue}
                      enabled={textLayer}
                      shouldBuild={isVisible || isPrefetch}
                    />
                  ) : null}
                  {links ? (
                    <LinkLayer
                      page={page}
                      pageNumber={box.pageNumber}
                      width={box.width}
                      height={box.height}
                      displayScale={displayScale}
                      rotation={rotation}
                      enabled={links}
                      onInternalLink={handleInternalLink}
                      onExternalLink={onExternalLink}
                    />
                  ) : null}
                  <div className="pdfh5-pageNumber">{box.pageNumber}</div>
                </div>
              );
            })}
        </div>
      </div>

      {showControls ? (
        <div className="pdfh5-hud" data-gesture={pinch.active || undefined}>
          <span className="pdfh5-hud-page">
            {currentPage} / {totalPages}
            {resolved < totalPages ? <span className="pdfh5-hud-resolving"> · 解析中</span> : null}
          </span>
          <span className="pdfh5-hud-zoom">{Math.round(zoom * 100)}%</span>
        </div>
      ) : null}

      {toolbar ? (
        <Toolbar
          mode={mode}
          page={currentPage}
          total={totalPages}
          zoom={zoom}
          minZoom={minZoom}
          maxZoom={maxZoom}
          panel={panel}
          panelSupported={{ search: true, outline: true, thumbnails: true }}
          onPrev={() => jumpToPage(currentPageRef.current - 1, true)}
          onNext={() => jumpToPage(currentPageRef.current + 1, true)}
          onJump={(page) => jumpToPage(page)}
          onZoomIn={() => commitZoom(zoomRef.current * 1.25, undefined, undefined)}
          onZoomOut={() => commitZoom(zoomRef.current / 1.25, undefined, undefined)}
          onResetZoom={() => commitZoom(1)}
          onTogglePanel={(next) => setPanel(next)}
          onLocate={() => {
            const anchor = centerAnchor();
            if (anchor) {
              const scroller = scrollRef.current;
              if (!scroller) return;
              const rect = scroller.getBoundingClientRect();
              const ratio = 1 / zoomRef.current;
              commitZoom(
                1,
                (anchor.x - rect.left + scroller.scrollLeft) * ratio - (anchor.x - rect.left),
                (anchor.y - rect.top + scroller.scrollTop) * ratio - (anchor.y - rect.top),
              );
            }
          }}
        />
      ) : null}

      {panel === 'outline' ? (
        <OutlinePanel doc={doc} onClose={() => setPanel(null)} onNavigate={(page) => { setPanel(null); jumpToPage(page, true); }} />
      ) : null}

      {panel === 'thumbnails' ? (
        <ThumbnailPanel
          doc={doc}
          cache={thumbnailCache}
          currentPage={currentPage}
          rotation={rotation}
          onClose={() => setPanel(null)}
          onSelect={(page) => { setPanel(null); jumpToPage(page); }}
        />
      ) : null}

      {panel === 'search' ? (
        <SearchPanel
          hits={searchHits}
          index={searchIndex}
          onSearch={runSearch}
          onSelect={(index) => {
            setSearchIndex(index);
            const hit = searchHits[index];
            if (hit) jumpToPage(hit.pageNumber, true);
          }}
          onClose={() => {
            clearSearch();
            setPanel(null);
          }}
          stats={cacheStats}
          onClearCaches={() => {
            bitmapCache.clear();
            textLayerCache.clear();
            thumbnailCache.clear();
            setRenderTick((tick) => tick + 1);
            setCacheStats(readStats());
          }}
        />
      ) : null}
    </div>
  );
});
