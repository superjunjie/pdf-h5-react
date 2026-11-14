import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animateZoom } from './zoomAnimation';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 用 fake timers 驱动 rAF（vitest 的 fake timers 会 mock requestAnimationFrame） */
const tick = (ms: number) => {
  vi.advanceTimersByTime(ms);
};

describe('animateZoom', () => {
  it('从 from 插值到 to，结束时到达终值', () => {
    const values: number[] = [];
    const done = vi.fn();
    animateZoom({
      from: 1,
      to: 2,
      duration: 100,
      onUpdate: (z) => values.push(z),
      onDone: done,
    });
    tick(20);
    tick(20);
    tick(100);
    expect(values.length).toBeGreaterThan(1);
    expect(values[values.length - 1]).toBeCloseTo(2, 5);
    expect(done).toHaveBeenCalledTimes(1);
    // 单调递增
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-9);
    }
  });

  it('duration 为 0 时同步跳到终值', () => {
    const values: number[] = [];
    const handle = animateZoom({ from: 1, to: 3, duration: 0, onUpdate: (z) => values.push(z) });
    expect(values).toEqual([3]);
    expect(handle.finished).toBe(true);
  });

  it('cancel 后收敛到终值且不再回调', () => {
    const values: number[] = [];
    const handle = animateZoom({ from: 1, to: 2, duration: 200, onUpdate: (z) => values.push(z) });
    tick(50);
    const countBefore = values.length;
    handle.cancel();
    expect(handle.finished).toBe(true);
    // 取消时补一次终值
    expect(values[values.length - 1]).toBeCloseTo(2, 5);
    tick(500);
    expect(values.length).toBe(countBefore + 1);
  });

  it('easing 让中间值高于线性（easeOut 前快后慢）', () => {
    const samples: Array<{ z: number; p: number }> = [];
    animateZoom({
      from: 0,
      to: 1,
      duration: 100,
      onUpdate: (z, p) => samples.push({ z, p }),
    });
    tick(50);
    const mid = samples.find((s) => s.p >= 0.4 && s.p <= 0.6);
    if (mid) {
      // easeOutCubic 在 p=0.5 时已走完约 87.5%
      expect(mid.z).toBeGreaterThan(mid.p);
    }
  });

  it('自定义 easing 生效', () => {
    const values: number[] = [];
    animateZoom({
      from: 0,
      to: 10,
      duration: 100,
      easing: (t) => t, // 线性
      onUpdate: (z) => values.push(z),
    });
    tick(60);
    tick(100);
    expect(values[values.length - 1]).toBeCloseTo(10, 5);
  });
});
