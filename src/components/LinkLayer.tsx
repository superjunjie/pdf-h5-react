import { useEffect, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';

export interface LinkLayerProps {
  page: PDFPageProxy | null;
  pageNumber: number;
  width: number;
  height: number;
  displayScale: number;
  rotation: number;
  enabled: boolean;
  onInternalLink?: (dest: string | unknown[] | null) => void;
  onExternalLink?: (url: string) => void;
}

interface LinkBox {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  url?: string;
  dest?: string | unknown[] | null;
  title: string;
}

/**
 * 链接层。只保留可点击区域，不渲染 PDF 的完整 annotation layer
 * （表单、批注编辑器在 H5 里体积大且意义有限）。
 */
export function LinkLayer({
  page,
  pageNumber,
  width,
  height,
  displayScale,
  rotation,
  enabled,
  onInternalLink,
  onExternalLink,
}: LinkLayerProps) {
  const [links, setLinks] = useState<LinkBox[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!page || !enabled) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    page
      .getAnnotations({ intent: 'display' })
      .then((annotations: Array<Record<string, unknown>>) => {
        if (cancelled || !mounted.current) return;
        const viewport = page.getViewport({ scale: displayScale, rotation: page.rotate + rotation });
        const boxes: LinkBox[] = [];
        annotations.forEach((annotation, index) => {
          if (annotation.subtype !== 'Link') return;
          const rect = annotation.rect as number[] | undefined;
          if (!rect) return;
          // pdf.js v6 的 PageViewport 已移除 convertToViewportRectangle，用两个角点自行换算
          const [x1, y1, x2, y2] = rectToViewport(viewport, rect);
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          boxes.push({
            key: `${pageNumber}-${index}`,
            left,
            top,
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            url: typeof annotation.url === 'string' ? annotation.url : undefined,
            dest: (annotation.dest as string | unknown[] | null) ?? null,
            title: (annotation.title as string) || (annotation.url as string) || '链接',
          });
        });
        setLinks(boxes);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [page, pageNumber, displayScale, rotation, enabled, width, height]);

  if (!enabled || links.length === 0) return null;

  return (
    <div className="pdfh5-linkLayer" style={{ width, height }}>
      {links.map((link) =>
        link.url ? (
          <a
            key={link.key}
            className="pdfh5-link"
            style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => {
              if (onExternalLink) {
                event.preventDefault();
                onExternalLink(link.url!);
              }
            }}
            title={link.title}
          />
        ) : (
          <button
            key={link.key}
            type="button"
            className="pdfh5-link"
            style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
            onClick={() => onInternalLink?.(link.dest ?? null)}
            title={link.title}
          />
        ),
      )}
    </div>
  );
}

/** pdf.js v6 的 PageViewport 只有 convertToViewportPoint：用对角两点换算矩形 */
function rectToViewport(
  viewport: { convertToViewportPoint(x: number, y: number): number[] },
  rect: number[],
): [number, number, number, number] {
  const p1 = viewport.convertToViewportPoint(rect[0], rect[1]);
  const p2 = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [p1[0], p1[1], p2[0], p2[1]];
}
