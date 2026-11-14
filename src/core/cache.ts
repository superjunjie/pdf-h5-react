/**
 * 多级缓存：位图（canvas）、文本层 DOM、页面代理、缩略图。
 *
 * 三者都基于 LruCache，但语义不同：
 * - 位图缓存：按 (page, scaleBucket) 存储离屏 canvas，字节计量，渲染完成即可复用；
 * - 文本层缓存：按 page 存储已构建的 TextLayer DOM，缩放时走 update() 重排，
 *   避免每次滚动回来都重建上百个 span；
 * - 页面代理缓存：PDFPageProxy 持有解析后的资源，重复 getPage 代价不小。
 *
 * 所有缓存都支持 pin/unpin：正在屏幕上显示的条目不会被淘汰，
 * 否则会出现「刚渲染完就被淘汰 → 下一帧重渲染」的抖动。
 */
import type { PDFPageProxy } from 'pdfjs-dist';
import { LruCache, type LruCacheStats } from './lru';
import { bitmapBytes } from './layout';

export interface SizedCanvas {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  bytes: number;
}

export function createCacheCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

export function disposeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas | null | undefined): void {
  if (!canvas) return;
  // 把尺寸置 0 是让浏览器尽快回收位图内存的关键；仅删引用不够快
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* 某些环境不支持 */
  }
}

/** 支持 pin 的 LRU 包装：被 pin 的条目跳过淘汰 */
class PinnableCache<K, V> {
  readonly lru: LruCache<K, V>;
  private readonly pinned = new Set<K>();

  constructor(lru: LruCache<K, V>) {
    this.lru = lru;
  }

  get size() {
    return this.lru.size;
  }

  get byteSize() {
    return this.lru.byteSize;
  }

  get(key: K): V | undefined {
    return this.lru.get(key);
  }

  has(key: K): boolean {
    return this.lru.has(key);
  }

  set(key: K, value: V): void {
    this.lru.set(key, value);
  }

  pin(key: K): void {
    this.pinned.add(key);
  }

  unpin(key: K): void {
    this.pinned.delete(key);
  }

  isPinned(key: K): boolean {
    return this.pinned.has(key);
  }

  delete(key: K): void {
    this.pinned.delete(key);
    this.lru.delete(key);
  }

  clear(): void {
    this.pinned.clear();
    this.lru.clear();
  }

  stats(): LruCacheStats {
    return this.lru.stats();
  }
}

export interface BitmapEntry extends SizedCanvas {
  key: string;
  pageNumber: number;
  scale: number;
  canvas: HTMLCanvasElement;
}

export interface BitmapCacheOptions {
  maxBytes?: number;
  onEvict?: (entry: BitmapEntry) => void;
}

/**
 * 位图缓存。key = `${pageNumber}@${scaleBucket}`。
 * 缩放时量化到固定档位，来回捏合不会反复触发渲染。
 */
export class BitmapCache {
  private readonly cache: PinnableCache<string, BitmapEntry>;

  constructor(options: BitmapCacheOptions = {}) {
    const onEvict = options.onEvict;
    this.cache = new PinnableCache(
      new LruCache<string, BitmapEntry>({
        name: 'bitmap',
        // 默认 96MB：约等于 6 页 A4 @2x，足够覆盖可见区 + 前后各一页
        maxBytes: options.maxBytes ?? 96 * 1024 * 1024,
        sizeOf: (entry) => entry.bytes,
        onEvict: (entry, _key, reason) => {
          onEvict?.(entry);
          // 可见条目在 unpin 之后若仍未被使用，才真正释放
          if (reason !== 'replace') disposeCanvas(entry.canvas);
        },
      }),
    );
  }

  static key(pageNumber: number, scale: number): string {
    return `${pageNumber}@${scale.toFixed(3)}`;
  }

  get(pageNumber: number, scale: number): BitmapEntry | undefined {
    return this.cache.get(BitmapCache.key(pageNumber, scale));
  }

  take(pageNumber: number, scale: number): BitmapEntry | undefined {
    const entry = this.get(pageNumber, scale);
    if (entry) this.cache.pin(entry.key);
    return entry;
  }

  release(entry: BitmapEntry | undefined): void {
    if (!entry) return;
    this.cache.unpin(entry.key);
  }

  put(pageNumber: number, scale: number, canvas: HTMLCanvasElement): BitmapEntry {
    const width = canvas.width;
    const height = canvas.height;
    const entry: BitmapEntry = {
      key: BitmapCache.key(pageNumber, scale),
      pageNumber,
      scale,
      canvas,
      width,
      height,
      bytes: bitmapBytes(width, height),
    };
    this.cache.set(entry.key, entry);
    return entry;
  }

  has(pageNumber: number, scale: number): boolean {
    return this.cache.has(BitmapCache.key(pageNumber, scale));
  }

  /** 丢掉某一页的所有档位（例如页面被移出远区） */
  dropPage(pageNumber: number): void {
    for (const key of this.cache.lru.keys()) {
      const entry = this.cache.get(key);
      if (entry && entry.pageNumber === pageNumber) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  stats() {
    return this.cache.stats();
  }
}

export interface TextLayerEntry {
  pageNumber: number;
  /** 已构建好的 .textLayer 节点，可 detach / re-attach */
  node: HTMLDivElement;
  scale: number;
  viewportScale: number;
  bytes: number;
  /** pdf.js TextLayer 实例，用于 update({viewport}) */
  update: (viewport: unknown) => void;
  destroy: () => void;
}

export interface TextLayerCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

/**
 * 文本层 DOM 缓存。构建一次成本高（几百个 span + 字体测量），
 * 滚动离开视口后保留，回来后直接挂回 DOM。
 */
export class TextLayerCache {
  private readonly cache: PinnableCache<number, TextLayerEntry>;

  constructor(options: TextLayerCacheOptions = {}) {
    this.cache = new PinnableCache(
      new LruCache<number, TextLayerEntry>({
        name: 'text',
        maxEntries: options.maxEntries ?? 24,
        maxBytes: options.maxBytes ?? 24 * 1024 * 1024,
        sizeOf: (entry) => entry.bytes,
        onEvict: (entry, _key, reason) => {
          if (reason !== 'replace') entry.destroy();
        },
      }),
    );
  }

  get(pageNumber: number): TextLayerEntry | undefined {
    return this.cache.get(pageNumber);
  }

  take(pageNumber: number): TextLayerEntry | undefined {
    const entry = this.cache.get(pageNumber);
    if (entry) this.cache.pin(pageNumber);
    return entry;
  }

  release(pageNumber: number): void {
    this.cache.unpin(pageNumber);
  }

  put(entry: TextLayerEntry): void {
    this.cache.set(entry.pageNumber, entry);
  }

  delete(pageNumber: number): void {
    this.cache.delete(pageNumber);
  }

  clear(): void {
    this.cache.clear();
  }

  stats() {
    return this.cache.stats();
  }
}

/** 页面代理缓存：避免反复调用 doc.getPage() */
export class PageProxyCache {
  private readonly cache: LruCache<number, PDFPageProxy>;
  private readonly inflight = new Map<number, Promise<PDFPageProxy>>();
  private doc: { getPage(n: number): Promise<PDFPageProxy> } | null = null;

  constructor(doc: { getPage(n: number): Promise<PDFPageProxy> } | null, maxEntries = 48) {
    this.doc = doc;
    this.cache = new LruCache<number, PDFPageProxy>({
      name: 'page',
      maxEntries,
      sizeOf: () => 1,
    });
  }

  /** 同步读取（命中即返回，不发起请求） */
  peek(pageNumber: number): PDFPageProxy | undefined {
    return this.cache.get(pageNumber);
  }

  async get(pageNumber: number): Promise<PDFPageProxy> {
    const cached = this.cache.get(pageNumber);
    if (cached) return cached;
    const inflight = this.inflight.get(pageNumber);
    if (inflight) return inflight;

    const doc = this.doc;
    if (!doc) throw new Error('document not ready');

    const promise = doc.getPage(pageNumber).then((page) => {
      this.cache.set(pageNumber, page);
      this.inflight.delete(pageNumber);
      return page;
    });
    promise.catch(() => this.inflight.delete(pageNumber));
    this.inflight.set(pageNumber, promise);
    return promise;
  }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  stats() {
    return this.cache.stats();
  }
}

export interface ThumbnailEntry {
  pageNumber: number;
  dataUrl: string;
  bytes: number;
}

/** 缩略图缓存（dataURL，体积小但数量多） */
export class ThumbnailCache {
  private readonly cache: LruCache<number, ThumbnailEntry>;

  constructor(maxEntries = 120) {
    this.cache = new LruCache<number, ThumbnailEntry>({
      name: 'thumbnail',
      maxEntries,
      sizeOf: (entry) => entry.bytes,
    });
  }

  get(pageNumber: number): ThumbnailEntry | undefined {
    return this.cache.get(pageNumber);
  }

  put(pageNumber: number, dataUrl: string): void {
    this.cache.set(pageNumber, { pageNumber, dataUrl, bytes: dataUrl.length * 2 });
  }

  clear(): void {
    this.cache.clear();
  }

  stats() {
    return this.cache.stats();
  }
}
