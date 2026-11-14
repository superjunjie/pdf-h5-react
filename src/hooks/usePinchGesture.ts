import { useEffect, useRef, useState } from 'react';
import {
  clamp,
  doubleTapTarget,
  midpoint,
  pinchCommit,
  pinchTransform,
  type PinchGeometry,
  type Point,
} from '../core/gestures';

export interface PinchGestureOptions {
  /** 滚动容器 */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** 承载内容的元素（transform 作用在它身上） */
  contentRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  /** 双击目标倍率 */
  doubleTapZoom: number;
  /** 内容的最大滚动范围计算器 */
  maxScroll: () => { left: number; top: number };
  onCommit(zoom: number, scrollLeft: number, scrollTop: number): void;
  onGestureStart?(): void;
  onGestureEnd?(): void;
}

export interface PinchGestureState {
  /** 捏合中（此时内容走 transform 预演） */
  active: boolean;
  /** 预演 transform；null 表示不预演 */
  preview: PinchGeometry | null;
}

/**
 * 双指捏合 + 双击缩放。
 *
 * 实现要点（移动端性能关键）：
 * 1. 捏合过程中**不**改变真实 zoom，只设置一个 CSS transform 做预演 —— 
 *    transform 只触发合成，不触发布局 / 重绘，因此可以跟手到 60fps；
 * 2. 松手时才提交 zoom + scroll，并清除 transform；
 * 3. 用 pointerdown/move/up 统一处理（iOS Safari 13+ / Android Chrome 均支持），
 *    配合 touch-action: none 阻止浏览器默认的整页缩放；
 * 4. 双击使用本地时间戳判定，不依赖 300ms click 延迟。
 */
export function usePinchGesture(options: PinchGestureOptions): PinchGestureState {
  const { scrollRef, contentRef, enabled } = options;
  const [active, setActive] = useState(false);
  const [preview, setPreview] = useState<PinchGeometry | null>(null);

  // 用 ref 保存最新回调，避免 effect 反复解绑（解绑会让进行中的手势失效）
  const latest = useRef(options);
  latest.current = options;
  const zoomRef = useRef(options.zoom);
  zoomRef.current = options.zoom;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !enabled) return;

    const pointers = new Map<number, Point>();
    let startDistance = 0;
    let startViewport = { left: 0, top: 0, scrollLeft: 0, scrollTop: 0 };
    let startMid: Point = { x: 0, y: 0 };
    let gestureActive = false;
    let frame = 0;
    let pendingMid: Point | null = null;
    let pendingK = 1;

    let lastTapTime = 0;
    let lastTapPoint: Point = { x: 0, y: 0 };

    const applyPreview = () => {
      frame = 0;
      if (!gestureActive || !pendingMid) return;
      const geometry = pinchTransform(startMid, pendingMid, startViewport, pendingK);
      const content = contentRef.current;
      if (content) {
        content.style.transformOrigin = '0 0';
        content.style.transform = `translate3d(${geometry.tx}px, ${geometry.ty}px, 0) scale(${geometry.k})`;
        content.style.willChange = 'transform';
      }
      setPreview(geometry);
    };

    const schedulePreview = (mid: Point, k: number) => {
      pendingMid = mid;
      pendingK = k;
      if (frame) return;
      frame = requestAnimationFrame(applyPreview);
    };

    const resetContentTransform = () => {
      const content = contentRef.current;
      if (content) {
        content.style.transform = '';
        content.style.transformOrigin = '';
        content.style.willChange = '';
      }
      setPreview(null);
    };

    const beginGesture = () => {
      if (gestureActive) return;
      gestureActive = true;
      setActive(true);
      latest.current.onGestureStart?.();
      const rect = scroller.getBoundingClientRect();
      startViewport = {
        left: rect.left,
        top: rect.top,
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
      };
      // 捏合期间关掉惯性滚动，避免 iOS 的回弹叠加在手势上
      scroller.style.overflowAnchor = 'none';
    };

    const endGesture = (commit: boolean) => {
      if (!gestureActive) return;
      gestureActive = false;
      setActive(false);
      resetContentTransform();
      scroller.style.overflowAnchor = '';
      latest.current.onGestureEnd?.();
      if (!commit || pendingMid === null) return;
      const ratio = pendingK;
      if (Math.abs(ratio - 1) < 0.01) return;
      const { left, top } = latest.current.maxScroll();
      const result = pinchCommit(startMid, pendingMid, startViewport, ratio, {
        minZoom: latest.current.minZoom,
        maxZoom: latest.current.maxZoom,
        baseZoom: zoomRef.current,
        maxScrollLeft: left,
        maxScrollTop: top,
      });
      latest.current.onCommit(result.zoom, result.scrollLeft, result.scrollTop);
      pendingMid = null;
      pendingK = 1;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        startDistance = Math.hypot(a.x - b.x, a.y - b.y);
        startMid = midpoint(a, b);
        pendingMid = startMid;
        pendingK = 1;
        beginGesture();
        return;
      }

      if (pointers.size === 1 && event.pointerType !== 'mouse') {
        // 双击检测
        const now = Date.now();
        const point = { x: event.clientX, y: event.clientY };
        const isDoubleTap =
          now - lastTapTime < 300 && Math.hypot(point.x - lastTapPoint.x, point.y - lastTapPoint.y) < 30;
        lastTapTime = now;
        lastTapPoint = point;
        if (isDoubleTap) {
          lastTapTime = 0;
          const rect = scroller.getBoundingClientRect();
          const viewport = {
            left: rect.left,
            top: rect.top,
            scrollLeft: scroller.scrollLeft,
            scrollTop: scroller.scrollTop,
          };
          const target = doubleTapTarget(zoomRef.current, {
            targetZoom: latest.current.doubleTapZoom,
            minZoom: latest.current.minZoom,
            maxZoom: latest.current.maxZoom,
          });
          const { left, top } = latest.current.maxScroll();
          const result = pinchCommit(point, point, viewport, target / zoomRef.current, {
            minZoom: latest.current.minZoom,
            maxZoom: latest.current.maxZoom,
            baseZoom: zoomRef.current,
            maxScrollLeft: left,
            maxScrollTop: top,
          });
          latest.current.onCommit(result.zoom, result.scrollLeft, result.scrollTop);
        }
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size !== 2 || !gestureActive) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = midpoint(a, b);
      if (startDistance <= 0) return;
      const k = clamp(dist / startDistance, 0.2, 8);
      schedulePreview(mid, k);
      // 只有双指时阻止默认行为（单指仍要允许滚动 / 点击链接）
      if (event.cancelable) event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2 && gestureActive) {
        // 双指抬起一只：提交当前缩放
        endGesture(true);
      }
      if (pointers.size === 0) {
        pendingMid = null;
      }
    };

    const onPointerCancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2 && gestureActive) endGesture(false);
    };

    // 桌面端：Ctrl/⌘ + 滚轮 或 触控板捏合（ctrlKey 的 wheel）
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const viewport = {
        left: rect.left,
        top: rect.top,
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
      };
      const ratio = Math.exp(-event.deltaY / 200);
      const { left, top } = latest.current.maxScroll();
      const result = pinchCommit(
        { x: event.clientX, y: event.clientY },
        { x: event.clientX, y: event.clientY },
        viewport,
        ratio,
        {
          minZoom: latest.current.minZoom,
          maxZoom: latest.current.maxZoom,
          baseZoom: zoomRef.current,
          maxScrollLeft: left,
          maxScrollTop: top,
        },
      );
      latest.current.onCommit(result.zoom, result.scrollLeft, result.scrollTop);
    };

    scroller.addEventListener('pointerdown', onPointerDown, { passive: true });
    scroller.addEventListener('pointermove', onPointerMove, { passive: false });
    scroller.addEventListener('pointerup', onPointerUp, { passive: true });
    scroller.addEventListener('pointercancel', onPointerCancel, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('pointerdown', onPointerDown);
      scroller.removeEventListener('pointermove', onPointerMove);
      scroller.removeEventListener('pointerup', onPointerUp);
      scroller.removeEventListener('pointercancel', onPointerCancel);
      scroller.removeEventListener('wheel', onWheel);
      resetContentTransform();
    };
  }, [scrollRef, contentRef, enabled]);

  return { active, preview };
}
