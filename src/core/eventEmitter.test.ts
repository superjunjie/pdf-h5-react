import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from './eventEmitter';

type TestEvents = {
  ping: { n: number };
  pong: { s: string };
  empty: Record<string, never>;
};

describe('EventEmitter', () => {
  it('订阅并派发载荷', () => {
    const bus = new EventEmitter<TestEvents>();
    const received: number[] = [];
    bus.on('ping', (payload) => received.push(payload.n));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(received).toEqual([1, 2]);
  });

  it('on 返回的取消函数可移除自身', () => {
    const bus = new EventEmitter<TestEvents>();
    const fn = vi.fn();
    const off = bus.on('ping', fn);
    bus.emit('ping', { n: 1 });
    off();
    bus.emit('ping', { n: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('off 只移除指定回调，不影响其它监听者', () => {
    const bus = new EventEmitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('ping', a);
    bus.on('ping', b);
    bus.off('ping', a);
    bus.emit('ping', { n: 1 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('off 不传回调时清空该事件（兼容 pdfh5 用法）', () => {
    const bus = new EventEmitter<TestEvents>();
    bus.on('ping', vi.fn());
    bus.on('ping', vi.fn());
    bus.off('ping');
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('once 只触发一次', () => {
    const bus = new EventEmitter<TestEvents>();
    const fn = vi.fn();
    bus.once('ping', fn);
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('单个监听器抛错不会中断其它监听器', () => {
    const bus = new EventEmitter<TestEvents>();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', after);
    expect(() => bus.emit('ping', { n: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('回调内 off 自己不会导致本轮漏发', () => {
    const bus = new EventEmitter<TestEvents>();
    const order: string[] = [];
    const first = () => {
      order.push('first');
      bus.off('ping', first);
    };
    bus.on('ping', first);
    bus.on('ping', () => order.push('second'));
    bus.emit('ping', { n: 1 });
    // 本轮仍应把 second 派发出去（数组快照）
    expect(order).toEqual(['first', 'second']);
    // 下一轮 first 已移除
    bus.emit('ping', { n: 2 });
    expect(order).toEqual(['first', 'second', 'second']);
  });

  it('无监听者时派发是安全的', () => {
    const bus = new EventEmitter<TestEvents>();
    expect(() => bus.emit('empty', {} as Record<string, never>)).not.toThrow();
  });

  it('不同类型的事件互不干扰', () => {
    const bus = new EventEmitter<TestEvents>();
    const ping = vi.fn();
    const pong = vi.fn();
    bus.on('ping', ping);
    bus.on('pong', pong);
    bus.emit('ping', { n: 1 });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(pong).not.toHaveBeenCalled();
  });

  it('clear 清空所有事件', () => {
    const bus = new EventEmitter<TestEvents>();
    bus.on('ping', vi.fn());
    bus.on('pong', vi.fn());
    bus.clear();
    expect(bus.listenerCount('ping')).toBe(0);
    expect(bus.listenerCount('pong')).toBe(0);
  });
});
