import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface OutlineEntry {
  title: string;
  bold: boolean;
  italic: boolean;
  pageNumber: number | null;
  url: string | null;
  depth: number;
  key: string;
}

/**
 * 解析 PDF 大纲（书签）。
 *
 * pdf.js 的 `dest` 可能是：
 *  - 字符串（命名目标）→ 需要 getDestination 解析；
 *  - 数组 [ref | pageIndex, {name: 'XYZ'}, ...]；
 *  - null（只带 URL 的外部链接）。
 * 这里统一拍平成带页码的线性列表，便于 H5 里做扁平列表 + 缩进。
 */
export async function flattenOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  let raw: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>;
  try {
    raw = await doc.getOutline();
  } catch {
    return [];
  }
  if (!raw || raw.length === 0) return [];

  const entries: OutlineEntry[] = [];
  let counter = 0;

  const resolvePage = async (dest: unknown): Promise<number | null> => {
    try {
      let resolved: unknown = dest;
      if (typeof resolved === 'string') resolved = await doc.getDestination(resolved);
      if (!Array.isArray(resolved) || resolved.length === 0) return null;
      const first = resolved[0];
      if (typeof first === 'number') return first + 1;
      if (first && typeof first === 'object' && 'num' in (first as Record<string, unknown>)) {
        const index = await doc.getPageIndex(first as never);
        return index + 1;
      }
    } catch {
      /* 目标无效 */
    }
    return null;
  };

  const walk = async (nodes: typeof raw, depth: number): Promise<void> => {
    for (const node of nodes) {
      const pageNumber = node.dest ? await resolvePage(node.dest) : null;
      entries.push({
        title: node.title || '(无标题)',
        bold: Boolean(node.bold),
        italic: Boolean(node.italic),
        pageNumber,
        url: node.url ?? null,
        depth,
        key: `outline-${counter++}`,
      });
      if (node.items && node.items.length > 0) {
        await walk(node.items as typeof raw, depth + 1);
      }
    }
  };

  await walk(raw, 0);
  return entries;
}

/** 供面板复用：加载 + 缓存大纲 */
export function useOutline(doc: PDFDocumentProxy | null): { entries: OutlineEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef(new WeakMap<PDFDocumentProxy, OutlineEntry[]>());

  useEffect(() => {
    if (!doc) {
      setEntries([]);
      return;
    }
    const cached = cacheRef.current.get(doc);
    if (cached) {
      setEntries(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    flattenOutline(doc)
      .then((result) => {
        if (cancelled) return;
        cacheRef.current.set(doc, result);
        setEntries(result);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return { entries, loading };
}

/** 刻度尺式进度条：显示已解析页占比，让用户知道「还有多少没测完」 */
export function useOutlineStats(entries: OutlineEntry[]) {
  return useMemo(() => {
    const located = entries.filter((entry) => entry.pageNumber !== null).length;
    const maxDepth = entries.reduce((max, entry) => Math.max(max, entry.depth), 0);
    return { located, total: entries.length, maxDepth };
  }, [entries]);
}

/** 面板通用：按 Esc 关闭 + 锁定背景滚动 */
export function usePanelDismiss(onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onBackdrop = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) closeRef.current();
    },
    [],
  );

  return { onBackdrop };
}
