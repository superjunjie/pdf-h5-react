/**
 * 阅读器事件表。
 *
 * 事件名与载荷参考 pdfh5 的约定（init / ready / render / scroll / zoom ...），
 * 但载荷结构做了取舍：pdfh5 的部分事件用 `Function(msg, time)` 这类多参数形式，
 * 这里统一成「单个对象」—— 便于类型推导，也方便后续在不破坏兼容的前提下加字段。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** 渲染一页的耗时信息 */
export interface RenderTiming {
  pageNumber: number;
  /** 本页渲染耗时（ms） */
  pageTime: number;
}

export interface ReaderStatus {
  /** 文档是否已就绪 */
  ready: boolean;
  /** 是否正在加载 */
  loading: boolean;
  /** 总页数，未就绪时为 0 */
  total: number;
  /** 当前页（1 基） */
  page: number;
  /** 当前缩放倍率 */
  zoom: number;
  /** 已解析尺寸的页数（渐进式度量进度） */
  measured: number;
  /** 位图缓存估算占用（字节） */
  cacheBytes: number;
  /** 已挂载的页面 DOM 数（虚拟化效果的直接体现） */
  mountedPages: number;
  /** 最近一次错误信息 */
  error: string | null;
  /** 手势缩放是否启用 */
  zoomEnabled: boolean;
  /** 滚动是否启用 */
  scrollEnabled: boolean;
}

export interface ZoomEventPayload {
  zoom: number;
  /** 相对缩放开始时的倍率变化 */
  scaleChange: number;
  /** 手势 / 动画开始时的倍率 */
  startZoom: number;
  /** 本次缩放耗时（ms），动画结束或手势结束时给出 */
  duration: number;
  /** 触发来源，便于区分埋点 */
  source: 'gesture' | 'doubleTap' | 'button' | 'wheel' | 'api' | 'reset';
}

export interface ScrollEventPayload {
  scrollTop: number;
  scrollLeft: number;
  currentPage: number;
  /** 卷动进度 0-1 */
  progress: number;
}

export interface ReaderEvents {
  /** 开始初始化（文档尚未加载） */
  init: { src: unknown };
  /** 文档已加载，可以拿到总页数 */
  ready: { doc: PDFDocumentProxy; total: number };
  /** 加载失败 */
  error: { error: Error; message: string; time: number };
  /** 某一页渲染完成 */
  render: RenderTiming & { totalTime: number };
  /** 渲染成功（首屏可用） */
  success: { message: string; time: number };
  /** 加载流程结束（无论成功失败都会触发，与 pdfh5 的 complete 语义一致） */
  complete: { status: 'success' | 'error'; message: string; time: number };
  /** 滚动（已节流） */
  scroll: ScrollEventPayload;
  /** 当前页变化 */
  pageChange: { page: number; total: number };
  /** 缩放值变化（手势过程中也会触发，已节流） */
  zoom: { zoom: number; source: ZoomEventPayload['source'] };
  /** 缩放开始 */
  zoomStart: { zoom: number; source: ZoomEventPayload['source'] };
  /** 缩放结束（含动画） */
  zoomEnd: ZoomEventPayload;
  /** 缩放开关变化 */
  zoomEnabled: { enabled: boolean };
  /** 滚动开关变化 */
  scrollEnabled: { enabled: boolean };
  /** 用户点击回到顶部 */
  backTop: { from: number };
  /** 组件销毁 */
  destroy: Record<string, never>;
}

export type ReaderEventName = keyof ReaderEvents;

export type ReaderEventPayload<K extends ReaderEventName> = ReaderEvents[K];
