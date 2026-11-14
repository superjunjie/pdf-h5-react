import { useEffect, useRef, useState } from 'react';

export interface VirtualWindow {
  /** 需要真正挂载 DOM 的页（1 基，含首尾） */
  mounted: number[];
  /** 需要渲染位图的页 */
  visible: number[];
  /** 需要预渲染的页（可见区上下各 buffer 屏） */
  prefetch: number[];
  /** 当前阅读页 */
  current: number;
}

export interface UseVirtualPagesOptions {
  /** 页面盒子（来自 computeLayout），左右滚动时用 left/width */
  boxes: ReadonlyArray<{ pageNumber: number; top: number; left: number; width: number; height: number }>;
  mode: 'scroll' | 'page';
  /** 距离可见区多少屏开始预渲染，默认 1.2 */
  prefetchScreens?: number;
  /** 距离可见区多少屏开始挂载 DOM（比预渲染更远，保证快速滚动时不留白） */
  mountScreens?: number;
  /** 容器尺寸 */
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * 虚拟化：只挂载「看得见 + 缓冲」的页面 DOM。
 *
 * 为什么不直接渲染全部：500 页文档每页 2 个 canvas + 数百个 span，
 * DOM 节点数和内存都会直接打爆移动端。
 *
 * 滚动位置由滚动容器自身维护（不用 transform 虚拟滚动），
 * 因为原生滚动的惯性 / 回弹在 iOS 上无法用 JS 复刻。
 */
export function useVirtualPages(
  scrollRef: React.RefObject<HTMLElement | null>,
  options: UseVirtualPagesOptions,
): VirtualWindow {
  const { boxes, mode, viewportWidth, viewportHeight } = options;
  const prefetchScreens = options.prefetchScreens ?? 1.2;
  const mountScreens = options.mountScreens ?? 2.5;

  const [virtualWindow, setWindow] = useState<VirtualWindow>(() => ({
    mounted: boxes.slice(0, 3).map((b) => b.pageNumber),
    visible: boxes.slice(0, 1).map((b) => b.pageNumber),
    prefetch: boxes.slice(0, 2).map((b) => b.pageNumber),
    current: 1,
  }));

  // 最新值放 ref，避免滚动回调闭包过期
  const latest = useRef({ boxes, mode, viewportWidth, viewportHeight, prefetchScreens, mountScreens });
  latest.current = { boxes, mode, viewportWidth, viewportHeight, prefetchScreens, mountScreens };

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || boxes.length === 0) return;

    let frame = 0;
    let lastKey = '';

    const compute = () => {
      frame = 0;
      const { boxes: currentBoxes, mode: currentMode, viewportWidth: vw, viewportHeight: vh } = latest.current;
      if (currentBoxes.length === 0) return;

      const horizontal = currentMode === 'page';
      const scrollPos = horizontal ? scroller.scrollLeft : scroller.scrollTop;
      const viewSize = horizontal ? vw || scroller.clientWidth : vh || scroller.clientHeight;
      const viewStart = scrollPos;
      const viewEnd = scrollPos + viewSize;

      const visible: number[] = [];
      const prefetch: number[] = [];
      const mounted: number[] = [];
      const prefetchPad = viewSize * latest.current.prefetchScreens;
      const mountPad = viewSize * latest.current.mountScreens;

      for (const box of currentBoxes) {
        const begin = horizontal ? box.left : box.top;
        const end = begin + (horizontal ? box.width : box.height);
        if (end > viewStart && begin < viewEnd) visible.push(box.pageNumber);
        if (end > viewStart - prefetchPad && begin < viewEnd + prefetchPad) prefetch.push(box.pageNumber);
        if (end > viewStart - mountPad && begin < viewEnd + mountPad) mounted.push(box.pageNumber);
      }

      // 兜底：任何情况下至少挂载 3 页，避免首屏空白
      if (mounted.length === 0) {
        const first = Math.max(1, Math.round(scrollPos / Math.max(1, viewSize)) + 1);
        for (let i = first; i < first + 3 && i <= currentBoxes.length; i += 1) mounted.push(i);
      }
      if (visible.length === 0) visible.push(mounted[0] ?? 1);
      if (prefetch.length === 0) prefetch.push(...mounted);

      // 当前阅读页：可见页中最靠「阅读起点」的一页
      const current = horizontal
        ? visible[0]
        : (() => {
            // 竖屏下取视口中线所在的页，比取第一页更符合直觉
            const mid = (viewStart + viewEnd) / 2;
            let best = visible[0];
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const pageNumber of visible) {
              const box = currentBoxes[pageNumber - 1];
              if (!box) continue;
              const center = box.top + box.height / 2;
              const distance = Math.abs(center - mid);
              if (distance < bestDistance) {
                bestDistance = distance;
                best = pageNumber;
              }
            }
            return best;
          })();

      const key = `${mounted.join(',')}|${visible.join(',')}|${current}`;
      if (key === lastKey) return;
      lastKey = key;
      setWindow({ mounted, visible, prefetch, current });
    };

    // 滚动用 rAF 节流：高频滚动下每帧最多算一次
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(compute);
    };

    compute();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    globalThis.window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      globalThis.window.removeEventListener('resize', onScroll);
    };
  }, [scrollRef, boxes]);

  return virtualWindow;
}

export interface ScrollProgress {
  current: number;
  total: number;
  ratio: number;
}

/** 缩略图用的懒加载观察器：进入视口才渲染 */
export function useInView<T extends Element>(rootMargin = '200px'): { ref: React.RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}
