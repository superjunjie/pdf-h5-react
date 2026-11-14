import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAnnotationId,
  DEFAULT_ANNOTATION_STYLE,
  isAnnotationValid,
  rectFromPoints,
  rectToPixel,
  toNormalized,
  toPixel,
  type Annotation,
  type AnnotationMode,
  type AnnotationStyle,
  type FreetextAnnotation,
  type HighlightAnnotation,
  type InkAnnotation,
  type NormPoint,
  type NormRect,
} from '../core/annotations';

export interface AnnotationLayerProps {
  pageNumber: number;
  width: number;
  height: number;
  mode: AnnotationMode;
  style: AnnotationStyle;
  annotations: readonly Annotation[];
  /** 交互总开关：翻页动画 / 面板打开时应关闭，避免抢手势 */
  enabled: boolean;
  onAdd(annotation: Annotation): void;
  onSelect?(annotation: Annotation): void;
  onActiveChange?(active: boolean): void;
}

/** 正在绘制的临时图形 */
type Draft =
  | { kind: 'highlight'; start: NormPoint; current: NormPoint }
  | { kind: 'ink'; points: NormPoint[] }
  | null;

/**
 * 注释层。
 *
 * 三层结构（自下而上）：
 *  1. 既有注释的渲染层（pointer-events: none，不影响阅读与选词）
 *  2. 交互层（仅在 mode !== 'none' 时启用 pointer-events: auto）
 *  3. 自由文本输入浮层（用 textarea，聚焦时阻止阅读器手势）
 *
 * 为什么用归一化坐标：见 core/annotations.ts 的说明。缩放 / 旋转后注释仍贴合原文。
 */
export function AnnotationLayer({
  pageNumber,
  width,
  height,
  mode,
  style,
  annotations,
  enabled,
  onAdd,
  onSelect,
  onActiveChange,
}: AnnotationLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [textAnchor, setTextAnchor] = useState<NormPoint | null>(null);
  const [textValue, setTextValue] = useState('');
  const drawingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const interactive = enabled && mode !== 'none';

  // 进入文本输入时通知外部（用于暂停翻页 / 滚动手势）
  useEffect(() => {
    onActiveChange?.(Boolean(textAnchor) || Boolean(draft));
  }, [textAnchor, draft, onActiveChange]);

  useEffect(() => {
    if (textAnchor) {
      // 等浮层渲染后再聚焦，避免 focus 丢失
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [textAnchor]);

  /** 把客户端坐标转成相对页面盒的归一化坐标 */
  const toNorm = useCallback(
    (event: React.PointerEvent): NormPoint | null => {
      const layer = layerRef.current;
      if (!layer) return null;
      const rect = layer.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return toNormalized(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    },
    [],
  );

  const commitHighlight = useCallback(
    (start: NormPoint, end: NormPoint) => {
      const rect = rectFromPoints(start, end);
      const annotation: HighlightAnnotation = {
        id: createAnnotationId('hl'),
        kind: 'highlight',
        pageNumber,
        createdAt: Date.now(),
        rects: [rect],
        color: style.highlightColor,
        opacity: style.highlightOpacity,
      };
      if (isAnnotationValid(annotation)) onAdd(annotation);
      setDraft(null);
    },
    [pageNumber, style.highlightColor, style.highlightOpacity, onAdd],
  );

  const commitInk = useCallback(
    (points: NormPoint[]) => {
      const annotation: InkAnnotation = {
        id: createAnnotationId('ink'),
        kind: 'ink',
        pageNumber,
        createdAt: Date.now(),
        points,
        thickness: style.thickness,
        color: style.inkColor,
      };
      if (isAnnotationValid(annotation)) onAdd(annotation);
      setDraft(null);
    },
    [pageNumber, style.thickness, style.inkColor, onAdd],
  );

  const commitText = useCallback(() => {
    const anchor = textAnchor;
    const value = textValue.trim();
    setTextAnchor(null);
    setTextValue('');
    if (!anchor || !value) return;
    const annotation: FreetextAnnotation = {
      id: createAnnotationId('ft'),
      kind: 'freetext',
      pageNumber,
      createdAt: Date.now(),
      anchor,
      text: value,
      fontSize: style.fontSize,
      color: style.textColor,
    };
    onAdd(annotation);
  }, [textAnchor, textValue, pageNumber, style.fontSize, style.textColor, onAdd]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!interactive) return;
      // 只响应主键 / 单指，避免与双指缩放冲突
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const norm = toNorm(event);
      if (!norm) return;

      if (mode === 'freetext') {
        event.preventDefault();
        event.stopPropagation();
        setTextAnchor(norm);
        setTextValue('');
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      drawingRef.current = true;
      setDraft(
        mode === 'highlight'
          ? { kind: 'highlight', start: norm, current: norm }
          : { kind: 'ink', points: [norm] },
      );
    },
    [interactive, mode, toNorm],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!interactive || !drawingRef.current) return;
      const norm = toNorm(event);
      if (!norm) return;
      event.preventDefault();
      setDraft((prev) => {
        if (!prev) return prev;
        if (prev.kind === 'highlight') return { ...prev, current: norm };
        // 笔迹：距离过近的点丢弃，减少数据量（约 1px 以上才记录）
        const last = prev.points[prev.points.length - 1];
        const minDistance = 0.0015;
        if (Math.hypot(norm.x - last.x, norm.y - last.y) < minDistance) return prev;
        return { kind: 'ink', points: [...prev.points, norm] };
      });
    },
    [interactive, toNorm],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      (event.target as Element).releasePointerCapture?.(event.pointerId);
      setDraft((prev) => {
        if (!prev) return null;
        // 提交放在微任务里：避免在 setState 的 updater 内部触发外部回调
        queueMicrotask(() => {
          if (prev.kind === 'highlight') commitHighlight(prev.start, prev.current);
          else commitInk(prev.points);
        });
        return prev;
      });
    },
    [commitHighlight, commitInk],
  );

  const onPointerCancel = useCallback(() => {
    drawingRef.current = false;
    setDraft(null);
  }, []);

  // 自由文本输入时阻止事件冒泡到阅读器（否则会触发缩放 / 滚动）
  const stopAll = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  return (
    <div
      ref={layerRef}
      className="pdfh5-anno"
      data-mode={mode}
      data-interactive={interactive || undefined}
      style={{ width, height }}
    >
      {/* 1) 既有注释渲染 */}
      <div className="pdfh5-anno-view" aria-hidden="true">
        {annotations.map((annotation) => (
          <AnnotationView
            key={annotation.id}
            annotation={annotation}
            width={width}
            height={height}
            onSelect={onSelect}
          />
        ))}

        {/* 绘制中的临时图形 */}
        {draft?.kind === 'highlight' ? (
          <DraftRect rect={rectFromPoints(draft.start, draft.current)} width={width} height={height} color={style.highlightColor} opacity={style.highlightOpacity} />
        ) : null}
        {draft?.kind === 'ink' ? (
          <DraftInk points={draft.points} width={width} height={height} color={style.inkColor} thickness={style.thickness} />
        ) : null}
      </div>

      {/* 2) 交互捕获层：只在该模式下接收指针事件 */}
      {interactive ? (
        <div
          className="pdfh5-anno-capture"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        />
      ) : null}

      {/* 3) 自由文本输入浮层 */}
      {textAnchor ? (
        <div
          className="pdfh5-anno-editor"
          style={{
            left: textAnchor.x * width,
            top: textAnchor.y * height,
          }}
          onPointerDown={stopAll}
          onClick={stopAll}
        >
          <textarea
            ref={textareaRef}
            className="pdfh5-anno-input"
            value={textValue}
            placeholder="输入批注…"
            onChange={(event) => setTextValue(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                setTextAnchor(null);
                setTextValue('');
              }
              // Cmd/Ctrl + Enter 提交，普通回车换行
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commitText();
              }
            }}
            rows={2}
          />
          <div className="pdfh5-anno-actions">
            <button
              type="button"
              className="pdfh5-anno-btn"
              onClick={() => {
                setTextAnchor(null);
                setTextValue('');
              }}
            >
              取消
            </button>
            <button type="button" className="pdfh5-anno-btn pdfh5-anno-btn-primary" onClick={commitText}>
              添加
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 渲染单条注释 */
function AnnotationView({
  annotation,
  width,
  height,
  onSelect,
}: {
  annotation: Annotation;
  width: number;
  height: number;
  onSelect?: (annotation: Annotation) => void;
}) {
  const handle = (event: React.MouseEvent) => {
    event.stopPropagation();
    onSelect?.(annotation);
  };

  if (annotation.kind === 'highlight') {
    return (
      <div className="pdfh5-anno-hit" onClick={handle} role="presentation">
        {annotation.rects.map((rect, index) => {
          const px = rectToPixel(rect, width, height);
          return (
            <span
              key={index}
              className="pdfh5-anno-hl"
              style={{
                left: px.x,
                top: px.y,
                width: px.width,
                height: px.height,
                background: annotation.color,
                opacity: annotation.opacity,
              }}
            />
          );
        })}
      </div>
    );
  }

  if (annotation.kind === 'freetext') {
    const px = toPixel(annotation.anchor, width, height);
    return (
      <div
        className="pdfh5-anno-text"
        style={{
          left: px.x,
          top: px.y,
          fontSize: Math.max(9, annotation.fontSize * width),
          color: annotation.color,
        }}
        onClick={handle}
        role="presentation"
      >
        {annotation.text}
      </div>
    );
  }

  // ink
  const points = annotation.points.map((p) => toPixel(p, width, height));
  if (points.length < 2) return null;
  const d = points.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  return (
    <svg className="pdfh5-anno-ink" width={width} height={height} onClick={handle}>
      <path
        d={d}
        fill="none"
        stroke={annotation.color}
        strokeWidth={Math.max(1, annotation.thickness * width)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DraftRect({
  rect,
  width,
  height,
  color,
  opacity,
}: {
  rect: NormRect;
  width: number;
  height: number;
  color: string;
  opacity: number;
}) {
  const px = rectToPixel(rect, width, height);
  return (
    <span
      className="pdfh5-anno-hl pdfh5-anno-hl-draft"
      style={{ left: px.x, top: px.y, width: px.width, height: px.height, background: color, opacity: opacity * 0.7 }}
    />
  );
}

function DraftInk({
  points,
  width,
  height,
  color,
  thickness,
}: {
  points: NormPoint[];
  width: number;
  height: number;
  color: string;
  thickness: number;
}) {
  const px = points.map((p) => toPixel(p, width, height));
  if (px.length < 2) return null;
  const d = px.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  return (
    <svg className="pdfh5-anno-ink" width={width} height={height}>
      <path d={d} fill="none" stroke={color} strokeWidth={Math.max(1, thickness * width)} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export { DEFAULT_ANNOTATION_STYLE };
