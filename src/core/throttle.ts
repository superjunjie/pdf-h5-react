/**
 * 高频事件节流工具。
 *
 * H5 阅读器里滚动、捏合、尺寸变化、进度、搜索输入都是高频源，
 * 一律先经过这里的三个工具再进入 React 状态，避免「一帧多次 setState」。
 */

export type AnyFn = (...args: any[]) => any;

export interface Cancelable {
  cancel(): void;
  /** 立即执行挂起的调用（用于离开页面 / 提交前冲刷） */
  flush(): void;
  /** 是否有挂起调用 */
  pending(): boolean;
}

const raf: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 16) as unknown as number;

const caf: (id: number) => void =
  typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);

/**
 * 每帧最多执行一次。滚动、缩放等「跟手」操作首选。
 */
export function rafThrottle<T extends AnyFn>(fn: T): T & Cancelable {
  let frame = 0;
  let lastArgs: any[] | null = null;
  let lastThis: any = null;

  const run = () => {
    frame = 0;
    if (lastArgs === null) return;
    const args = lastArgs;
    lastArgs = null;
    fn.apply(lastThis, args);
  };

  const wrapped = function (this: any, ...args: any[]) {
    lastArgs = args;
    lastThis = this;
    if (frame) return;
    frame = raf(run) as unknown as number;
  } as T & Cancelable;

  wrapped.cancel = () => {
    if (frame) caf(frame as unknown as number);
    frame = 0;
    lastArgs = null;
  };
  wrapped.flush = () => {
    if (!frame) return;
    caf(frame as unknown as number);
    run();
  };
  wrapped.pending = () => frame !== 0;
  return wrapped;
}

export interface ThrottleOptions {
  /** 首次调用是否立即执行，默认 true */
  leading?: boolean;
  /** 尾随调用是否补一次，默认 true */
  trailing?: boolean;
}

/**
 * 固定时间窗节流（滚动进度、加载进度、日志上报）。
 */
export function throttle<T extends AnyFn>(fn: T, wait = 100, options: ThrottleOptions = {}): T & Cancelable {
  const leading = options.leading ?? true;
  const trailing = options.trailing ?? true;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastInvoke = 0;
  let lastArgs: any[] | null = null;
  let lastThis: any = null;

  const invoke = () => {
    lastInvoke = Date.now();
    const args = lastArgs;
    lastArgs = null;
    if (args) fn.apply(lastThis, args);
  };

  const onTimer = () => {
    timer = null;
    if (trailing && lastArgs) invoke();
  };

  const wrapped = function (this: any, ...args: any[]) {
    const now = Date.now();
    if (!lastInvoke && !leading) lastInvoke = now;
    const remaining = wait - (now - lastInvoke);
    lastArgs = args;
    lastThis = this;
    if (remaining <= 0 || remaining > wait) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke();
      return;
    }
    if (!timer && trailing) {
      timer = setTimeout(onTimer, remaining);
    }
  } as T & Cancelable;

  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    lastInvoke = 0;
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) invoke();
  };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

/**
 * 防抖（搜索输入、缩放落定后的重渲染）。
 */
export function debounce<T extends AnyFn>(fn: T, wait = 200): T & Cancelable {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;
  let lastThis: any = null;

  const wrapped = function (this: any, ...args: any[]) {
    lastArgs = args;
    lastThis = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args2 = lastArgs;
      lastArgs = null;
      if (args2) fn.apply(lastThis, args2);
    }, wait);
  } as T & Cancelable;

  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      const args2 = lastArgs;
      lastArgs = null;
      fn.apply(lastThis, args2);
    }
  };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

/**
 * 批量合并：把一帧内多次 push 的条目合成一次回调。
 * 用于「500 页尺寸陆续到达」这类必须批量更新的场景。
 */
export function rafBatch<T>(onFlush: (items: T[]) => void, maxBatch = 64): { push(item: T): void; cancel(): void } {
  let items: T[] = [];
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (items.length === 0) return;
    const batch = items;
    items = [];
    onFlush(batch);
  };

  return {
    push(item: T) {
      items.push(item);
      if (items.length >= maxBatch) {
        if (frame) caf(frame as unknown as number);
        flush();
        return;
      }
      if (frame) return;
      frame = raf(flush) as unknown as number;
    },
    cancel() {
      if (frame) caf(frame as unknown as number);
      frame = 0;
      items = [];
    },
  };
}
