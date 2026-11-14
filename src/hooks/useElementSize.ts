import { useCallback, useEffect, useRef, useState } from 'react';
import { countEvent, countHandled } from '../core/metrics';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * 观察容器尺寸。
 *
 * 关键点：必须用 callback ref 而不是 useRef + 挂载时 effect。
 * 因为调用方常常「先渲染 loading 占位、加载完才渲染容器」，
 * 用 useRef 的话首帧 ref 还是 null，effect 不会再跑，尺寸就永远停在 0。
 *
 * ResizeObserver 在拖动窗口 / 旋转屏幕时会连发多次，这里每帧合并一次再写 state。
 */
export function useElementSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const frame = useRef(0);

  const ref = useCallback((node: T | null) => setElement(node), []);

  useEffect(() => {
    if (!element) return;

    const commit = (width: number, height: number) => {
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    const measureNow = () => commit(element.clientWidth, element.clientHeight);
    measureNow();

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => {
        countEvent('size');
        measureNow();
        countHandled('size');
      };
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      countEvent('size');
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        countHandled('size');
        commit(Math.round(width), Math.round(height));
      });
    });
    observer.observe(element);

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      observer.disconnect();
    };
  }, [element]);

  return { ref, width: size.width, height: size.height } as const;
}
