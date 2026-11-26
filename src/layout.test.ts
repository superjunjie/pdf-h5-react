import { describe, expect, it } from 'vitest';
import {
  clampCanvasSize,
  computeLayout,
  pageAtOffset,
  quantizePixelRatio,
  viewportScaleFor,
} from './layout';

const A4 = { width: 595.28, height: 841.89 };

describe('computeLayout', () => {
  it('按第一页宽度适配容器，并竖向堆叠', () => {
    const result = computeLayout({
      sizes: [A4, A4],
      containerWidth: 400,
      gap: 10,
      padding: 0,
    });
    const scale = 400 / 595.28;
    expect(result.scale).toBeCloseTo(scale);
    expect(result.boxes[0].displayWidth).toBeCloseTo(400);
    expect(result.boxes[0].displayHeight).toBeCloseTo(A4.height * scale);
    expect(result.boxes[1].top).toBeCloseTo(result.boxes[0].displayHeight + 10);
  });

  it('内容高度 = 各页高度 + 间距 + 上下内边距（不含末尾 gap）', () => {
    const result = computeLayout({ sizes: [A4, A4], containerWidth: 300, gap: 8, padding: 16 });
    const h = result.boxes[0].displayHeight;
    expect(result.boxes[0].top).toBeCloseTo(16);
    expect(result.contentHeight).toBeCloseTo(16 + h + 8 + h + 16);
  });

  it('空文档不崩', () => {
    const result = computeLayout({ sizes: [], containerWidth: 300, gap: 8, padding: 0 });
    expect(result.boxes).toEqual([]);
    expect(result.contentHeight).toBe(0);
  });

  it('容器宽度为 0 时不产生 NaN', () => {
    const result = computeLayout({ sizes: [A4], containerWidth: 0, gap: 8, padding: 0 });
    expect(Number.isFinite(result.boxes[0].displayWidth)).toBe(true);
    expect(Number.isFinite(result.scale)).toBe(true);
  });
});

describe('quantizePixelRatio', () => {
  it('只跟随 DPR，不受页面缩放影响', () => {
    expect(quantizePixelRatio(1)).toBe(1);
    expect(quantizePixelRatio(2)).toBe(2);
    expect(quantizePixelRatio(3)).toBe(3);
  });

  it('量化到固定档位', () => {
    expect(quantizePixelRatio(1.9)).toBe(2);
    expect(quantizePixelRatio(1.05)).toBe(1);
  });

  it('超过上限被夹紧', () => {
    expect(quantizePixelRatio(5, 2)).toBeLessThanOrEqual(2);
  });

  it('异常输入回落到 1', () => {
    expect(quantizePixelRatio(0)).toBe(1);
    expect(quantizePixelRatio(Number.NaN)).toBe(1);
  });
});

describe('clampCanvasSize', () => {
  it('画布像素 = CSS 尺寸 × 像素比', () => {
    const size = clampCanvasSize(366, 518, 2);
    expect(size.width).toBe(732);
    expect(size.height).toBe(1036);
    expect(size.ratio).toBe(2);
  });

  it('超出单边上限时按比例缩小', () => {
    const size = clampCanvasSize(10000, 10000, 2, 16_777_216, 8192);
    expect(size.width).toBeLessThanOrEqual(8192);
    expect(size.height).toBeLessThanOrEqual(8192);
  });

  it('超出总像素上限时按比例缩小', () => {
    const size = clampCanvasSize(4000, 4000, 3, 1_000_000, 8192);
    expect(size.width * size.height).toBeLessThanOrEqual(1_000_000 + 4000);
  });
});

describe('viewportScaleFor（防止文字截断的关键不变式）', () => {
  it('渲染内容尺寸必须等于画布尺寸', () => {
    const cssWidth = 366;
    const pdfWidth = A4.width;
    const pdfHeight = A4.height;
    const size = clampCanvasSize(cssWidth, 518, 2);

    const viewportScale = viewportScaleFor(cssWidth, pdfWidth, size.ratio);
    // getViewport 用 PDF 单位 × viewportScale 计算渲染尺寸
    const renderedWidth = pdfWidth * viewportScale;
    const renderedHeight = pdfHeight * viewportScale;

    expect(Math.abs(renderedWidth - size.width) / size.width).toBeLessThan(0.01);
    expect(Math.abs(renderedHeight - size.height) / size.height).toBeLessThan(0.01);
  });

  it('把像素比直接当 viewportScale 会超出画布（回归：文字截断）', () => {
    const cssWidth = 366;
    const pdfWidth = A4.width;
    const size = clampCanvasSize(cssWidth, 518, 2);
    const displayScale = cssWidth / pdfWidth;

    // 错误做法：直接传 ratio
    const wrongRenderedWidth = pdfWidth * size.ratio;
    expect(wrongRenderedWidth).toBeGreaterThan(size.width);
    // 多出的比例正好是 1/displayScale
    expect(wrongRenderedWidth / size.width).toBeCloseTo(1 / displayScale, 2);
  });

  it('异常参数不产生 NaN', () => {
    expect(Number.isFinite(viewportScaleFor(0, A4.width, 2))).toBe(true);
    expect(Number.isFinite(viewportScaleFor(366, 0, 2))).toBe(true);
  });
});

describe('pageAtOffset', () => {
  const layout = computeLayout({
    sizes: [A4, A4, A4],
    containerWidth: 300,
    gap: 8,
    padding: 0,
  });

  it('页内返回该页', () => {
    expect(pageAtOffset(layout.boxes, 0)).toBe(1);
    expect(pageAtOffset(layout.boxes, layout.boxes[1].top + 10)).toBe(2);
    expect(pageAtOffset(layout.boxes, layout.boxes[2].top + 10)).toBe(3);
  });

  it('落在间隙取最近页', () => {
    const gapStart = layout.boxes[0].top + layout.boxes[0].displayHeight;
    expect(pageAtOffset(layout.boxes, gapStart + 1)).toBe(1);
    expect(pageAtOffset(layout.boxes, gapStart + 7)).toBe(2);
  });

  it('超出范围时夹到首尾页', () => {
    expect(pageAtOffset(layout.boxes, -99999)).toBe(1);
    expect(pageAtOffset(layout.boxes, 999999)).toBe(3);
  });

  it('空布局返回 1', () => {
    expect(pageAtOffset([], 100)).toBe(1);
  });
});