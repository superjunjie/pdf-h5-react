import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useOutline, usePanelDismiss } from '../lib/outline';

export interface OutlinePanelProps {
  doc: PDFDocumentProxy;
  onNavigate(pageNumber: number): void;
  onClose(): void;
}

/** 目录（书签）面板：扁平化 + 缩进，适合 H5 抽屉 */
export function OutlinePanel({ doc, onNavigate, onClose }: OutlinePanelProps) {
  const { entries, loading } = useOutline(doc);
  const { onBackdrop } = usePanelDismiss(onClose);

  return (
    <div className="pdfh5-panel-backdrop" onClick={onBackdrop} role="presentation">
      <aside className="pdfh5-panel pdfh5-panel-outline" role="dialog" aria-label="目录">
        <header className="pdfh5-panel-head">
          <h2>目录</h2>
          <button type="button" className="pdfh5-icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="pdfh5-outline-list">
          {loading ? <p className="pdfh5-empty">正在读取目录…</p> : null}
          {!loading && entries.length === 0 ? <p className="pdfh5-empty">此文档没有目录</p> : null}
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className="pdfh5-outline-item"
              style={{ paddingLeft: 16 + entry.depth * 14 }}
              onClick={() => {
                if (entry.pageNumber) onNavigate(entry.pageNumber);
                else if (entry.url) window.open(entry.url, '_blank', 'noopener');
              }}
              disabled={!entry.pageNumber && !entry.url}
            >
              <span
                className="pdfh5-outline-title"
                style={{ fontWeight: entry.bold ? 600 : 400, fontStyle: entry.italic ? 'italic' : 'normal' }}
              >
                {entry.title}
              </span>
              {entry.pageNumber ? <span className="pdfh5-outline-page">{entry.pageNumber}</span> : null}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
