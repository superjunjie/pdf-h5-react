/**
 * 捏合 / 双击 / 滚轮缩放的纯数学部分（可单测，不碰 DOM）。
 *
 * 关键点：内容（页面 + 间距 + 内边距）对 zoom 严格线性，
 * 因此捏合过程中可以用 CSS transform 做「预演」，松手后一次性提交真实 zoom，
 * 两者在同一坐标系下等价，不会出现跳变。
 */

export interface Point {
  x: number;
  y: number;
}

export interface ViewportMetrics {
  /** 容器左上角在视口中的位置（getBoundingClientRect） */
  left: number;
  top: number;
  /** 当前滚动位置 */
  scrollLeft: number;
  scrollTop: number;
}

export interface PinchGeometry {
  /** 预演用的缩放比（相对手势开始时） */
  k: number;
  /** 预演用平移（px），配合 transform-origin: 0 0，作用在滚动容器内的内容元素上 */
  tx: number;
  ty: number;
}

/**
 * 计算捏合预演 transform。
 *
 * 坐标系：transform 作用在「滚动容器内的内容元素」上（transform-origin: 0 0），
 * 因此它以内容坐标系为基准；屏幕位置 = 内容坐标 - scroll。
 *
 * 约束：手势开始时手指中点下方的内容点 c0，必须始终落在当前两指中点处：
 *   k * c0 + t - scroll = v   →   t = v + scroll - k * c0
 * 这样预演与「松手后提交 zoom + scroll」在数学上完全等价，松手不会跳变。
 */
export function pinchTransform(
  startMidpoint: Point,
  currentMidpoint: Point,
  startViewport: ViewportMetrics,
  k: number,
): PinchGeometry {
  const c0x = startMidpoint.x - startViewport.left + startViewport.scrollLeft;
  const c0y = startMidpoint.y - startViewport.top + startViewport.scrollTop;
  const vx = currentMidpoint.x - startViewport.left;
  const vy = currentMidpoint.y - startViewport.top;
  return {
    k,
    tx: vx + startViewport.scrollLeft - k * c0x,
    ty: vy + startViewport.scrollTop - k * c0y,
  };
}

export interface PinchCommit {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

/**
 * 松手后提交：给定新的 zoom，算出保持同一内容点位于当前中点所需的滚动位置。
 */
export function pinchCommit(
  startMidpoint: Point,
  currentMidpoint: Point,
  startViewport: ViewportMetrics,
  ratio: number,
  options: {
    minZoom: number;
    maxZoom: number;
    baseZoom: number;
    maxScrollLeft: number;
    maxScrollTop: number;
  },
): PinchCommit {
  const zoom = clamp(options.baseZoom * ratio, options.minZoom, options.maxZoom);
  // 被夹紧后实际生效的比例（可能小于请求的 ratio）
  const effective = zoom / options.baseZoom;
  const c0x = startMidpoint.x - startViewport.left + startViewport.scrollLeft;
  const c0y = startMidpoint.y - startViewport.top + startViewport.scrollTop;
  const vx = currentMidpoint.x - startViewport.left;
  const vy = currentMidpoint.y - startViewport.top;
  return {
    zoom,
    scrollLeft: clamp(c0x * effective - vx, 0, Math.max(0, options.maxScrollLeft)),
    scrollTop: clamp(c0y * effective - vy, 0, Math.max(0, options.maxScrollTop)),
  };
}

/**
 * 双击 / 双指点击快速放大：以点击点为中心在 fit 与 targetZoom 之间切换。
 */
export function doubleTapTarget(
  currentZoom: number,
  options: { targetZoom: number; minZoom: number; maxZoom: number },
): number {
  const target = clamp(options.targetZoom, options.minZoom, options.maxZoom);
  // 已经接近目标（或更大）时回到 1（适配）
  return currentZoom > target * 0.98 ? 1 : target;
}

/** 以某个视口点为中心缩放（滚轮 / 按钮 / 快捷键共用） */
export function zoomAtPoint(
  anchor: Point,
  viewport: ViewportMetrics,
  ratio: number,
  options: { minZoom: number; maxZoom: number; baseZoom: number; maxScrollLeft: number; maxScrollTop: number },
): PinchCommit {
  return pinchCommit(anchor, anchor, viewport, ratio, options);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
