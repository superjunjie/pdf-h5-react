/**
 * 渲染调度器。
 *
 * 目标：移动端弱 GPU 下也保持滚动流畅。
 * 1. 双并发上限：可见页高优先，预取页低优先，各自独立限流；
 * 2. 同 key 合并：同一页同一档位只会有一个任务，重复请求复用同一个 Promise；
 * 3. 抢占：出现新的可见页时，丢弃尚未开始的预取任务（快速滚动时它们已无意义）；
 * 4. 可取消：离开视口时 abort，区分「取消」与「失败」。
 */
import { isCancelledError } from './errors';

export type RenderPriority = 'visible' | 'prefetch';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 避免调用方不 catch 时产生 unhandledrejection 噪音
  promise.catch(() => {});
  return { promise, resolve, reject };
}

interface Job<T> {
  key: string;
  /** 0 = 可见，1 = 预取 */
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
  deferred: Deferred<T>;
  abort: AbortController;
  /** 引用计数：同一任务可能被多个调用方共享，归零才可真正取消 */
  refs: number;
}

export interface RenderQueueOptions {
  visibleConcurrency?: number;
  prefetchConcurrency?: number;
  /** 任务之间让出主线程的延迟（ms），默认 0 */
  yieldDelay?: number;
}

export class RenderQueue {
  private jobs: Job<unknown>[] = [];
  private readonly running = new Map<string, Job<unknown>>();
  private visibleRunning = 0;
  private prefetchRunning = 0;
  private readonly visibleConcurrency: number;
  private readonly prefetchConcurrency: number;
  private readonly yieldDelay: number;
  private pumping = false;
  private stats = { started: 0, completed: 0, cancelled: 0 };

  constructor(options: RenderQueueOptions = {}) {
    // 移动端经验值：可见 2（当前页 + 相邻页并行），预取 1
    this.visibleConcurrency = Math.max(1, options.visibleConcurrency ?? 2);
    this.prefetchConcurrency = Math.max(0, options.prefetchConcurrency ?? 1);
    this.yieldDelay = options.yieldDelay ?? 0;
  }

  /** 提交任务；同 key 已在排队或执行中则复用其 Promise（引用计数 +1） */
  enqueue<T>(key: string, priority: RenderPriority, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const running = this.running.get(key);
    if (running) {
      running.refs += 1;
      return running.deferred.promise as Promise<T>;
    }

    const queued = this.jobs.find((job) => job.key === key);
    if (queued) {
      queued.refs += 1;
      if (priority === 'visible' && queued.priority !== 0) {
        queued.priority = 0;
        this.pump();
      }
      return queued.deferred.promise as Promise<T>;
    }

    const job: Job<T> = {
      key,
      priority: priority === 'visible' ? 0 : 1,
      run,
      deferred: defer<T>(),
      abort: new AbortController(),
      refs: 1,
    };
    this.jobs.push(job as unknown as Job<unknown>);
    this.pump();
    return job.deferred.promise;
  }

  /**
   * 归还一次使用权（引用计数 -1），归零时才真正取消。
   *
   * 为什么不能直接 cancel：任务在多个调用方之间共享（同一 page@scale 可能被
   * 可见区与预取区同时需要；React 严格模式下 effect 也会挂载两次）。
   * 「谁先卸载谁就 cancel」会把别人仍需的任务杀掉 —— 表现为页面一直空白：
   * 任务被 abort → Promise reject → 没有重试者。
   */
  release(key: string, reason: unknown = new Error('released')): void {
    const queued = this.jobs.find((job) => job.key === key);
    if (queued) {
      queued.refs -= 1;
      if (queued.refs <= 0) this.cancel(key, reason);
      return;
    }
    const running = this.running.get(key);
    if (running) {
      running.refs -= 1;
      if (running.refs <= 0) {
        running.abort.abort(reason);
        this.stats.cancelled += 1;
      }
    }
  }

  /** 取消某个 key（排队中直接丢弃，执行中触发 abort） */
  cancel(key: string, reason: unknown = new Error('cancelled')): void {
    const index = this.jobs.findIndex((job) => job.key === key);
    if (index >= 0) {
      const [job] = this.jobs.splice(index, 1);
      job.abort.abort(reason);
      job.deferred.reject(reason);
      this.stats.cancelled += 1;
      return;
    }
    const running = this.running.get(key);
    if (running) {
      running.abort.abort(reason);
      this.stats.cancelled += 1;
    }
  }

  /** 丢弃所有未开始的预取任务，返回丢弃数量 */
  dropPendingPrefetch(keep: (key: string) => boolean = () => false): number {
    let dropped = 0;
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) {
      const job = this.jobs[i];
      if (job.priority > 0 && !keep(job.key)) {
        this.jobs.splice(i, 1);
        const reason = new Error('preempted');
        job.abort.abort(reason);
        job.deferred.reject(reason);
        dropped += 1;
      }
    }
    return dropped;
  }

  get pending(): number {
    return this.jobs.length;
  }

  get active(): number {
    return this.running.size;
  }

  getStats() {
    return { ...this.stats };
  }

  cancelAll(reason: unknown = new Error('cancelled all')): void {
    const jobs = this.jobs;
    this.jobs = [];
    for (const job of jobs) {
      job.abort.abort(reason);
      job.deferred.reject(reason);
    }
    for (const job of this.running.values()) job.abort.abort(reason);
  }

  private canStart(priority: number): boolean {
    return priority === 0 ? this.visibleRunning < this.visibleConcurrency : this.prefetchRunning < this.prefetchConcurrency;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // 稳定排序：可见优先，同级保持提交顺序
      this.jobs.sort((a, b) => a.priority - b.priority);
      for (let i = 0; i < this.jobs.length; ) {
        const job = this.jobs[i];
        if (!this.canStart(job.priority)) {
          i += 1;
          continue;
        }
        this.jobs.splice(i, 1);
        this.start(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private start(job: Job<unknown>): void {
    this.running.set(job.key, job);
    if (job.priority === 0) this.visibleRunning += 1;
    else this.prefetchRunning += 1;
    this.stats.started += 1;

    const settle = () => {
      this.running.delete(job.key);
      if (job.priority === 0) this.visibleRunning = Math.max(0, this.visibleRunning - 1);
      else this.prefetchRunning = Math.max(0, this.prefetchRunning - 1);
      // 让出一拍再启动下一个，避免长任务连成一片卡住主线程
      if (this.yieldDelay > 0) setTimeout(() => this.pump(), this.yieldDelay);
      else queueMicrotask(() => this.pump());
    };

    job
      .run(job.abort.signal)
      .then((value) => {
        settle();
        this.stats.completed += 1;
        job.deferred.resolve(value);
      })
      .catch((error) => {
        settle();
        if (isCancelledError(error)) this.stats.cancelled += 1;
        job.deferred.reject(error);
      });
  }
}
