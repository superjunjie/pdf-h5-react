/**
 * 缩放动画。
 *
 * pdfh5 有 `animationDuration`（默认 300ms），双击 / 按钮缩放走缓动动画而不是瞬变。
 * 那个手感差异很明显：瞬变会让人「晕」，动画则保留了空间连续性。
 *
 * 实现要点：
 * 1. 用 rAF 推进，缓动用 easeOutCubic（快进慢出，符合手指离开后的惯性直觉）；
 * 2. 每帧回调的是「插值后的 zoom + 锚点滚位」，调用方只负责应用，不关心动画细节；
 * 3. 可中途取消（用户再次触摸时立刻停下），避免和手势抢控制权；
 * 4. 尊重 `prefers-reduced-motion`：系统要求减少动效时直接跳到终值。
 */

export interface ZoomAnimationOptions {
  from: number;
  to: number;
  duration: number;
  /** 每帧回调：progress 为 0-1 */
  onUpdate: (zoom: number, progress: number) => void;
  onDone?: () => void;
  /** 缓动函数，默认 easeOutCubic */
  easing?: (t: number) => number;
}

export interface AnimationHandle {
  cancel(): void;
  readonly finished: boolean;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** rAF 的兼容封装：非浏览器环境（单元测试 / SSR）退化为 setTimeout */
const requestFrame = (cb: () => void): number => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(cb, 16) as unknown as number;
};

const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 是否应当禁用动画（系统偏好 / 不可见页面） */
export function shouldReduceMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 启动一次缩放动画。
 * duration <= 0 或系统要求减少动效时，同步跳到终值并立即结束。
 */
export function animateZoom(options: ZoomAnimationOptions): AnimationHandle {
  const { from, to, onUpdate, onDone } = options;
  const easing = options.easing ?? easeOutCubic;
  const duration = Math.max(0, options.duration);
  const disabled = duration === 0 || shouldReduceMotion();

  let raf = 0;
  let cancelled = false;
  let finished = false;

  const finish = () => {
    finished = true;
    onDone?.();
  };

  if (disabled) {
    onUpdate(to, 1);
    finish();
    return {
      cancel() {},
      get finished() {
        return true;
      },
    };
  }

  const startTime = now();

  const step = () => {
    if (cancelled) return;
    const elapsed = now() - startTime;
    const progress = Math.min(1, elapsed / duration);
    const eased = easing(progress);
    const zoom = from + (to - from) * eased;
    onUpdate(zoom, progress);
    if (progress >= 1) {
      finish();
      return;
    }
    raf = requestFrame(step);
  };

  raf = requestFrame(step);

  return {
    cancel() {
      if (cancelled || finished) return;
      cancelled = true;
      if (raf) cancelFrame(raf);
      raf = 0;
      // 取消时收敛到终值，避免停在中间状态
      onUpdate(to, 1);
      finish();
    },
    get finished() {
      return finished;
    },
  };
}
