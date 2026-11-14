import { useCallback } from 'react';
import { PdfH5Reader } from './components/PdfH5Reader';
import type { PdfH5ReaderProps as ReaderProps } from './components/PdfH5Reader';
import type { PdfH5ReaderHandle as ReaderHandle } from './types';

export { PdfH5Reader };
export type PdfH5ReaderProps = ReaderProps;
export type PdfH5ReaderHandle = ReaderHandle;

export { configurePdfjs, getPdfjsRuntimeOptions, loadPdf, loadPdfDocument, pdfjsLib } from './core/pdfjs';
export type { PdfjsRuntimeOptions } from './core/pdfjs';

export { LruCache } from './core/lru';
export type { LruCacheOptions, LruCacheStats } from './core/lru';
export { EventEmitter } from './core/eventEmitter';
export type { Listener } from './core/eventEmitter';
export type {
  ReaderEvents,
  ReaderEventName,
  ReaderEventPayload,
  ReaderStatus,
  RenderTiming,
  ScrollEventPayload,
  ZoomEventPayload,
} from './core/readerEvents';
export { animateZoom, shouldReduceMotion } from './core/zoomAnimation';
export type { AnimationHandle, ZoomAnimationOptions } from './core/zoomAnimation';
export { rafThrottle, throttle, debounce, rafBatch } from './core/throttle';
export type { Cancelable } from './core/throttle';
export { BitmapCache, TextLayerCache, PageProxyCache, ThumbnailCache } from './core/cache';
export { RenderQueue } from './core/renderQueue';
export { computeLayout, pageAtOffset, offsetForPage, quantizeScale, quantizePixelRatio, viewportScaleFor, clampCanvasSize, bitmapBytes } from './core/layout';export type { PageBox, ViewerLayout } from './core/layout';
export { pinchTransform, pinchCommit, doubleTapTarget, zoomAtPoint } from './core/gestures';

export { usePdfDocument } from './hooks/usePdfDocument';
export type { PdfDocumentState } from './hooks/usePdfDocument';
export { usePageMetrics } from './hooks/usePageMetrics';
export { usePinchGesture } from './hooks/usePinchGesture';
export { useVirtualPages } from './hooks/useVirtualPages';
export { useElementSize } from './hooks/useElementSize';

export { searchDocument, extractPageText, clearSearchCache } from './lib/search';
export { flattenOutline } from './lib/outline';
export type { OutlineEntry } from './lib/outline';
export { makeSnippet, splitSnippet, findInPage } from './lib/text';
export { highlightTextNodes } from './lib/highlight';
export { createThumbnailCanvas } from './lib/thumbnail';

export type {
  CacheStatsSnapshot,
  FitMode,
  LoadProgress,
  PageMetric,
  PdfSource,
  SearchHit,
  ThemeMode,
  ViewerMode,
} from './types';

import './styles/index.css';

// 便捷 hook：把 ref 与常用操作打包，减少使用方的样板代码
export function usePdfH5ReaderActions(ref: React.RefObject<PdfH5ReaderHandle | null>) {
  const next = useCallback(() => ref.current?.nextPage(), [ref]);
  const prev = useCallback(() => ref.current?.prevPage(), [ref]);
  const goTo = useCallback((page: number) => ref.current?.goToPage(page), [ref]);
  const zoomIn = useCallback(() => ref.current?.zoomIn(), [ref]);
  const zoomOut = useCallback(() => ref.current?.zoomOut(), [ref]);
  const resetZoom = useCallback(() => ref.current?.resetZoom(), [ref]);
  return { next, prev, goTo, zoomIn, zoomOut, resetZoom };
}
