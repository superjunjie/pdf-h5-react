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
import {
  anchoredScroll,
  clampCanvasSize,
  computeLayout,
  pageAtOffset,
  quantizePixelRatio,
  quantizeScale,
  viewportScaleFor,
} from './layout';
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
      // 每页独立适配：可用宽度 = 400 - 12*2 = 376
      scale: 400 / 600,
    });
    const [a, b] = layout.boxes;
    expect(a.width).toBeCloseTo(376);
    expect(a.height).toBeCloseTo(800 * (376 / 600));
    expect(a.top).toBeCloseTo(12);
    expect(b.top).toBeCloseTo(a.top + a.height + 12);
    expect(layout.contentHeight).toBeGreaterThan(b.top + b.height);
  });

  it('连续模式：内容对 zoom 严格线性（捏合预演的前提）', () => {
    const metrics = [metric(600, 800, 1), metric(600, 800, 2)];
    const z1 = computeLayout({ ...base, metrics, scale: 400 / 600, zoom: 1 });
    const z2 = computeLayout({ ...base, metrics, scale: 400 / 600, zoom: 2 });
    // 页面位置、尺寸、内容宽度都必须精确翻倍，否则松手提交会跳变
    expect(z2.boxes[1].top).toBeCloseTo(z1.boxes[1].top * 2);
    expect(z2.boxes[1].height).toBeCloseTo(z1.boxes[1].height * 2);
    expect(z2.boxes[1].width).toBeCloseTo(z1.boxes[1].width * 2);
    expect(z2.boxes[1].left).toBeCloseTo(z1.boxes[1].left * 2);
    expect(z2.contentWidth).toBeCloseTo(z1.contentWidth * 2);
    expect(z2.contentHeight).toBeCloseTo(z1.contentHeight * 2);
  });

  it('旋转 90° 后按宽度适配，宽高比随旋转互换', () => {
    const layout = computeLayout({
      ...base,
      metrics: [metric(600, 800, 1, 90)],
      scale: 1,
      rotation: 0,
      zoom: 1,
    });
    // 旋转后原始尺寸变为 800×600，适配容器宽度 376 → 缩放 376/800
    const scale = 376 / 800;
    expect(layout.boxes[0].width).toBeCloseTo(376);
    expect(layout.boxes[0].height).toBeCloseTo(600 * scale);
    // 关键：旋转确实换了宽高（高 < 宽）
    expect(layout.boxes[0].height).toBeLessThan(layout.boxes[0].width);
  });

  // 回归测试：混排横向页时，窄页曾因为「统一 scale 按第一页计算」而整体超出视口，
  // 表现为文字被截断。布局必须保证 zoom <= 1 时任何页面都不超出容器宽度。
  it('混排横向页时不会超出视口（回归：文字被截断）', () => {
    const containerWidth = 390;
    const layout = computeLayout({
      mode: 'scroll',
      metrics: [
        metric(595.28, 841.89, 1), // A4 纵向
        metric(841.89, 595.28, 2), // A4 横向，更宽
        metric(480, 800, 3), // 窄页
      ],
      fallback: { width: 595.28, height: 841.89 },
      // 调用方按第一页算出「按宽度适配」的 scale，这正是真实使用路径
      scale: (containerWidth - 12 * 2) / 595.28,
      zoom: 1,
      containerWidth,
      containerHeight: 800,
      gap: 12,
      padding: 12,
      rotation: 0,
      fitMode: 'width',
    });

    expect(layout.contentWidth).toBeLessThanOrEqual(containerWidth + 0.5);
    for (const box of layout.boxes) {
      expect(box.left).toBeGreaterThanOrEqual(-0.5);
      expect(box.left + box.width).toBeLessThanOrEqual(containerWidth + 0.5);
    }
    // 横向页与纵向页在「每页独立适配」下渲染宽度相同（都等于可用宽度），
    // 真正该验证的是：没有任何一页溢出容器。
    expect(layout.boxes.every((box) => box.width <= containerWidth + 0.5)).toBe(true);
  });

  it('用户主动放大时允许超出视口（横向滚动查看细节）', () => {
    const containerWidth = 390;
    const layout = computeLayout({
      mode: 'scroll',
      metrics: [metric(595.28, 841.89, 1)],
      fallback: { width: 595.28, height: 841.89 },
      scale: (containerWidth - 24) / 595.28,
      zoom: 2,
      containerWidth,
      containerHeight: 800,
      gap: 12,
      padding: 12,
      rotation: 0,
      fitMode: 'width',
    });
    expect(layout.contentWidth).toBeGreaterThan(containerWidth);
    expect(layout.boxes[0].width).toBeGreaterThan(containerWidth);
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

  // 回归测试：曾用 Math.max(displayScale, 1) * DPR 计算画布倍率，
  // 导致窄屏上的 A4 页（displayScale≈0.61）被渲染成 3 倍，画布比显示区域大 4.9 倍，
  // 回归测试：画布分辨率只由 DPR 决定，绝不掺入页面缩放。
  // 曾经把页面缩放混进来（Math.max(displayScale, 1) * DPR），
  // 窄屏 A4 上把 0.615 抬成 1，画布比显示区域大 4.9 倍，只看到左上角 —— 文字被截断。
  it('画布像素比只跟随 DPR，与页面缩放无关', () => {
    for (const dpr of [1, 2, 3]) {
      const ratio = quantizePixelRatio(dpr);
      // 与 DPR 的偏差必须很小，且绝不能因为页面小而放大
      expect(ratio / dpr).toBeGreaterThan(0.94);
      expect(ratio / dpr).toBeLessThan(1.06);
    }
    // DPR 被限幅（移动端 3 倍已是上限），避免超大画布
    expect(quantizePixelRatio(5)).toBeLessThanOrEqual(3);
    expect(quantizePixelRatio(0)).toBe(1);
    expect(quantizePixelRatio(Number.NaN)).toBe(1);
  });

  it('窄屏渲染 A4 页时画布比例正确（不裁切）', () => {
    // 移动端常见：容器 390，A4 页显示宽 366，PDF 宽 595.28
    const cssWidth = 366;
    const cssHeight = 518;
    const pdfWidth = 595.28;
    const pdfHeight = 841.89;

    for (const dpr of [1, 2, 3]) {
      const pixelRatio = quantizePixelRatio(dpr);

      // 不变式 1：pixelRatio ≈ DPR（量化误差 6% 内）。
      // 曾经把「页面缩放」混进这个值（Math.max(displayScale,1)*DPR），
      // 窄屏上把 0.615 抬成 1，画布比显示区域大 4.9 倍，只能看到左上角。
      expect(pixelRatio / dpr).toBeGreaterThan(0.94);
      expect(pixelRatio / dpr).toBeLessThan(1.06);

      // 不变式 2：画布像素 = CSS 尺寸 × pixelRatio，宽高比与 CSS 一致
      const size = clampCanvasSize(cssWidth, cssHeight, pixelRatio, {});
      expect(Math.abs(size.width - Math.floor(cssWidth * pixelRatio))).toBeLessThanOrEqual(1);
      expect(Math.abs(size.width / size.height - cssWidth / cssHeight) / (cssWidth / cssHeight)).toBeLessThan(0.01);

      // 不变式 3（最关键）：pdf.js 用 viewportScale 渲染出的内容尺寸，
      // 必须等于画布尺寸。否则内容会被画布边界裁掉 —— 这正是「文字被截断」的成因。
      const viewportScale = viewportScaleFor(cssWidth, pdfWidth, size.scale);
      const renderedWidth = pdfWidth * viewportScale;
      const renderedHeight = pdfHeight * viewportScale;
      expect(Math.abs(renderedWidth - size.width) / size.width).toBeLessThan(0.01);
      expect(Math.abs(renderedHeight - size.height) / size.height).toBeLessThan(0.01);
    }
  });
});
