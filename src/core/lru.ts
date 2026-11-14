/**
 * 通用 LRU 缓存（按字节 / 条目双上限淘汰）。
 *
 * 设计要点：
 * 1. 字节计量：位图这类大对象必须按内存占用淘汰，否则「条目数」上限会骗人；
 * 2. 被淘汰时回调 onEvict，调用方据此维护索引（例如 page -> bucket 的二级索引）；
 * 3. 允许超限保留唯一一条超大对象，避免「渲染完立刻被淘汰 → 每帧重渲染」的抖动。
 */
export type LruEvictReason = 'bytes' | 'entries' | 'delete' | 'clear' | 'replace';

export interface LruCacheOptions<K, V> {
  /** 字节上限，默认不限制 */
  maxBytes?: number;
  /** 条目上限，默认不限制 */
  maxEntries?: number;
  /** 单条缓存占用估算（字节），默认 1 */
  sizeOf?: (value: V, key: K) => number;
  onEvict?: (value: V, key: K, reason: LruEvictReason) => void;
  name?: string;
}

export interface LruCacheStats {
  name: string;
  entries: number;
  bytes: number;
  maxBytes: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface Entry<V> {
  value: V;
  size: number;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly sizeOf: (value: V, key: K) => number;
  private readonly onEvict?: (value: V, key: K, reason: LruEvictReason) => void;
  private readonly name: string;

  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: LruCacheOptions<K, V> = {}) {
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
    this.sizeOf = options.sizeOf ?? (() => 1);
    this.onEvict = options.onEvict;
    this.name = options.name ?? 'lru';
  }

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  /** 读取并提升为最近使用 */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // Map 的迭代顺序即插入顺序：删掉重插 = 移到队尾（最近使用）
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** 读取但不改变活跃度（用于「有多少可用」的探测） */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.bytes -= previous.size;
      this.map.delete(key);
      this.onEvict?.(previous.value, key, 'replace');
    }
    const size = Math.max(0, this.sizeOf(value, key));
    this.map.set(key, { value, size });
    this.bytes += size;
    this.trim(key);
    return this;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    this.map.delete(key);
    this.bytes -= entry.size;
    this.onEvict?.(entry.value, key, 'delete');
    return true;
  }

  clear(): void {
    for (const [key, entry] of this.map) {
      this.onEvict?.(entry.value, key, 'clear');
    }
    this.map.clear();
    this.bytes = 0;
  }

  /** 按最近使用顺序返回键（最旧 → 最新） */
  keys(): K[] {
    return [...this.map.keys()];
  }

  stats(): LruCacheStats {
    return {
      name: this.name,
      entries: this.map.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  private trim(keepKey: K): void {
    const overEntries = () => this.map.size > this.maxEntries;
    const overBytes = () => this.bytes > this.maxBytes;
    while (overEntries() || overBytes()) {
      const oldestKey = this.map.keys().next();
      if (oldestKey.done) return;
      // 只剩一条且是刚写入的超大对象时保留，避免「写入即淘汰」导致的重复渲染
      if (this.map.size === 1 && oldestKey.value === keepKey) return;
      const key = oldestKey.value;
      const entry = this.map.get(key)!;
      // 淘汰原因必须在扣减之前判定，否则字节已回落，就会被误记为条目数超限
      const reason: LruEvictReason = overBytes() ? 'bytes' : 'entries';
      this.map.delete(key);
      this.bytes -= entry.size;
      this.evictions += 1;
      this.onEvict?.(entry.value, key, reason);
    }
  }
}
