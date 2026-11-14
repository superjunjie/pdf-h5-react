import { useEffect, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { clampCanvasSize, quantizePixelRatio, viewportScaleFor } from '../core/layout';
import type { BitmapCache } from '../core/cache';
import { createCacheCanvas } from '../core/cache';
import type { RenderQueue } from '../core/renderQueue';
import { RenderCancelledError } from '../core/errors';

export interface PageCanvasProps {
  page: PDFPageProxy | null;
  pageNumber: number;
  /** 页面在 CSS 中的显示尺寸 */
  width: number;
  height: number;
  /** 显示尺寸对应的 PDF scale（width / pdfWidth） */
  displayScale: number;
  devicePixelRatio: number;
  rotation: number;
  bitmapCache: BitmapCache;
  renderQueue: RenderQueue;
  /** 可见页高优先级，预取页低优先级 */
  priority: 'visible' | 'prefetch';
  /** false 时只显示缓存，不主动渲染（用于远区） */
  shouldRender: boolean;
  maxCanvasPixels?: number;
  maxCanvasDimension?: number;
  onRendered?: (pageNumber: number) => void;
}

/**
 * 单页画布。
 *
 * 性能与正确性要点：
 *
 * 1. **显示 canvas 必须每页独占**：缓存里的是可共享的离屏位图，但 DOM 节点只有一个父节点，
 *    若直接把缓存 canvas 挂进页面，后挂载的页会把前面页的 canvas 抢走（表现为空白）。
 *    所以渲染结果用 drawImage 拷贝到本组件自己的 canvas。
 *
 * 2. **创建与绘制必须在同一个 effect**：拆成两个 effect 时，绘制可能先于创建执行，
 *    拿到的 canvas 是 null，首屏会一直空白。
 *
 * 3. **量化渲染档位**：捏合过程中不重渲染，只有档位跃迁才触发，缩放来回能持续命中 LRU。
 *
 * 4. **取消后必须重试**：渲染任务可能因为「尺寸变化 / 离开视口 / 队列抢占」被取消。
 *    若此时页面仍在屏上，不重试就会留下永久空白 —— 这是最容易漏掉的一类 bug。
 */
export function PageCanvas({
  page,
  pageNumber,
  width,
  height,
  displayScale,
  devicePixelRatio,
  rotation,
  bitmapCache,
  renderQueue,
  priority,
  shouldRender,
  maxCanvasPixels,
  maxCanvasDimension,
  onRendered,
}: PageCanvasProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  /** 已经画到屏幕上的档位 key，用于避免同档位重复绘制 */
  const paintedRef = useRef<string>('');
  /** 重试计数：只对「被取消」重试，且上限很小，避免死循环 */
  const retryRef = useRef(0);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    // 每页独占显示 canvas；尺寸先按目标位图设好，避免出现 300×150 的默认空画布。
    //
    // 三个量必须分清（详见 core/layout.ts 的注释）：
    //   pixelRatio    = 画布像素 / CSS 像素      ≈ DPR（量化后）
    //   target.scale  = 画布像素 / CSS 像素      → 决定画布尺寸
    //   viewportScale = 画布像素 / PDF 单位      → 传给 getViewport
    // 混淆 pixelRatio 与 viewportScale 会让渲染内容比画布大，右侧被切掉（文字截断）。
    const pixelRatio = quantizePixelRatio(devicePixelRatio);
    const target = clampCanvasSize(width, height, pixelRatio, {
      maxPixels: maxCanvasPixels,
      maxDimension: maxCanvasDimension,
    });

    // 用页面实际 PDF 宽度换算 viewport scale，保证渲染内容精确铺满画布
    const pdfWidth = width / (displayScale || 1);
    const viewportScale = viewportScaleFor(width, pdfWidth, target.scale);

    const canvas = document.createElement('canvas');
    if (target.width > 0 && target.height > 0) {
      canvas.width = target.width;
      canvas.height = target.height;
    }
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    holder.replaceChildren(canvas);
    holder.removeAttribute('data-painted');

    const paint = (source: HTMLCanvasElement | OffscreenCanvas, pw: number, ph: number, key: string) => {
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, pw, ph);
      context.drawImage(source as CanvasImageSource, 0, 0, pw, ph);
      paintedRef.current = key;
      holder.setAttribute('data-painted', '1');
    };

    // ---------------- 1) 命中缓存：同步绘制，零成本 ----------------
    // 缓存 key 用 viewportScale（渲染内容分辨率），它是唯一决定位图内容的量。
    const cached = bitmapCache.get(pageNumber, viewportScale);
    if (cached) {
      paint(cached.canvas, cached.width, cached.height, `cached:${cached.scale}`);
      return;
    }

    if (!page || !shouldRender || width <= 0 || height <= 0) return;

    // ---------------- 2) 命中同档位缓存 ----------------
    const key = `${pageNumber}@${viewportScale.toFixed(3)}`;
    const hit = bitmapCache.get(pageNumber, viewportScale);
    if (hit) {
      paint(hit.canvas, hit.width, hit.height, key);
      return;
    }

    // ---------------- 3) 提交渲染 ----------------
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const viewport = page.getViewport({ scale: viewportScale, rotation: page.rotate + rotation });

    const render = (): void => {
      if (disposed) return;
      const offscreen = createCacheCanvas(target.width, target.height);
      renderQueue
        .enqueue(key, priority, async (signal) => {
          if (signal.aborted) throw new RenderCancelledError();
          const task = page.render({ canvas: offscreen, canvasContext: offscreen.getContext('2d')!, viewport });
          const onAbort = () => task.cancel();
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            await task.promise;
          } catch (error) {
            if (signal.aborted) throw new RenderCancelledError();
            throw error;
          } finally {
            signal.removeEventListener('abort', onAbort);
          }
          return { canvas: offscreen, width: target.width, height: target.height };
        })
        .then((result) => {
          bitmapCache.put(pageNumber, viewportScale, result.canvas);
          if (disposed) return;
          paint(result.canvas, result.width, result.height, key);
          onRenderedRef.current?.(pageNumber);
        })
        .catch((error: unknown) => {
          if (disposed) return;
          // 被取消（尺寸变化 / 抢占 / 离开视口后又回来）时，只要页面仍在屏上就重试。
          // 不重试会留下永久空白 —— 这正是首屏偶发空页的根因。
          if (error instanceof RenderCancelledError && retryRef.current < 4) {
            retryRef.current += 1;
            retryTimer = setTimeout(render, 60);
          }
        });
    };

    render();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      holder.removeAttribute('data-painted');
    };
  }, [
    page,
    pageNumber,
    width,
    height,
    displayScale,
    devicePixelRatio,
    rotation,
    bitmapCache,
    renderQueue,
    priority,
    shouldRender,
    maxCanvasPixels,
    maxCanvasDimension,
  ]);

  // 尺寸变化只会重设 holder 大小，不影响已画好的 canvas
  return <div ref={holderRef} className="pdfh5-canvas" style={{ width, height }} aria-hidden="true" />;
}
