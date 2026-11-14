import { describe, expect, it } from 'vitest';
import {
  createAnnotationId,
  DEFAULT_ANNOTATION_STYLE,
  groupByPage,
  isAnnotationValid,
  isPointInPage,
  rectFromPoints,
  rectToPixel,
  toNormalized,
  toPixel,
  type Annotation,
  type FreetextAnnotation,
  type HighlightAnnotation,
  type InkAnnotation,
} from './annotations';

const highlight = (over: Partial<HighlightAnnotation> = {}): HighlightAnnotation => ({
  id: 'h1',
  kind: 'highlight',
  pageNumber: 1,
  createdAt: 0,
  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
  color: DEFAULT_ANNOTATION_STYLE.highlightColor,
  opacity: 0.4,
  ...over,
});

describe('注释坐标换算', () => {
  it('像素 → 归一化 → 像素 可往返', () => {
    const box = { w: 366, h: 518 };
    const point = toNormalized(183, 259, box.w, box.h);
    expect(point.x).toBeCloseTo(0.5);
    expect(point.y).toBeCloseTo(0.5);
    const back = toPixel(point, box.w, box.h);
    expect(back.x).toBeCloseTo(183);
    expect(back.y).toBeCloseTo(259);
  });

  it('同一归一化坐标在不同缩放级别下对应不同像素（这正是要归一化的原因）', () => {
    const small = { w: 366, h: 518 };
    const large = { w: 732, h: 1036 };
    const norm = toNormalized(183, 259, small.w, small.h);
    const atSmall = toPixel(norm, small.w, small.h);
    const atLarge = toPixel(norm, large.w, large.h);
    expect(atSmall.x).toBeCloseTo(183);
    expect(atLarge.x).toBeCloseTo(366); // 放大 2 倍后，同一相对位置对应 2 倍像素
    // 关键：归一化值不随缩放变化
    expect(toNormalized(atLarge.x, atLarge.y, large.w, large.h).x).toBeCloseTo(norm.x);
  });

  it('矩形换算保持相对位置', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const px = rectToPixel(rect, 200, 400);
    expect(px).toEqual({ x: 20, y: 80, width: 60, height: 160 });
  });

  it('rectFromPoints 自动处理反向拖拽', () => {
    const a = { x: 0.6, y: 0.7 };
    const b = { x: 0.2, y: 0.3 };
    const rect = rectFromPoints(a, b);
    // 浮点运算有精度误差，用近似断言
    expect(rect.x).toBeCloseTo(0.2);
    expect(rect.y).toBeCloseTo(0.3);
    expect(rect.width).toBeCloseTo(0.4);
    expect(rect.height).toBeCloseTo(0.4);
  });

  it('越界坐标被夹紧到 [0,1]', () => {
    const p = toNormalized(-50, 9999, 300, 400);
    expect(p).toEqual({ x: 0, y: 1 });
  });

  it('零尺寸容器不产生 NaN', () => {
    const p = toNormalized(10, 10, 0, 0);
    expect(p).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(p.x)).toBe(false);
  });

  it('isPointInPage 允许少量容差', () => {
    expect(isPointInPage({ x: 0.5, y: 0.5 })).toBe(true);
    expect(isPointInPage({ x: 1.01, y: 0.5 })).toBe(true); // 容差内
    expect(isPointInPage({ x: 1.5, y: 0.5 })).toBe(false);
    expect(isPointInPage({ x: -0.5, y: 0.5 })).toBe(false);
  });
});

describe('注释校验', () => {
  it('空高亮（误触）不入库', () => {
    expect(isAnnotationValid(highlight({ rects: [{ x: 0.1, y: 0.1, width: 0, height: 0 }] }))).toBe(false);
    expect(isAnnotationValid(highlight())).toBe(true);
  });

  it('空白自由文本不入库', () => {
    const base: FreetextAnnotation = {
      id: 'f1',
      kind: 'freetext',
      pageNumber: 1,
      createdAt: 0,
      anchor: { x: 0.2, y: 0.3 },
      text: '   ',
      fontSize: 0.02,
      color: '#000',
    };
    expect(isAnnotationValid(base)).toBe(false);
    expect(isAnnotationValid({ ...base, text: '批注' })).toBe(true);
  });

  it('笔迹至少两个点', () => {
    const ink: InkAnnotation = {
      id: 'i1',
      kind: 'ink',
      pageNumber: 1,
      createdAt: 0,
      points: [{ x: 0.1, y: 0.1 }],
      thickness: 0.003,
      color: '#f00',
    };
    expect(isAnnotationValid(ink)).toBe(false);
    expect(isAnnotationValid({ ...ink, points: [...ink.points, { x: 0.2, y: 0.2 }] })).toBe(true);
  });
});

describe('注释工具', () => {
  it('id 唯一', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createAnnotationId()));
    expect(ids.size).toBe(200);
  });

  it('按页分组', () => {
    const list: Annotation[] = [
      highlight({ id: 'a', pageNumber: 1 }),
      highlight({ id: 'b', pageNumber: 2 }),
      highlight({ id: 'c', pageNumber: 1 }),
    ];
    const grouped = groupByPage(list);
    expect(grouped.get(1)?.length).toBe(2);
    expect(grouped.get(2)?.length).toBe(1);
    expect(grouped.get(3)).toBeUndefined();
  });
});
