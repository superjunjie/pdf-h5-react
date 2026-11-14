import { describe, expect, it } from 'vitest';
import {
  clamp,
  distance,
  doubleTapTarget,
  midpoint,
  pinchCommit,
  pinchTransform,
  zoomAtPoint,
} from './gestures';
import { anchoredScroll, computeLayout, pageAtOffset, quantizeScale } from './layout';
import type { PageMetric } from '../types';

const metric = (w: number, h: number, pageNumber = 1, rotate = 0): PageMetric => ({
  pageNumber,
  width: w,
  height: h,
  rotate,
  userUnit: 1,
});

describe('gestures', () => {
  const viewport = { left: 0, top: 0, scrollLeft: 100, scrollTop: 200 };
  const start = { x: 150, y: 300 };

  it('捏合时手指下的内容点保持不动', () => {
    // 手势开始：内容点 c0 = start + scroll = (250, 500)
    // 中点不动、放大 2 倍：屏幕位置 = k*c0 + t - scroll = start
    const g = pinchTransform(start, start, viewport, 2);
    expect(g.k).toBe(2);
    expect(2 * 250 + g.tx - 100).toBeCloseTo(150);
    expect(2 * 500 + g.ty - 200).toBeCloseTo(300);
  });

  it('中点移动时预演同步跟随（等效平移）', () => {
    const g = pinchTransform(start, { x: 170, y: 320 }, viewport, 1);
    expect(g.tx).toBeCloseTo(20);
    expect(g.ty).toBeCloseTo(20);
  });

  it('预演 transform 与提交后的 zoom+scroll 等价（松手不跳变）', () => {
    const ratio = 2;
    const moved = { x: 170, y: 320 };
    const g = pinchTransform(start, moved, viewport, ratio);
    const commit = pinchCommit(start, moved, viewport, ratio, {
      minZoom: 1,
      maxZoom: 4,
      baseZoom: 1,
      maxScrollLeft: 1e6,
      maxScrollTop: 1e6,
    });
    // 同一内容点 c0 在预演中的屏幕位置，应等于提交后的屏幕位置
    const c0 = { x: start.x - viewport.left + viewport.scrollLeft, y: start.y - viewport.top + viewport.scrollTop };
    const previewScreenX = ratio * c0.x + g.tx - viewport.scrollLeft;
    const committedScreenX = c0.x * (commit.zoom / 1) - commit.scrollLeft;
    expect(previewScreenX).toBeCloseTo(committedScreenX, 6);
    const previewScreenY = ratio * c0.y + g.ty - viewport.scrollTop;
    const committedScreenY = c0.y * (commit.zoom / 1) - commit.scrollTop;
    expect(previewScreenY).toBeCloseTo(committedScreenY, 6);
  });

  it('提交后滚动位置让同一内容点落在当前中点', () => {
    // baseZoom=1，捏到 2 倍，中点从 (150,300) 移到 (170,320)
    const commit = pinchCommit(start, { x: 170, y: 320 }, viewport, 2, {
      minZoom: 1,
      maxZoom: 4,
      baseZoom: 1,
      maxScrollLeft: 10000,
      maxScrollTop: 10000,
    });
    expect(commit.zoom).toBe(2);
    // c0 = (250, 500) → 缩放后 (500, 1000)，减去视口内中点 (170, 320)
    expect(commit.scrollLeft).toBeCloseTo(330);
    expect(commit.scrollTop).toBeCloseTo(680);
  });

  it('超出范围时按 min/max 夹紧，且滚动不越界', () => {
    const commit = pinchCommit(start, start, viewport, 100, {
      minZoom: 1,
      maxZoom: 3,
      baseZoom: 1,
      maxScrollLeft: 500,
      maxScrollTop: 500,
    });
    expect(commit.zoom).toBe(3);
    expect(commit.scrollLeft).toBe(500);
    expect(commit.scrollTop).toBe(500);
  });

  it('zoomAtPoint 等价于中点为锚点的 pinchCommit', () => {
    const a = zoomAtPoint({ x: 40, y: 60 }, viewport, 1.5, {
      minZoom: 0.5,
      maxZoom: 4,
      baseZoom: 1,
      maxScrollLeft: 9999,
      maxScrollTop: 9999,
    });
    const b = pinchCommit({ x: 40, y: 60 }, { x: 40, y: 60 }, viewport, 1.5, {
      minZoom: 0.5,
      maxZoom: 4,
      baseZoom: 1,
      maxScrollLeft: 9999,
      maxScrollTop: 9999,
    });
    expect(a).toEqual(b);
  });

  it('双击在适配与目标倍率之间切换', () => {
    expect(doubleTapTarget(1, { targetZoom: 2.5, minZoom: 1, maxZoom: 4 })).toBe(2.5);
    expect(doubleTapTarget(2.5, { targetZoom: 2.5, minZoom: 1, maxZoom: 4 })).toBe(1);
    expect(doubleTapTarget(4, { targetZoom: 2.5, minZoom: 1, maxZoom: 4 })).toBe(1);
  });

  it('几何小工具', () => {
    expect(clamp(5, 1, 3)).toBe(3);
    expect(clamp(Number.NaN, 2, 3)).toBe(2);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 8 })).toEqual({ x: 2, y: 4 });
  });
});

describe('layout', () => {
  const base = {
    mode: 'scroll' as const,
    fallback: { width: 600, height: 800 },
    zoom: 1,
    containerWidth: 400,
    containerHeight: 800,
    gap: 12,
    padding: 12,
    rotation: 0,
    fitMode: 'width' as const,
  };

  it('连续模式：按宽度适配、自上而下堆叠、间距生效', () => {
    const layout = computeLayout({
      ...base,
      metrics: [metric(600, 800, 1), metric(600, 800, 2)],
      // 400/600 = 0.6667
      scale: 400 / 600,
    });
    const [a, b] = layout.boxes;
    expect(a.width).toBeCloseTo(400);
    expect(a.height).toBeCloseTo(800 * (400 / 600));
    expect(a.top).toBeCloseTo(12);
    expect(b.top).toBeCloseTo(a.top + a.height + 12);
    expect(layout.contentHeight).toBeGreaterThan(b.top + b.height);
  });

  it('连续模式：内容对 zoom 严格线性（捏合预演的前提）', () => {
    const metrics = [metric(600, 800, 1), metric(600, 800, 2)];
    const z1 = computeLayout({ ...base, metrics, scale: 400 / 600, zoom: 1 });
    const z2 = computeLayout({ ...base, metrics, scale: 400 / 600, zoom: 2 });
    expect(z2.boxes[1].top).toBeCloseTo(z1.boxes[1].top * 2);
    expect(z2.boxes[1].height).toBeCloseTo(z1.boxes[1].height * 2);
    expect(z2.contentWidth).toBeCloseTo(z1.contentWidth * 2);
    expect(z2.contentHeight).toBeCloseTo(z1.contentHeight * 2);
  });

  it('旋转 90° 后宽高互换', () => {
    const layout = computeLayout({
      ...base,
      metrics: [metric(600, 800, 1, 90)],
      scale: 1,
      rotation: 0,
      zoom: 1,
    });
    expect(layout.boxes[0].width).toBeCloseTo(800);
    expect(layout.boxes[0].height).toBeCloseTo(600);
  });

  it('翻页模式：每页占满一屏并水平排列、垂直居中', () => {
    const layout = computeLayout({
      ...base,
      mode: 'page',
      metrics: [metric(600, 800, 1), metric(300, 400, 2)],
      scale: 1,
    });
    expect(layout.boxes).toHaveLength(2);
    expect(layout.boxes[1].left).toBeCloseTo(400);
    expect(layout.contentWidth).toBe(800);
    // 第二页更小，应该居中显示
    expect(layout.boxes[1].top).toBeGreaterThan(0);
  });

  it('pageAtOffset 落在页内返回该页，落在间隙取最近', () => {
    const layout = computeLayout({
      ...base,
      metrics: [metric(600, 800, 1), metric(600, 800, 2), metric(600, 800, 3)],
      scale: 400 / 600,
      gap: 20,
    });
    const [a, b] = layout.boxes;
    expect(pageAtOffset(layout.boxes, 0)).toBe(1);
    expect(pageAtOffset(layout.boxes, a.top + 10)).toBe(1);
    expect(pageAtOffset(layout.boxes, b.top + 10)).toBe(2);
    // 间隙中间偏上 → 第 1 页；偏下 → 第 2 页
    const gapTop = a.top + a.height;
    expect(pageAtOffset(layout.boxes, gapTop + 2)).toBe(1);
    expect(pageAtOffset(layout.boxes, gapTop + 18)).toBe(2);
    expect(pageAtOffset(layout.boxes, 999999)).toBe(3);
  });

  it('anchoredScroll 保持锚点内容不动', () => {
    // 滚动 100，锚点在视口内 200 处 → 内容坐标 300；放大 2 倍后应为 600
    expect(anchoredScroll(100, 200, 2)).toBe(400);
    expect(anchoredScroll(0, 50, 1)).toBe(0);
  });

  it('quantizeScale 只升不降，命中有限档位', () => {
    expect(quantizeScale(0.9)).toBe(1);
    expect(quantizeScale(1)).toBe(1);
    expect(quantizeScale(1.01)).toBe(1.25);
    expect(quantizeScale(0.1)).toBe(0.25);
    expect(quantizeScale(100)).toBe(100);
    expect(quantizeScale(0)).toBe(1);
  });
});
