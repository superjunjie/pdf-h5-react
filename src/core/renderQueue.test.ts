import { describe, expect, it, vi } from 'vitest';
import { RenderQueue } from './renderQueue';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RenderQueue', () => {
  it('同 key 复用任务：只执行一次 run', async () => {
    const queue = new RenderQueue({ visibleConcurrency: 2, prefetchConcurrency: 1 });
    const run = vi.fn(async () => 'done');
    const a = queue.enqueue('p1@1', 'visible', run);
    const b = queue.enqueue('p1@1', 'prefetch', run);
    expect(await a).toBe('done');
    expect(await b).toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('引用计数：一部分调用方释放不会杀掉别人仍在用的任务', async () => {
    const queue = new RenderQueue({ visibleConcurrency: 1, prefetchConcurrency: 1 });
    let aborted = false;
    const run = async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'ok';
    };

    const first = queue.enqueue('p@1', 'visible', run);
    const second = queue.enqueue('p@1', 'visible', run);

    // 第一个调用方卸载：只归还引用，不应 cancel
    queue.release('p@1');
    await tick();
    expect(aborted).toBe(false);

    // 第二个调用方仍在等，任务应正常完成
    expect(await first).toBe('ok');
    expect(await second).toBe('ok');
    expect(aborted).toBe(false);
    queue.release('p@1');
  });

  it('引用计数归零后才真正取消', async () => {
    const queue = new RenderQueue({ visibleConcurrency: 1, prefetchConcurrency: 1 });
    let aborted = false;
    const run = (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 500);
        signal.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
          reject(new Error('cancelled'));
        });
      });

    const p = queue.enqueue('p@2', 'visible', run);
    p.catch(() => {});
    queue.release('p@2');
    queue.release('p@2'); // 归零
    await tick();
    expect(aborted).toBe(true);
  });

  it('可见任务优先于预取任务启动', async () => {
    const queue = new RenderQueue({ visibleConcurrency: 1, prefetchConcurrency: 0 });
    const order: string[] = [];
    queue.enqueue('prefetch-1', 'prefetch', async () => {
      order.push('prefetch');
      return 1;
    });
    const visible = queue.enqueue('visible-1', 'visible', async () => {
      order.push('visible');
      return 2;
    });
    expect(await visible).toBe(2);
    expect(order[0]).toBe('visible');
  });

  it('dropPendingPrefetch 丢弃未开始的预取任务', async () => {
    const queue = new RenderQueue({ visibleConcurrency: 1, prefetchConcurrency: 0 });
    queue.enqueue('v', 'visible', async () => new Promise((resolve) => setTimeout(() => resolve(1), 20)));
    const prefetch = queue.enqueue('pf', 'prefetch', async () => 2);
    prefetch.catch(() => {});
    const dropped = queue.dropPendingPrefetch();
    expect(dropped).toBe(1);
    expect(queue.pending).toBe(0);
  });

  it('统计 started / completed / cancelled', async () => {
    const queue = new RenderQueue({ visibleConcurrency: 2, prefetchConcurrency: 1 });
    await queue.enqueue('a', 'visible', async () => 1);
    const stats = queue.getStats();
    expect(stats.started).toBe(1);
    expect(stats.completed).toBe(1);
  });
});
