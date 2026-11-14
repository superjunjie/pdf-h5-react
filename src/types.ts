import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ReaderEvents, ReaderEventName, ReaderStatus } from './core/readerEvents';
import type { Annotation, AnnotationMode } from './core/annotations';

/** PDF 源：URL / 字符串 / 二进制 / 自定义参数 */
export type PdfSource =
  | string
  | URL
  | ArrayBuffer
  | Uint8Array
  | {
      url?: string | URL;
      data?: ArrayBuffer | Uint8Array;
      httpHeaders?: Record<string, string>;
      withCredentials?: boolean;
      password?: string;
      range?: unknown;
    };

export type ViewerMode = 'scroll' | 'page';

export type FitMode = 'width' | 'page' | 'none';

export type ThemeMode = 'light' | 'dark' | 'auto';

export interface LoadProgress {
  loaded: number;
  total: number;
  /** 0 - 1；total 为 0 时为 null */
  ratio: number | null;
}

/** 单页的原始度量（PDF 点，未乘 userUnit 以外的任何缩放） */
export interface PageMetric {
  pageNumber: number;
  /** 已乘 userUnit 的宽（PDF 单位 → CSS px @ scale 1） */
  width: number;
  height: number;
  /** PDF 自带的旋转角度 */
  rotate: number;
  userUnit: number;
}

export interface CacheStatsSnapshot {
  bitmap: { entries: number; bytes: number; maxBytes: number; hits: number; misses: number; evictions: number };
  text: { entries: number; bytes: number; maxBytes: number; hits: number; misses: number; evictions: number };
  page: { entries: number; bytes: number; maxBytes: number; hits: number; misses: number; evictions: number };
  thumbnail: { entries: number; bytes: number; maxBytes: number; hits: number; misses: number; evictions: number };
  metrics: { entries: number };
  renders: { started: number; completed: number; cancelled: number; cacheHits: number; cacheMisses: number };
  /** 高频事件节流效果：产生的事件数 vs 实际处理数 */
  throttle: { scrollEvents: number; scrollHandled: number; sizeEvents: number; sizeHandled: number };
}

export interface PdfH5ReaderHandle {
  /** 当前文档代理（未加载完成时为 null） */
  getDocument(): PDFDocumentProxy | null;
  getCurrentPage(): number;
  goToPage(page: number, options?: { smooth?: boolean }): void;
  nextPage(): void;
  prevPage(): void;
  setZoom(zoom: number, anchor?: { x: number; y: number }): void;
  zoomIn(step?: number): void;
  zoomOut(step?: number): void;
  resetZoom(): void;
  search(query: string): Promise<SearchHit[]>;
  clearSearch(): void;
  getCacheStats(): CacheStatsSnapshot;
  clearCaches(): void;
  /** 打开 / 关闭内置面板 */
  openPanel(panel: 'outline' | 'thumbnails' | 'search' | null): void;

  // ---- 事件订阅（命令式，等价于 props 回调）----
  /**
   * 监听事件，返回取消订阅函数。
   *
   * ```ts
   * const off = ref.current.on('pageChange', ({ page, total }) => setPage(page));
   * off(); // 取消
   * ```
   */
  on<K extends ReaderEventName>(type: K, listener: (payload: ReaderEvents[K]) => void): () => void;
  /** 只监听一次 */
  once<K extends ReaderEventName>(type: K, listener: (payload: ReaderEvents[K]) => void): () => void;
  /** 移除监听；不传 listener 时清空该事件 */
  off<K extends ReaderEventName>(type: K, listener?: (payload: ReaderEvents[K]) => void): void;
  /** 手动触发事件（调试 / 业务自定义事件透传） */
  trigger<K extends ReaderEventName>(type: K, payload: ReaderEvents[K]): void;
  /** 运行状态快照 */
  getStatus(): ReaderStatus;

  // ---- 注释 ----
  /** 当前全部批注 */
  getAnnotations(): Annotation[];
  /** 追加一条批注 */
  addAnnotation(annotation: Annotation): void;
  /** 按 id 删除 */
  removeAnnotation(id: string): void;
  /** 清空全部批注 */
  clearAnnotations(): void;
  /** 切换批注工具；'none' 表示退出批注模式 */
  setAnnotationMode(mode: AnnotationMode): void;
  /** 当前批注模式 */
  getAnnotationMode(): AnnotationMode;
}

export interface SearchHit {
  pageNumber: number;
  /** 匹配到的纯文本 */
  text: string;
  /** 所在文本项的下标 */
  itemIndex: number;
  start: number;
  end: number;
  /** 上下文片段，命中处用 \u0000 包裹 */
  snippet: string;
}
