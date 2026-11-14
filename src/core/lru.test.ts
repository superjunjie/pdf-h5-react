import { describe, expect, it, vi } from 'vitest';
import { LruCache } from './lru';

interface Item {
  id: string;
  bytes: number;
}

const sizeOf = (item: Item) => item.bytes;

describe('LruCache', () => {
  it('按最近使用顺序淘汰', () => {
    const cache = new LruCache<string, Item>({ maxEntries: 2, sizeOf });
    cache.set('a', { id: 'a', bytes: 1 });
    cache.set('b', { id: 'b', bytes: 1 });
    expect(cache.get('a')).toBeDefined(); // a 变为最近使用
    cache.set('c', { id: 'c', bytes: 1 });
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('按字节上限淘汰，并回报淘汰原因', () => {
    const evicted: Array<[string, string]> = [];
    const cache = new LruCache<string, Item>({
      maxBytes: 100,
      sizeOf,
      onEvict: (_value, key, reason) => evicted.push([key, reason]),
    });
    cache.set('a', { id: 'a', bytes: 60 });
    cache.set('b', { id: 'b', bytes: 30 });
    expect(cache.byteSize).toBe(90);
    cache.set('c', { id: 'c', bytes: 50 });
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.byteSize).toBe(80);
    expect(evicted).toEqual([['a', 'bytes']]);
    expect(cache.stats().evictions).toBe(1);
  });

  it('覆盖写入不会重复计算字节', () => {
    const cache = new LruCache<string, Item>({ maxBytes: 100, sizeOf });
    cache.set('a', { id: 'a', bytes: 40 });
    cache.set('a', { id: 'a', bytes: 10 });
    expect(cache.byteSize).toBe(10);
    expect(cache.size).toBe(1);
    expect(cache.peek('a')?.bytes).toBe(10);
  });

  it('唯一超大对象不会被立刻淘汰（避免抖动）', () => {
    const cache = new LruCache<string, Item>({ maxBytes: 10, sizeOf });
    cache.set('huge', { id: 'huge', bytes: 1000 });
    expect(cache.has('huge')).toBe(true);
    // 再来一条时才会被挤掉
    cache.set('small', { id: 'small', bytes: 1 });
    expect(cache.has('huge')).toBe(false);
    expect(cache.has('small')).toBe(true);
  });

  it('命中率统计正确', () => {
    const cache = new LruCache<string, Item>({ maxEntries: 4, sizeOf });
    cache.set('a', { id: 'a', bytes: 1 });
    cache.get('a');
    cache.get('missing');
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.name).toBe('lru');
  });

  it('delete / clear 会触发 onEvict 以便维护外部索引', () => {
    const onEvict = vi.fn();
    const cache = new LruCache<string, Item>({ sizeOf, onEvict });
    cache.set('a', { id: 'a', bytes: 1 });
    cache.delete('a');
    expect(onEvict).toHaveBeenCalledWith({ id: 'a', bytes: 1 }, 'a', 'delete');
    cache.set('b', { id: 'b', bytes: 1 });
    cache.clear();
    expect(onEvict).toHaveBeenCalledWith({ id: 'b', bytes: 1 }, 'b', 'clear');
    expect(cache.byteSize).toBe(0);
  });
});
