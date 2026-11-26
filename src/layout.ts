/**
 * 版面与画布尺寸计算（纯函数，便于单测）。
 *
 * 这里集中处理 PDF 阅读器最容易出错的两个换算，务必分清：
 *
 *   displayScale  = CSS 显示宽 / PDF 宽      —— 页面在屏幕上的大小（窄屏 A4 约 0.61）
 *   pixelRatio    = 画布像素 / CSS 像素      —— ≈ 设备像素比
 *   viewportScale = 画布像素 / PDF 单位      —— 传给 page.getViewport 的值
 *
 * 记忆关系：viewportScale = displayScale × pixelRatio
 *
 * 常见错误（都会导致「文字被截断」）：
 *   1. 给 displayScale 加下限（如 Math.max(scale, 1)）再乘 DPR —— 画布远大于显示区域，
 *      浏览器只显示左上角。
 *   2. 把 pixelRatio 直接传给 getViewport —— 渲染内容比画布大 1/displayScale 倍，右侧被切。
 */

export interface PageSize {
  /** PDF 原始宽（用户单位） */
  width: number;
  /** PDF 原始高（用户单位） */
  height: number;
}

export interface PageBox extends PageSize {
  pageNumber: number;
  /** 相对内容容器顶部偏移（px） */
  top: number;
  /** 显示宽高（px） */
  displayWidth: number;
  displayHeight: number;
}

export interface LayoutOptions {
  sizes: ReadonlyArray<PageSize>;
  /** 容器可用宽度（px） */
  containerWidth: number;
  /** 页间距（px） */
  gap: number;
  /** 内容上下内边距（px） */
  padding: number;
}

export interface LayoutResult {
  boxes: PageBox[];
  contentHeight: number;
  /** 全篇统一缩放：CSS 显示宽 / PDF 宽 */
  scale: number;
}

/**
 * 计算竖向连续布局。
 *
 * 全篇用同一个 scale（以第一页宽度适配容器），因此各页宽度一致、视觉整齐；
 * 若文档混排了更宽的页，最宽页仍会超出容器 —— 这是有意为之：
 * 为了可读性宁可横向滚动，也不把全部页面按最宽页缩小。
 */
export function computeLayout(options: LayoutOptions): LayoutResult {
  const { sizes, containerWidth, gap, padding } = options;
  if (sizes.length === 0) {
    return { boxes: [], contentHeight: 0, scale: 1 };
  }

  const usableWidth = Math.max(1, containerWidth);
  const first = sizes[0];
  const scale = first.width > 0 ? usableWidth / first.width : 1;

  const boxes: PageBox[] = [];
  let top = Math.max(0, padding);

  for (let i = 0; i < sizes.length; i += 1) {
    const size = sizes[i];
    const displayWidth = size.width * scale;
    const displayHeight = size.height * scale;
    boxes.push({
      pageNumber: i + 1,
      width: size.width,
      height: size.height,
      top,
      displayWidth,
      displayHeight,
    });
    top += displayHeight + gap;
  }

  // 去掉最后一个 gap，再加上下内边距
  const contentHeight = Math.max(0, top - gap) + Math.max(0, padding);
  return { boxes, contentHeight, scale };
}

/**
 * 把设备像素比量化到固定档位。
 *
 * 量化是为了让「同一视觉尺寸」始终用同一个画布分辨率，
 * 避免窗口轻微变化就重复渲染。
 */
export function quantizePixelRatio(devicePixelRatio: number, maxRatio = 3): number {
  const ratio = Math.min(Math.max(devicePixelRatio || 1, 1), maxRatio);
  const steps = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3];
  let best = steps[0];
  let bestDiff = Math.abs(steps[0] - ratio);
  for (const step of steps) {
    const diff = Math.abs(step - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = step;
    }
  }
  // 偏差超过 6% 时用原值，宁可少一次复用也不要画质明显劣化
  return Math.abs(best - ratio) / ratio > 0.06 ? ratio : best;
}

/** 画布像素宽 = CSS 显示宽 × pixelRatio；同时对 iOS 的尺寸上限做保护 */
export function clampCanvasSize(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number,
  maxPixels = 16_777_216,
  maxDimension = 8192,
): { width: number; height: number; ratio: number } {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  let ratio = pixelRatio > 0 ? pixelRatio : 1;

  const byDimension = Math.min(maxDimension / w, maxDimension / h);
  const byPixels = Math.sqrt(maxPixels / (w * h));
  const allowed = Math.min(byDimension, byPixels);
  if (allowed < ratio) ratio = allowed;

  return {
    width: Math.max(1, Math.floor(w * ratio)),
    height: Math.max(1, Math.floor(h * ratio)),
    ratio,
  };
}

/** 传给 page.getViewport 的 scale */
export function viewportScaleFor(cssWidth: number, pdfWidth: number, canvasRatio: number): number {
  if (!(cssWidth > 0) || !(pdfWidth > 0)) return canvasRatio;
  return (cssWidth / pdfWidth) * canvasRatio;
}

/** 二分查找：给定滚动位置，返回当前阅读页（1 基） */
export function pageAtOffset(boxes: ReadonlyArray<PageBox>, offset: number): number {
  if (boxes.length === 0) return 1;
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const box = boxes[mid];
    if (offset < box.top) hi = mid - 1;
    else if (offset >= box.top + box.displayHeight) lo = mid + 1;
    else return box.pageNumber;
  }
  const next = boxes[Math.min(lo, boxes.length - 1)];
  const prev = boxes[Math.max(hi, 0)];
  const toNext = Math.abs(next.top - offset);
  const toPrev = Math.abs(offset - (prev.top + prev.displayHeight));
  return toNext < toPrev ? next.pageNumber : prev.pageNumber;
}