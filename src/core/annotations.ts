/**
 * 注释数据模型与坐标换算。
 *
 * 设计要点（这是注释功能最容易做错的地方）：
 *
 * 1. **存储用归一化坐标**（0-1，相对页面宽高），而不是 CSS 像素。
 *    否则缩放 / 旋转屏幕 / 切换 fitMode 之后，所有注释都会错位。
 *
 * 2. **不写回 PDF 字节**（默认）。把注释存在独立的数据层，导出时才考虑落盘。
 *    改 PDF 需要 pdf-lib 之类的重量级依赖，且会破坏原文件的签名与增量更新语义。
 *
 * 3. 坐标以「页面显示盒」为参照系（即 .pdfh5-page 的左上角），
 *    与 viewport 的旋转无关 —— 旋转在渲染层处理，注释层始终贴合最终显示区域。
 */

/** 归一化点：x/y ∈ [0, 1]，相对页面显示区域的左上角 */
export interface NormPoint {
  x: number;
  y: number;
}

/** 归一化矩形 */
export interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationKind = 'highlight' | 'freetext' | 'ink';

interface AnnotationBase {
  id: string;
  kind: AnnotationKind;
  pageNumber: number;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 作者标记，便于多人协作时区分 */
  author?: string;
  /** 任意业务附加数据（不会渲染） */
  meta?: Record<string, unknown>;
}

/** 文本高亮：一个或多个矩形（跨行时会有多段） */
export interface HighlightAnnotation extends AnnotationBase {
  kind: 'highlight';
  rects: NormRect[];
  /** 高亮到的文字（便于做批注列表 / 导出） */
  text?: string;
  color: string;
  opacity: number;
}

/** 自由文本：一个锚点 + 字号（归一化到页面宽度，保证缩放后视觉比例一致） */
export interface FreetextAnnotation extends AnnotationBase {
  kind: 'freetext';
  anchor: NormPoint;
  text: string;
  /** 字号相对页面宽度的比例（例如 0.02 表示页面宽度的 2%） */
  fontSize: number;
  color: string;
}

/** 手写笔迹：归一化点序列 */
export interface InkAnnotation extends AnnotationBase {
  kind: 'ink';
  points: NormPoint[];
  /** 线宽相对页面宽度的比例 */
  thickness: number;
  color: string;
}

export type Annotation = HighlightAnnotation | FreetextAnnotation | InkAnnotation;

export type AnnotationMode = 'none' | 'highlight' | 'freetext' | 'ink';

export interface AnnotationStyle {
  highlightColor: string;
  highlightOpacity: number;
  textColor: string;
  inkColor: string;
  /** 相对页面宽度的比例 */
  fontSize: number;
  thickness: number;
}

export const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = {
  highlightColor: '#ffd400',
  highlightOpacity: 0.38,
  textColor: '#1f2329',
  inkColor: '#e5484d',
  fontSize: 0.022,
  thickness: 0.0028,
};

// ---------------- 坐标换算 ----------------

/** 视口像素（相对页面盒左上角）→ 归一化 */
export function toNormalized(px: number, py: number, boxWidth: number, boxHeight: number): NormPoint {
  return {
    x: boxWidth > 0 ? clamp01(px / boxWidth) : 0,
    y: boxHeight > 0 ? clamp01(py / boxHeight) : 0,
  };
}

/** 归一化 → 视口像素 */
export function toPixel(point: NormPoint, boxWidth: number, boxHeight: number): NormPoint {
  return { x: point.x * boxWidth, y: point.y * boxHeight };
}

export function rectToPixel(rect: NormRect, boxWidth: number, boxHeight: number): NormRect {
  return {
    x: rect.x * boxWidth,
    y: rect.y * boxHeight,
    width: rect.width * boxWidth,
    height: rect.height * boxHeight,
  };
}

/** 由两个对角点构造归一化矩形（自动处理反向拖拽） */
export function rectFromPoints(a: NormPoint, b: NormPoint): NormRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ---------------- 创建 / 校验 ----------------

let idSeed = 0;

export function createAnnotationId(prefix = 'anno'): string {
  idSeed += 1;
  // 时间戳 + 自增，避免同一毫秒内批量创建时冲突
  return `${prefix}-${Date.now().toString(36)}-${idSeed.toString(36)}`;
}

/** 判断注释是否「有效」：空高亮、空文本、单击点都不入库 */
export function isAnnotationValid(annotation: Annotation): boolean {
  switch (annotation.kind) {
    case 'highlight':
      // 高亮至少要有一定面积，否则是误触
      return annotation.rects.some((r) => r.width * r.height > 0.00004);
    case 'freetext':
      return annotation.text.trim().length > 0;
    case 'ink':
      // 笔迹至少两个点，且不能是「一点没动」
      return annotation.points.length >= 2;
    default:
      return false;
  }
}

/** 归一化坐标是否落在页面内（含少量容差） */
export function isPointInPage(point: NormPoint, tolerance = 0.02): boolean {
  return (
    point.x >= -tolerance &&
    point.x <= 1 + tolerance &&
    point.y >= -tolerance &&
    point.y <= 1 + tolerance
  );
}

/** 按页分组，便于渲染时 O(1) 取用 */
export function groupByPage(annotations: readonly Annotation[]): Map<number, Annotation[]> {
  const map = new Map<number, Annotation[]>();
  for (const annotation of annotations) {
    const list = map.get(annotation.pageNumber);
    if (list) list.push(annotation);
    else map.set(annotation.pageNumber, [annotation]);
  }
  return map;
}
