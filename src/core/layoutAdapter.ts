import type { FitMode, PageMetric, ViewerMode } from '../types';
import { computeLayout, fitScale, offsetForPage, pageAtOffset, type PageBox, type ViewerLayout } from './layout';

export interface LayoutParams {
  mode: ViewerMode;
  metrics: ReadonlyArray<PageMetric | undefined>;
  fallback: { width: number; height: number };
  /** 基础 scale：连续模式下是「按宽度适配」的缩放 */
  scale: number;
  zoom: number;
  containerWidth: number;
  containerHeight: number;
  gap: number;
  padding: number;
  rotation: number;
  fitMode: FitMode;
  pageCount: number;
}

export function buildLayout(params: LayoutParams): ViewerLayout {
  // 未解析的页用 fallback 补齐，保证盒子的数量始终等于页数
  const metrics: Array<PageMetric | undefined> = new Array(params.pageCount);
  for (let i = 0; i < params.pageCount; i += 1) metrics[i] = params.metrics[i];
  return computeLayout({
    mode: params.mode,
    metrics,
    fallback: params.fallback,
    scale: params.scale,
    zoom: params.zoom,
    containerWidth: params.containerWidth,
    containerHeight: params.containerHeight,
    gap: params.gap,
    padding: params.padding,
    rotation: params.rotation,
    fitMode: params.fitMode,
  });
}

export { computeLayout, fitScale, offsetForPage, pageAtOffset };
export type { PageBox, ViewerLayout };

/** 计算基础 scale（适配缩放），与 layout 内部保持同一套规则 */
export function computeBaseScale(params: {
  fitMode: FitMode;
  metrics: ReadonlyArray<PageMetric | undefined>;
  pageIndex: number;
  rotation: number;
  containerWidth: number;
  containerHeight: number;
}): number {
  const { fitMode, metrics, pageIndex, rotation, containerWidth, containerHeight } = params;
  if (fitMode === 'none') return 1;
  const metric = metrics[pageIndex];
  const width = metric ? (rotation % 180 === 0 ? metric.width : metric.height) : 595.28;
  const height = metric ? (rotation % 180 === 0 ? metric.height : metric.width) : 841.89;
  if (width <= 0 || height <= 0) return 1;
  const byWidth = containerWidth / width;
  return fitMode === 'width' ? byWidth : Math.min(byWidth, containerHeight / height);
}

export function estimateFallbackSafe(
  metrics: ReadonlyArray<PageMetric | undefined>,
): { width: number; height: number } {
  let width = 0;
  let height = 0;
  let count = 0;
  for (const metric of metrics) {
    if (!metric) continue;
    width += metric.width;
    height += metric.height;
    count += 1;
  }
  if (count === 0) return { width: 595.28, height: 841.89 };
  return { width: width / count, height: height / count };
}
