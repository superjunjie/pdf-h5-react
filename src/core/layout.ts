/**
 * 版面数学：全部是纯函数，便于单测和跨端复用。
 *
 * 坐标约定：
 * - 所有尺寸单位都是 CSS px；
 * - `scale` = 1 单位 PDF → CSS px 的比例（已含 userUnit 之外的换算）；
 * - 页面盒子 (top,left,width,height) 相对内容容器左上角。
 */
import type { FitMode, PageMetric, ViewerMode } from '../types';

export interface PageSize {
  width: number;
  height: number;
}

export interface PageBox extends PageSize {
  pageNumber: number;
  top: number;
  left: number;
  /** 该页实际使用的缩放（翻页模式下每页独立适配） */
  scale: number;
}

export interface ViewerLayout {
  boxes: PageBox[];
  contentWidth: number;
  contentHeight: number;
  /** 连续模式下页面宽度上限（用于把内容容器撑开） */
  widest: number;
  mode: ViewerMode;
}

export interface LayoutInput {
  mode: ViewerMode;
  /** 每页的度量，index 0 对应第 1 页；缺省用 fallback 顶替 */
  metrics: ReadonlyArray<PageMetric | undefined>;
  fallback: PageSize;
  /** 连续模式下的统一缩放 */
  scale: number;
  /** 用户缩放倍率（1 = 适配），用于缩放间距，保证捏合锚点数学精确 */
  zoom: number;
  containerWidth: number;
  containerHeight: number;
  /** 基础间距（未乘 zoom） */
  gap: number;
  padding: number;
  rotation: number;
  fitMode: FitMode;
}

/** 旋转后的显示尺寸（未缩放） */
export function rotatedSize(metric: PageMetric, extraRotation: number): PageSize {
  const total = ((metric.rotate + extraRotation) % 360 + 360) % 360;
  return total % 180 === 0
    ? { width: metric.width, height: metric.height }
    : { width: metric.height, height: metric.width };
}

/** 适配缩放：fit-width 按宽度铺满，fit-page 整页可见 */
export function fitScale(size: PageSize, container: PageSize, fitMode: FitMode): number {
  if (fitMode === 'none') return 1;
  if (size.width <= 0 || size.height <= 0) return 1;
  const byWidth = container.width / size.width;
  if (fitMode === 'width') return byWidth;
  return Math.min(byWidth, container.height / size.height);
}

export function computeLayout(input: LayoutInput): ViewerLayout {
  const { mode, metrics, fallback, scale, zoom, containerWidth, containerHeight, rotation, fitMode } = input;
  const gap = Math.max(0, input.gap * zoom);
  const padding = Math.max(0, input.padding * zoom);

  if (mode === 'page') {
    // 翻页模式：每页独占一屏。fit=page 时页面在格子内居中；
    // fit=width 且放大时，页面可能高于容器，此时顶部对齐（否则上半部分会被推到视口外）。
    const boxes: PageBox[] = [];
    for (let i = 0; i < metrics.length; i += 1) {
      const metric = metrics[i];
      const size = metric
        ? rotatedSize(metric, rotation)
        : { width: fallback.width, height: fallback.height };
      const pageScale =
        fitMode === 'none'
          ? scale
          : fitScale(size, { width: containerWidth, height: containerHeight }, fitMode) * zoom;
      const width = size.width * pageScale;
      const height = size.height * pageScale;
      boxes.push({
        pageNumber: i + 1,
        // 超出容器时顶部对齐，否则垂直居中
        top: height >= containerHeight ? 0 : (containerHeight - height) / 2,
        left: i * containerWidth + (containerWidth - width) / 2,
        width,
        height,
        scale: pageScale,
      });
    }
    return {
      boxes,
      contentWidth: Math.max(containerWidth, metrics.length * containerWidth),
      contentHeight: containerHeight,
      widest: containerWidth,
      mode,
    };
  }

  // 连续滚动：每页「独立适配容器宽度」。
  //
  // 为什么不是全篇统一 scale：文档里常混排 A4 / 横向 A4 / 窄页。
  // 统一 scale 只有两种结局——按第一页算，横向页超出视口（文字被截断）；
  // 按最宽页算，所有竖页被缩小 30%（字变小）。
  // 两者都不可接受，所以每页各自适配：渲染宽度一律等于可用宽度，
  // 既不会溢出，也不会因为别的页面而变小。
  //
  // 线性性（捏合预演的前提）依然成立：
  //   renderWidth_i = usableWidth × zoom        （usableWidth 只与容器有关）
  //   contentWidth  = containerWidth × zoom
  //   left_i        = (contentWidth − renderWidth_i) / 2 = padding0 × zoom
  // 即页面位置与尺寸都严格正比于 zoom，所以松手提交后不会跳变。
  const pageSizes: PageSize[] = metrics.map((metric) =>
    metric ? rotatedSize(metric, rotation) : { width: fallback.width, height: fallback.height },
  );

  // 注意：可用宽度必须用「未乘 zoom」的内边距计算，否则基准缩放会随 zoom 漂移，
  // 内容就不再对 zoom 线性，捏合预演会与提交结果错位。
  const padding0 = Math.max(0, input.padding);
  const usableWidth = Math.max(1, containerWidth - padding0 * 2);

  const boxes: PageBox[] = [];
  let top = padding; // padding 已乘 zoom
  let widest = 0;

  for (let i = 0; i < pageSizes.length; i += 1) {
    const size = pageSizes[i];
    // fit=width：渲染宽度填满可用宽度；fit=none：沿用调用方给的 scale
    const pageScale =
      fitMode === 'none'
        ? scale * zoom
        : size.width > 0
          ? (usableWidth / size.width) * zoom
          : scale * zoom;
    const width = size.width * pageScale;
    const height = size.height * pageScale;
    widest = Math.max(widest, width);
    boxes.push({ pageNumber: i + 1, top, left: 0, width, height, scale: pageScale });
    top += height + gap;
  }

  // 内容宽度：zoom 为 1 时恰好等于视口宽；放大后按比例变宽（允许横向滚动看细节）
  const contentWidth = Math.max(containerWidth, containerWidth * zoom);
  // 逐页水平居中（每页宽度不同，各自居中）
  for (const box of boxes) {
    box.left = (contentWidth - box.width) / 2;
  }

  const contentHeight = Math.max(containerHeight, top - (pageSizes.length ? gap : 0) + padding);

  return { boxes, contentWidth, contentHeight, widest, mode };
}

/**
 * 二分查找「当前阅读页」：返回覆盖 offset 的页面；落在间隙里则取最近的一页。
 */
export function pageAtOffset(boxes: ReadonlyArray<PageBox>, offset: number, axis: 'y' | 'x' = 'y'): number {
  if (boxes.length === 0) return 1;
  const start = (box: PageBox) => (axis === 'y' ? box.top : box.left);
  const size = (box: PageBox) => (axis === 'y' ? box.height : box.width);

  let lo = 0;
  let hi = boxes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const box = boxes[mid];
    const begin = start(box);
    const end = begin + size(box);
    if (offset < begin) hi = mid - 1;
    else if (offset >= end) lo = mid + 1;
    else return box.pageNumber;
  }
  // 落在间隙：比较前后两页的距离
  const next = boxes[Math.min(lo, boxes.length - 1)];
  const prev = boxes[Math.max(hi, 0)];
  const distanceNext = Math.abs(start(next) - offset);
  const distancePrev = Math.abs(offset - (start(prev) + size(prev)));
  return distanceNext < distancePrev ? next.pageNumber : prev.pageNumber;
}

/** 滚动到指定页所需的 scrollTop / scrollLeft（让页面顶部对齐容器顶部） */
export function offsetForPage(
  layout: ViewerLayout,
  pageNumber: number,
  axis: 'y' | 'x' = 'y',
  align: 'start' | 'center' = 'start',
): number {
  const box = layout.boxes[pageNumber - 1];
  if (!box) return 0;
  if (axis === 'x') return align === 'center' ? box.left + box.width / 2 : box.left;
  return box.top;
}

/**
 * 缩放锚点换算：保持 anchor 处的「内容坐标」不动。
 *
 * 因为内容（含间距 / 内边距）整体按 zoom 同比缩放，内容坐标可线性映射：
 *   content' = content * k,  k = newZoom / oldZoom
 * 于是新的滚动位置 = content' - anchor。
 */
export function anchoredScroll(
  scroll: number,
  anchorViewportOffset: number,
  ratio: number,
): number {
  const content = scroll + anchorViewportOffset;
  return Math.max(0, content * ratio - anchorViewportOffset);
}

/**
 * 把渲染分辨率量化到固定档位，命中缓存（缩放来回时不重复渲染）。
 * 返回「不小于 value 的最小档位」，没有更大档位时返回最后一档与 value 的较大者。
 */
export const DEFAULT_SCALE_STEPS = [
  0.25, 0.35, 0.5, 0.7, 0.85, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 16,
] as const;

export function quantizeScale(value: number, steps: ReadonlyArray<number> = DEFAULT_SCALE_STEPS): number {
  if (!(value > 0)) return 1;
  for (const step of steps) {
    if (step >= value) return step;
  }
  return Math.max(steps[steps.length - 1], value);
}

/**
 * 量化「设备像素比」，用于决定画布分辨率。
 *
 * 注意这里只处理 DPR —— 不掺任何页面缩放。
 * 画布像素 = CSS 尺寸 × 本函数返回值，viewport scale 见 viewportScaleFor。
 *
 * 量化到固定档位是为了让缩放来回时能命中同一份位图缓存；
 * 误差控制在 6% 内（视觉不可辨），超过则直接用精确值，宁可少一次命中也不牺牲画质。
 */
export function quantizePixelRatio(devicePixelRatio: number, maxDpr = 3): number {
  const dpr = Math.min(Math.max(devicePixelRatio || 1, 1), maxDpr);
  const steps = [
    1, 1.1, 1.25, 1.4, 1.5, 1.6, 1.75, 2, 2.25, 2.5, 2.75, 3,
  ];
  let best = steps[0];
  let bestDiff = Math.abs(steps[0] - dpr);
  for (const step of steps) {
    if (step > maxDpr) break;
    const diff = Math.abs(step - dpr);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = step;
    }
  }
  if (Math.abs(best - dpr) / dpr > 0.06) return dpr;
  return best;
}

export interface CanvasLimitOptions {
  /** 总像素上限，iOS 上建议 <= 16.7M */
  maxPixels?: number;
  /** 单边上限，iOS 上建议 <= 4096~8192 */
  maxDimension?: number;
}

export interface CanvasSize {
  width: number;
  height: number;
  /** 实际生效的缩放（可能因限幅而小于请求值） */
  scale: number;
  clamped: boolean;
}

/**
 * 计算 canvas 的像素尺寸并在必要时限幅。
 *
 * 注意 scale 的语义：**画布像素 / CSS 像素**（不是 pdf.js 的 viewport scale）。
 * 它不能直接传给 getViewport —— 中间还差一个「CSS 像素 / PDF 单位」的换算，
 * 见 viewportScaleFor。
 *
 * 移动端 canvas 有硬上限（iOS Safari 约 16.7M 像素、单边 8192），超限会得到空白画布，
 * 所以宁可降分辨率也要限幅。
 */
export function clampCanvasSize(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number,
  options: CanvasLimitOptions = {},
): CanvasSize {
  const maxPixels = options.maxPixels ?? 16_777_216;
  const maxDimension = options.maxDimension ?? 8192;

  const safeWidth = Math.max(1, cssWidth);
  const safeHeight = Math.max(1, cssHeight);
  let ratio = pixelRatio > 0 ? pixelRatio : 1;

  const byDimension = Math.min(maxDimension / safeWidth, maxDimension / safeHeight);
  const byPixels = Math.sqrt(maxPixels / (safeWidth * safeHeight));
  const allowed = Math.min(byDimension, byPixels);
  let clamped = false;
  if (allowed < ratio) {
    ratio = allowed;
    clamped = true;
  }

  return {
    width: Math.max(1, Math.floor(safeWidth * ratio)),
    height: Math.max(1, Math.floor(safeHeight * ratio)),
    scale: ratio,
    clamped,
  };
}

/**
 * 计算应当传给 `page.getViewport({ scale })` 的值。
 *
 * pdf.js 用「PDF 单位 × scale」算渲染尺寸，因此必须把
 * 「画布像素 / CSS 像素」再乘上「CSS 像素 / PDF 单位」。
 *
 * 若直接把 clampCanvasSize 返回的 scale 传给 getViewport，
 * 渲染内容会比画布大 1/displayScale 倍（窄屏 A4 约 1.63 倍），右侧被画布边界切掉，
 * 表现就是「文字被截断」。
 */
export function viewportScaleFor(cssWidth: number, pdfWidth: number, canvasPixelRatio: number): number {
  if (!(cssWidth > 0) || !(pdfWidth > 0)) return canvasPixelRatio;
  return (cssWidth / pdfWidth) * canvasPixelRatio;
}

/** 位图内存估算（RGBA） */
export function bitmapBytes(width: number, height: number): number {
  return Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height)) * 4;
}
