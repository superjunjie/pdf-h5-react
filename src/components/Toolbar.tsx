import { useEffect, useState } from 'react';

export type PanelKind = 'outline' | 'thumbnails' | 'search' | null;

export interface ToolbarProps {
  mode: 'scroll' | 'page';
  page: number;
  total: number;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  panel: PanelKind;
  panelSupported: Record<'search' | 'outline' | 'thumbnails', boolean>;
  /** 是否显示批注按钮 */
  annotation?: boolean;
  /** 当前批注模式 */
  annotationMode?: 'none' | 'highlight' | 'freetext' | 'ink';
  /** 当前页的批注数量（显示角标） */
  annotationCount?: number;
  onPrev(): void;
  onNext(): void;
  onJump(page: number): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onResetZoom(): void;
  onTogglePanel(panel: PanelKind): void;
  onLocate(): void;
  onToggleAnnotation?(mode: 'highlight' | 'freetext' | 'ink'): void;
  onClearAnnotations?(): void;
}

/**
 * 底部工具栏（移动端优先）。
 *
 * 交互细节：
 * - 页码输入框在移动端用 inputMode="numeric"，聚焦时自动全选，输入完回车跳转；
 * - 工具栏可折叠：滚动阅读时点中间区域收起，把屏幕让给正文；
 * - 所有按钮 ≥ 40px 命中区，符合手指操作。
 */
export function Toolbar({
  mode,
  page,
  total,
  zoom,
  minZoom,
  maxZoom,
  panel,
  panelSupported,
  annotation = false,
  annotationMode = 'none',
  annotationCount = 0,
  onPrev,
  onNext,
  onJump,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onTogglePanel,
  onLocate,
  onToggleAnnotation,
  onClearAnnotations,
}: ToolbarProps) {
  const [draft, setDraft] = useState(String(page));
  const [editing, setEditing] = useState(false);
  const [annoMenuOpen, setAnnoMenuOpen] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(page));
  }, [page, editing]);

  // 切换模式时收起批注菜单，避免面板悬空
  useEffect(() => {
    setAnnoMenuOpen(false);
  }, [annotationMode]);

  const commit = () => {
    const value = Number.parseInt(draft, 10);
    if (Number.isFinite(value) && value >= 1 && value <= total) onJump(value);
    else setDraft(String(page));
    setEditing(false);
  };

  return (
    <nav className="pdfh5-toolbar" aria-label="阅读器工具栏">
      <button type="button" className="pdfh5-icon-btn" onClick={onPrev} disabled={page <= 1} aria-label="上一页">
        ‹
      </button>

      <div className="pdfh5-page-jump">
        <input
          className="pdfh5-page-input"
          value={draft}
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label="页码"
          onFocus={(event) => {
            setEditing(true);
            event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ''))}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
        />
        <span className="pdfh5-page-total">/ {total}</span>
      </div>

      <button type="button" className="pdfh5-icon-btn" onClick={onNext} disabled={page >= total} aria-label="下一页">
        ›
      </button>

      <span className="pdfh5-divider" aria-hidden="true" />

      <button
        type="button"
        className="pdfh5-icon-btn"
        onClick={onZoomOut}
        disabled={zoom <= minZoom + 0.001}
        aria-label="缩小"
      >
        −
      </button>
      <button type="button" className="pdfh5-zoom-label" onClick={onResetZoom} aria-label="恢复适配大小">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="pdfh5-icon-btn" onClick={onZoomIn} disabled={zoom >= maxZoom - 0.001} aria-label="放大">
        +
      </button>

      <span className="pdfh5-divider" aria-hidden="true" />

      <button
        type="button"
        className={`pdfh5-icon-btn ${panel === 'outline' ? 'is-active' : ''}`}
        onClick={() => onTogglePanel(panel === 'outline' ? null : 'outline')}
        disabled={!panelSupported.outline}
        aria-label="目录"
        aria-pressed={panel === 'outline'}
      >
        ☰
      </button>
      <button
        type="button"
        className={`pdfh5-icon-btn ${panel === 'thumbnails' ? 'is-active' : ''}`}
        onClick={() => onTogglePanel(panel === 'thumbnails' ? null : 'thumbnails')}
        disabled={!panelSupported.thumbnails}
        aria-label="缩略图"
        aria-pressed={panel === 'thumbnails'}
      >
        ▦
      </button>
      <button
        type="button"
        className={`pdfh5-icon-btn ${panel === 'search' ? 'is-active' : ''}`}
        onClick={() => onTogglePanel(panel === 'search' ? null : 'search')}
        aria-label="搜索"
        aria-pressed={panel === 'search'}
      >
        ⌕
      </button>
      <button type="button" className="pdfh5-icon-btn" onClick={onLocate} aria-label="回到适配大小">
        ⤢
      </button>

      {annotation ? (
        <div className="pdfh5-anno-menu-wrap">
          <button
            type="button"
            className={`pdfh5-icon-btn ${annotationMode !== 'none' ? 'is-active' : ''}`}
            onClick={() => {
              if (annotationMode !== 'none') {
                // 已在批注模式：再点一次退出，符合「开关」直觉
                onToggleAnnotation?.('highlight');
                setAnnoMenuOpen(false);
                return;
              }
              setAnnoMenuOpen((open) => !open);
            }}
            aria-label="批注"
            aria-pressed={annotationMode !== 'none'}
            aria-expanded={annoMenuOpen}
          >
            ✎
            {annotationCount > 0 ? <span className="pdfh5-anno-badge">{annotationCount}</span> : null}
          </button>

          {annoMenuOpen && annotationMode === 'none' ? (
            <div className="pdfh5-anno-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => onToggleAnnotation?.('highlight')}>
                <span className="pdfh5-anno-swatch" style={{ background: 'var(--pdfh5-anno-hl, #ffd400)' }} />
                高亮
              </button>
              <button type="button" role="menuitem" onClick={() => onToggleAnnotation?.('freetext')}>
                <span className="pdfh5-anno-swatch pdfh5-anno-swatch-text">A</span>
                文字批注
              </button>
              <button type="button" role="menuitem" onClick={() => onToggleAnnotation?.('ink')}>
                <span className="pdfh5-anno-swatch" style={{ background: 'var(--pdfh5-anno-ink, #e5484d)' }} />
                手写
              </button>
              {annotationCount > 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  className="pdfh5-anno-menu-danger"
                  onClick={() => {
                    onClearAnnotations?.();
                    setAnnoMenuOpen(false);
                  }}
                >
                  清空全部批注
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <span className="pdfh5-mode-tag" aria-hidden="true">
        {mode === 'page' ? '翻页' : '滚动'}
      </span>
    </nav>
  );
}
