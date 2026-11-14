import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, rafBatch, rafThrottle, throttle } from './throttle';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rafThrottle', () => {
  it('同一帧内多次调用只执行一次，并带上最后一次参数', () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t(2);
    t(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('flush 立即执行，cancel 丢弃挂起调用', () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t('a');
    t.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    t('b');
    t.cancel();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('throttle', () => {
  it('领先 + 尾随', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    expect(fn).toHaveBeenCalledTimes(1);
    t(2);
    t(3);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  it('仅领先模式不补尾随', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100, { trailing: false });
    t(1);
    t(2);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel 后不再触发', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t.cancel();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('debounce', () => {
  it('静默期结束才执行，只保留最后一次', () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d('a');
    d('b');
    vi.advanceTimersByTime(150);
    expect(fn).not.toHaveBeenCalled();
    d('c');
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('flush 立即冲刷', () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d('x');
    d.flush();
    expect(fn).toHaveBeenCalledWith('x');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('rafBatch', () => {
  it('一帧内合并为一次回调', () => {
    const flush = vi.fn();
    const batch = rafBatch<number>(flush);
    batch.push(1);
    batch.push(2);
    batch.push(3);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toEqual([1, 2, 3]);
  });

  it('达到 maxBatch 立即冲刷', () => {
    const flush = vi.fn();
    const batch = rafBatch<number>(flush, 2);
    batch.push(1);
    batch.push(2);
    expect(flush).toHaveBeenCalledTimes(1);
    batch.cancel();
    vi.advanceTimersByTime(20);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
