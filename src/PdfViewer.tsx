import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { loadPdf, type PdfSource } from './pdfjs';
import {
  anchoredScroll,
  clampCanvasSize,
  computeLayout,
  pageAtOffset,
  quantizePixelRatio,
  viewportScaleFor,
  type PageBox,
  type PageSize,
} from './layout';

/** 同时测量多少页的尺寸（大文档避免一次性打出几百个请求） */
const MEASURE_CONCURRENCY = 8;
/** 最多缓存几张已渲染的位图，超出按 FIFO 淘汰，避免长文档吃爆内存 */
const CANVAS_CACHE_LIMIT = 8;
/** 提前多少屏开始渲染（1 = 前后各一屏） */
const PRELOAD_SCREENS = 1;
/** 双击判定：两次点击的间隔与位移阈值 */
const DOUBLE_TAP_DELAY = 300;
const DOUBLE_TAP_DISTANCE = 30;
/** 按下到抬起移动超过这个距离就不算点击（是拖动） */
const TAP_SLOP = 10;

export interface PdfViewerProps {
  /** PDF 来源：URL / ArrayBuffer / Uint8Array */
  src: PdfSource | null | undefined;
  /** 页间距（px），默认 8 */
  gap?: number;
  /** 内容上下内边距（px），默认 0 */
  padding?: number;
  /** 设备像素比上限，默认 2；调低可显著省内存 */
  maxPixelRatio?: number;
  /** 单页画布像素上限，默认 16777216（iOS Safari 的安全值） */
  maxCanvasPixels?: number;
  /** 单页画布单边上限，默认 8192 */
  maxCanvasDimension?: number;
  /** 是否允许双击放大，默认 true */
  zoomable?: boolean;
  /** 双击放大到的倍率，默认 2 */
  doubleTapZoom?: number;
  className?: string;
  style?: React.CSSProperties;
  onLoad?: (doc: PDFDocumentProxy, total: number) => void;
  onProgress?: (loaded: number, total: number) => void;
  /** 当前阅读页变化（1 基） */
  onPageChange?: (page: number, total: number) => void;
  onError?: (error: Error) => void;
  renderLoading?: () => React.ReactNode;
  renderError?: (error: Error) => React.ReactNode;
}

/**
 * 极简 FIFO 位图缓存：只解决「来回滚动时不必重渲染」，不做内存计量。
 *
 * key 必须带上渲染分辨率（`页码@显示宽度`）—— 双击放大后页面变宽，
 * 若只按页码缓存，就会复用放大前的低分辨率位图，画面发虚。
 *
 * 淘汰时**不能**把 canvas 尺寸置 0 —— 它可能仍挂在页面上（用户正看着），
 * 置 0 会让画面瞬间变空白。这里只丢弃引用，让 GC 在元素卸载后回收。
 */
class CanvasCache {
  private readonly map = new Map<string, HTMLCanvasElement>();

  get(key: string): HTMLCanvasElement | undefined {
    return this.map.get(key);
  }

  set(key: string, canvas: HTMLCanvasElement): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, canvas);
    while (this.map.size > CANVAS_CACHE_LIMIT) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

function rafThrottle(fn: () => void): () => void {
  let frame = 0;
  return () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn();
    });
  };
}

/**
 * 极简 PDF 阅读器：只做「加载 → 分页渲染 → 竖向滚动 → 按宽度适配」。
 *
 * 没有工具栏、文本层、搜索、目录、缩略图、批注、缩放、事件系统。
 * 需要这些能力请用完整版。
 */
export function PdfViewer({
  src,
  gap = 8,
  padding = 0,
  maxPixelRatio = 2,
  maxCanvasPixels = 16_777_216,
  maxCanvasDimension = 8192,
  zoomable = true,
  doubleTapZoom = 2,
  className,
  style,
  onLoad,
  onProgress,
  onPageChange,
  onError,
  renderLoading,
  renderError,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 用 callback ref 而不是 useRef：加载阶段渲染的是占位，滚动容器此时还不存在，
  // 用 useRef 的话第一次 effect 拿不到节点，而 effect 只跑一次，宽度就永远是 0，
  // 所有页面被算成 1×1 像素（表现为整屏空白或极小的图）。
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollEl(node);
  }, []);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(src));
  const [containerWidth, setContainerWidth] = useState(0);
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set());
  const [currentPage, setCurrentPage] = useState(1);
  /** 缩放倍率：1 = 按宽度适配 */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** 缩放后待恢复的滚动位置（等布局生效后再应用） */
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);

  const cacheRef = useRef(new CanvasCache());

  // 回调放 ref，避免它们变化时重建加载流程
  const handlersRef = useRef({ onLoad, onProgress, onPageChange, onError });
  handlersRef.current = { onLoad, onProgress, onPageChange, onError };

  // ---------------- 容器宽度（按宽度适配的依据） ----------------
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const commit = () => {
      const width = el.clientWidth;
      setContainerWidth((prev) => (prev === width ? prev : width));
    };
    commit();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', commit);
      return () => window.removeEventListener('resize', commit);
    }
    const observer = new ResizeObserver(commit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollEl]);

  // ---------------- 加载文档 ----------------
  useEffect(() => {
    if (!src) {
      setDoc(null);
      setSizes([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    setSizes([]);
    cacheRef.current.clear();

    const { task, document } = loadPdf(src, {
      onProgress: (loaded, total) => handlersRef.current.onProgress?.(loaded, total),
    });

    document
      .then(async (loaded) => {
        if (cancelled) return;
        handlersRef.current.onLoad?.(loaded, loaded.numPages);

        // 逐页取尺寸：限制并发，避免大文档一次性打出几百个请求
        const measured: PageSize[] = new Array(loaded.numPages);
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (!cancelled) {
            const index = cursor;
            cursor += 1;
            if (index >= loaded.numPages) return;
            const page = await loaded.getPage(index + 1);
            const viewport = page.getViewport({ scale: 1 });
            measured[index] = { width: viewport.width, height: viewport.height };
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(MEASURE_CONCURRENCY, loaded.numPages) }, () => worker()),
        );

        if (cancelled) return;
        setDoc(loaded);
        setSizes(measured);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        setLoading(false);
        handlersRef.current.onError?.(wrapped);
      });

    return () => {
      cancelled = true;
      // destroy 会中止网络请求并释放 worker 侧资源
      task.destroy().catch(() => {});
      cacheRef.current.clear();
    };
  }, [src]);

  // ---------------- 布局 ----------------
  // 缩放靠「放大布局宽度」实现，而不是 CSS transform：
  // 这样画布会按新尺寸重新渲染，放大后依然清晰（transform 只会把位图拉伸发虚）。
  const layoutWidth = containerWidth > 0 ? containerWidth * zoom : 0;
  const layout = useMemo(
    () => computeLayout({ sizes, containerWidth: layoutWidth, gap, padding }),
    [sizes, layoutWidth, gap, padding],
  );

  const total = doc?.numPages ?? 0;

  // ---------------- 双击缩放 ----------------
  const toggleZoom = useCallback(
    (clientX: number, clientY: number) => {
      const root = scrollEl;
      if (!root || !zoomable) return;
      const rect = root.getBoundingClientRect();
      const offsetX = clientX - rect.left;
      const offsetY = clientY - rect.top;
      const current = zoomRef.current;
      const next = current > 1 ? 1 : Math.max(1.01, doubleTapZoom);
      const ratio = next / current;

      // 等布局按新宽度渲染完再恢复滚动，否则滚动范围还是旧的
      pendingScrollRef.current = {
        left: anchoredScroll(root.scrollLeft, offsetX, ratio),
        top: anchoredScroll(root.scrollTop, offsetY, ratio),
      };
      setZoom(next);
    },
    [scrollEl, zoomable, doubleTapZoom],
  );

  useEffect(() => {
    const root = scrollEl;
    const pending = pendingScrollRef.current;
    if (!root || !pending) return;
    pendingScrollRef.current = null;
    root.scrollLeft = pending.left;
    root.scrollTop = pending.top;
  }, [scrollEl, zoom, layout.contentHeight]);

  // 手动检测双击：不依赖 dblclick（移动端在可滚动容器里常不触发）
  useEffect(() => {
    const root = scrollEl;
    if (!root || !zoomable) return;

    let down: { x: number; y: number } | null = null;
    let lastTap = { time: 0, x: 0, y: 0 };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      down = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start) return;
      // 拖动不算点击
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP) return;

      const now = Date.now();
      const near = Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE;
      if (now - lastTap.time < DOUBLE_TAP_DELAY && near) {
        lastTap = { time: 0, x: 0, y: 0 };
        toggleZoom(event.clientX, event.clientY);
        return;
      }
      lastTap = { time: now, x: event.clientX, y: event.clientY };
    };

    const onPointerCancel = () => {
      down = null;
    };

    root.addEventListener('pointerdown', onPointerDown, { passive: true });
    root.addEventListener('pointerup', onPointerUp, { passive: true });
    root.addEventListener('pointercancel', onPointerCancel, { passive: true });
    return () => {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [scrollEl, zoomable, toggleZoom]);

  // 换文档时回到 1 倍
  useEffect(() => {
    setZoom(1);
  }, [src]);

  // ---------------- 可见页检测 ----------------
  useEffect(() => {
    const root = scrollEl;
    if (!root || !doc || layout.boxes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset.page);
            if (!pageNumber) continue;
            if (entry.isIntersecting) next.add(pageNumber);
            else next.delete(pageNumber);
          }
          return next;
        });
      },
      {
        root,
        // 提前一屏开始渲染，滚动时不至于看到空白
        rootMargin: `${Math.round((root.clientHeight || 600) * PRELOAD_SCREENS)}px 0px`,
      },
    );

    const pages = root.querySelectorAll<HTMLElement>('[data-page]');
    pages.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [scrollEl, doc, layout.boxes]);

  // ---------------- 当前页 ----------------
  useEffect(() => {
    const root = scrollEl;
    if (!root || layout.boxes.length === 0) return;
    const update = rafThrottle(() => {
      const page = pageAtOffset(layout.boxes, root.scrollTop);
      setCurrentPage((prev) => (prev === page ? prev : page));
    });
    root.addEventListener('scroll', update, { passive: true });
    return () => root.removeEventListener('scroll', update);
  }, [scrollEl, layout.boxes]);

  useEffect(() => {
    if (total > 0) handlersRef.current.onPageChange?.(currentPage, total);
  }, [currentPage, total]);

  if (error) {
    if (renderError) return <>{renderError(error)}</>;
    return (
      <div className="pdfv-status pdfv-status-error">
        <p>PDF 加载失败</p>
        <p className="pdfv-detail">{error.message}</p>
      </div>
    );
  }

  if (loading || !doc) {
    if (renderLoading) return <>{renderLoading()}</>;
    return <div className="pdfv-status">加载中…</div>;
  }

  // 容器宽度尚未测量时先只渲染容器，避免用 0 宽度算出一堆 1px 页面
  const measured = containerWidth > 0;

  return (
    <div
      ref={setScrollNode}
      className={`pdfv-root ${className ?? ''}`}
      // 放大后需要横向滚动才能看到页面两侧
      style={{ ...style, overflowX: zoom > 1 ? 'auto' : 'hidden' }}
      data-zoom={zoom > 1 ? String(zoom) : undefined}
    >
      {measured ? (
        <div className="pdfv-content" style={{ width: layoutWidth, height: layout.contentHeight }}>
          {layout.boxes.map((box) => (
            <PageView
              key={box.pageNumber}
              doc={doc}
              box={box}
              active={visiblePages.has(box.pageNumber)}
              maxPixelRatio={maxPixelRatio}
              maxCanvasPixels={maxCanvasPixels}
              maxCanvasDimension={maxCanvasDimension}
              cache={cacheRef.current}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface PageViewProps {
  doc: PDFDocumentProxy;
  box: PageBox;
  active: boolean;
  maxPixelRatio: number;
  maxCanvasPixels: number;
  maxCanvasDimension: number;
  cache: CanvasCache;
}

/**
 * 单页。
 *
 * 画布尺寸的三个量必须分清（详见 layout.ts）：
 *   ratio         = 画布像素 / CSS 像素
 *   viewportScale = 画布像素 / PDF 单位 = displayScale × ratio
 * 把 ratio 直接传给 getViewport 会让渲染内容比画布大，右侧被切掉（文字截断）。
 */
function PageView({ doc, box, active, maxPixelRatio, maxCanvasPixels, maxCanvasDimension, cache }: PageViewProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    holder.replaceChildren();
    setFailed(false);
    if (!active) return;

    // 缓存 key 带上显示宽度，缩放后不会误用旧分辨率的位图
    const cacheKey = `${box.pageNumber}@${Math.round(box.displayWidth)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      mount(holder, cached);
      return;
    }

    let cancelled = false;
    let task: { cancel(): void } | null = null;

    (async () => {
      try {
        const page: PDFPageProxy = await doc.getPage(box.pageNumber);
        if (cancelled) return;

        const ratio = quantizePixelRatio(
          typeof window === 'undefined' ? 1 : window.devicePixelRatio,
          maxPixelRatio,
        );
        const target = clampCanvasSize(box.displayWidth, box.displayHeight, ratio, maxCanvasPixels, maxCanvasDimension);
        const viewportScale = viewportScaleFor(box.displayWidth, box.width, target.ratio);
        const viewport = page.getViewport({ scale: viewportScale, rotation: page.rotate });

        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';

        const renderTask = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
        task = renderTask;

        await renderTask.promise;
        if (cancelled) {
          canvas.width = 0;
          canvas.height = 0;
          return;
        }
        cache.set(cacheKey, canvas);
        mount(holder, canvas);
      } catch (err) {
        if (cancelled) return;
        // 取消渲染是常态（离开视口），不当成错误
        const name = (err as { name?: string })?.name;
        if (name === 'RenderingCancelledException' || name === 'AbortException') return;
        setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, box.pageNumber, box.displayWidth, box.displayHeight, box.width, active, maxPixelRatio, maxCanvasPixels, maxCanvasDimension, cache]);

  return (
    <div
      className="pdfv-page"
      data-page={box.pageNumber}
      style={{
        top: box.top,
        width: box.displayWidth,
        height: box.displayHeight,
      }}
    >
      <div ref={holderRef} className="pdfv-canvas" />
      {failed ? <div className="pdfv-page-error">第 {box.pageNumber} 页渲染失败</div> : null}
    </div>
  );
}

/** canvas 元素只能有一个父节点，挂载前先清空容器 */
function mount(holder: HTMLElement, canvas: HTMLCanvasElement): void {
  if (canvas.parentNode === holder) return;
  holder.replaceChildren(canvas);
}