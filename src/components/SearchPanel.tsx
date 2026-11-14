import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '../types';
import type { CacheStatsSnapshot } from '../types';
import { debounce } from '../core/throttle';
import { splitSnippet } from '../lib/text';
import { usePanelDismiss } from '../lib/outline';

export interface SearchPanelProps {
  hits: readonly SearchHit[];
  index: number;
  onSearch(query: string): Promise<SearchHit[]>;
  onSelect(index: number): void;
  onClose(): void;
  /** 缓存统计（用于「性能」诊断区） */
  stats?: CacheStatsSnapshot | null;
  onClearCaches?(): void;
}

const DEBOUNCE_MS = 260;

/**
 * 搜索面板。
 *
 * 输入用防抖（260ms）避免逐字触发全文档扫描；
 * 扫描本身在 lib/search 里逐页让出主线程，不会阻塞滚动。
 */
export function SearchPanel({ hits, index, onSearch, onSelect, onClose, stats, onClearCaches }: SearchPanelProps) {
  const { onBackdrop } = usePanelDismiss(onClose);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const debouncedSearch = useMemo(
    () =>
      debounce(async (value: string) => {
        if (!value.trim()) {
          await onSearch('');
          setBusy(false);
          return;
        }
        setBusy(true);
        try {
          await onSearch(value);
        } finally {
          setBusy(false);
        }
      }, DEBOUNCE_MS),
    [onSearch],
  );

  useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

  const handleChange = (value: string) => {
    setQuery(value);
    setBusy(Boolean(value.trim()));
    debouncedSearch(value);
  };

  return (
    <div className="pdfh5-panel-backdrop" onClick={onBackdrop} role="presentation">
      <aside className="pdfh5-panel pdfh5-panel-search" role="dialog" aria-label="搜索">
        <header className="pdfh5-panel-head">
          <h2>搜索</h2>
          <button type="button" className="pdfh5-icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="pdfh5-search-bar">
          <input
            ref={inputRef}
            className="pdfh5-search-input"
            value={query}
            onChange={(event) => handleChange(event.target.value)}
            placeholder="输入关键词…"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="pdfh5-icon-btn" onClick={() => handleChange('')} aria-label="清空">
              ✕
            </button>
          ) : null}
        </div>

        <p className="pdfh5-search-summary">
          {busy ? '搜索中…' : query ? `共 ${hits.length} 条结果` : '输入关键词以搜索全文'}
        </p>

        <div className="pdfh5-search-list">
          {hits.map((hit, hitIndex) => (
            <button
              key={`${hit.pageNumber}-${hit.start}-${hitIndex}`}
              type="button"
              className={`pdfh5-search-item ${hitIndex === index ? 'is-active' : ''}`}
              onClick={() => onSelect(hitIndex)}
            >
              <span className="pdfh5-search-page">第 {hit.pageNumber} 页</span>
              <span className="pdfh5-search-snippet">
                {splitSnippet(hit.snippet).map((part, partIndex) =>
                  part.hit ? <mark key={partIndex}>{part.text}</mark> : <span key={partIndex}>{part.text}</span>,
                )}
              </span>
            </button>
          ))}
          {!busy && query && hits.length === 0 ? <p className="pdfh5-empty">没有找到匹配内容</p> : null}
        </div>

        {stats ? (
          <section className="pdfh5-perf">
            <h3>运行状态</h3>
            <dl>
              <div>
                <dt>位图缓存</dt>
                <dd>
                  {stats.bitmap.entries} 张 / {(stats.bitmap.bytes / 1024 / 1024).toFixed(1)} MB
                </dd>
              </div>
              <div>
                <dt>文本层缓存</dt>
                <dd>{stats.text.entries} 页</dd>
              </div>
              <div>
                <dt>缩略图缓存</dt>
                <dd>{stats.thumbnail.entries} 张</dd>
              </div>
              <div>
                <dt>渲染任务</dt>
                <dd>
                  完成 {stats.renders.completed} / 取消 {stats.renders.cancelled}
                </dd>
              </div>
              <div>
                <dt>缓存命中</dt>
                <dd>
                  {stats.renders.cacheHits} 次 / 淘汰 {stats.bitmap.evictions} 次
                </dd>
              </div>
            </dl>
            {onClearCaches ? (
              <button type="button" className="pdfh5-btn" onClick={onClearCaches}>
                清空所有缓存
              </button>
            ) : null}
          </section>
        ) : null}
      </aside>
    </div>
  );
}
