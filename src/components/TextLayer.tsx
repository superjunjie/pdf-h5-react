import { useEffect, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib } from '../core/pdfjs';
import type { TextLayerCache, TextLayerEntry } from '../core/cache';
import type { RenderQueue } from '../core/renderQueue';
import { RenderCancelledError } from '../core/errors';

export interface TextLayerProps {
  page: PDFPageProxy | null;
  pageNumber: number;
  /** 与画布一致的显示尺寸 */
  width: number;
  height: number;
  displayScale: number;
  rotation: number;
  textLayerCache: TextLayerCache;
  renderQueue: RenderQueue;
  /** 关闭时完全不构建文本层（省内存，代价是不可选中/搜索仍可用） */
  enabled: boolean;
  shouldBuild: boolean;
}

/**
 * 文本层。
 *
 * 性能要点：
 * 1. 文本层构建成本高（几百个 span + 字体测量），按页缓存在 LRU 里；
 * 2. 缩放时优先走 TextLayer.update({ viewport }) 重排，而不是重建 DOM；
 * 3. 一旦缓存里没有可用节点，才重新 streamTextContent 构建。
 */
export function TextLayer({
  page,
  pageNumber,
  width,
  height,
  displayScale,
  rotation,
  textLayerCache,
  renderQueue,
  enabled,
  shouldBuild,
}: TextLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // pdf.js 的 TextLayer 用 --total-scale-factor 换算 span 的字号与位置
  // （见 setLayerDimensions / .textLayer 的 CSS），必须与建层时的 viewport 一致，
  // 否则文字会整体偏移。缩放后这里跟着更新即可，无需重建 DOM。
  const layerScale = page ? page.getViewport({ scale: displayScale, rotation: page.rotate + rotation }).scale : displayScale;
  const userUnit = page?.userUnit ?? 1;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.style.setProperty('--scale-factor', String(layerScale));
    if (userUnit !== 1) host.style.setProperty('--user-unit', String(userUnit));
    else host.style.removeProperty('--user-unit');

    // 缓存的文本层如果档位变了，用 update() 重排（比重建便宜一个数量级）
    const cached = textLayerCache.get(pageNumber);
    if (cached && page && Math.abs(cached.scale - displayScale) > 0.001) {
      const viewport = page.getViewport({ scale: displayScale, rotation: page.rotate + rotation });
      cached.update(viewport);
      cached.scale = displayScale;
      cached.viewportScale = viewport.scale;
    }
  }, [layerScale, userUnit, page, pageNumber, displayScale, rotation, textLayerCache]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();

    if (!enabled) return;

    // 命中缓存：直接挂回 DOM（scroll 回来时不重建）
    const cached = textLayerCache.get(pageNumber);
    if (cached) {
      host.appendChild(cached.node);
      return () => {
        // 交给 LRU 管理，这里只是 detach
        if (cached.node.parentNode === host) host.removeChild(cached.node);
      };
    }

    if (!page || !shouldBuild || width <= 0 || height <= 0) return;

    let cancelled = false;
    const viewport = page.getViewport({ scale: displayScale, rotation: page.rotate + rotation });
    const key = `text:${pageNumber}@${displayScale.toFixed(3)}`;

    renderQueue
      .enqueue(key, 'prefetch', async (signal) => {
        if (signal.aborted) throw new RenderCancelledError();
        const container = document.createElement('div');
        container.className = 'textLayer';
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container,
          viewport,
        });
        await textLayer.render();
        if (signal.aborted) throw new RenderCancelledError();
        return { container, textLayer };
      })
      .then(({ container, textLayer }) => {
        if (cancelled) {
          try {
            textLayer.cancel();
          } catch {
            /* ignore */
          }
          return;
        }
        const entry: TextLayerEntry = {
          pageNumber,
          node: container as HTMLDivElement,
          scale: displayScale,
          viewportScale: viewport.scale,
          bytes: textLayer.textDivs.length * 220,
          update: (nextViewport) => textLayer.update({ viewport: nextViewport as never }),
          destroy: () => {
            try {
              textLayer.cancel();
            } catch {
              /* ignore */
            }
            container.replaceChildren();
          },
        };
        textLayerCache.put(entry);
        host.appendChild(container);
      })
      .catch(() => {
        /* 取消或失败：保持空文本层，不影响阅读 */
      });

    return () => {
      cancelled = true;
      renderQueue.release(key, new RenderCancelledError());
    };
  }, [page, pageNumber, width, height, displayScale, rotation, textLayerCache, renderQueue, enabled, shouldBuild]);

  return <div ref={hostRef} className="pdfh5-textLayerHost" style={{ width, height }} />;
}
