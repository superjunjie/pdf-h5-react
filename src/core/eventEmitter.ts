/**
 * 轻量事件总线。
 *
 * 设计参考 pdfh5 的 `on / off / trigger`：命令式 API 对「非 React 心智」的使用者更自然，
 * 也便于在 ref 上挂载（无需把每个事件都写成一个 prop）。
 * 同时保留 React 的 props 回调：两种风格各自可用，互不干扰。
 *
 * 与 pdfh5 的差异（都是踩过坑之后的选择）：
 * 1. 回调抛错不会中断其它监听者 —— 一个监听器写错不该让整个阅读器的事件链断掉；
 * 2. `off` 支持只移除指定回调（pdfh5 只能按事件名全清，容易误伤）；
 * 3. 提供 `once`，且事件分发时对监听器数组做快照，避免回调里增删监听导致漏发。
 */

export type Listener<T> = (payload: T) => void;

/**
 * 事件表约束。
 *
 * 用 `Record<PropertyKey, unknown>` 而不是 `Record<string, unknown>`：
 * 后者的索引签名隐含「所有 string key 都得有值」，与 `{ destroy: {} }` 这类
 * 具体对象类型不兼容（会报 Type 'X' does not satisfy Record<string, unknown>）。
 */
export class EventEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** 注册监听，返回取消订阅函数 */
  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(type, listener);
  }

  /** 只触发一次 */
  once<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    const wrapper: Listener<Events[K]> = (payload) => {
      this.off(type, wrapper);
      listener(payload);
    };
    return this.on(type, wrapper);
  }

  /**
   * 移除监听。
   * 不传 listener 时清空该事件的全部监听（兼容 pdfh5 的用法）。
   */
  off<K extends keyof Events>(type: K, listener?: Listener<Events[K]>): void {
    if (!listener) {
      this.listeners.delete(type);
      return;
    }
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) this.listeners.delete(type);
  }

  /**
   * 触发事件。
   *
   * 对数组做快照再遍历：回调内部调用 `off` 不会影响本轮分发（否则会漏发后续监听者）。
   * 单个监听器抛错时打印告警并继续 —— 避免一个写错的回调导致别的功能静默失效。
   */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    const snapshot = [...set] as Array<Listener<Events[K]>>;
    for (const listener of snapshot) {
      try {
        listener(payload);
      } catch (error) {
        // 生产环境不应因监听器异常而中断阅读器主流程
        console.error(`[pdf-h5-react] 事件 "${String(type)}" 的监听器抛出异常：`, error);
      }
    }
  }

  /** 某个事件当前的监听数量（调试用） */
  listenerCount(type: keyof Events): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** 清空全部监听（组件卸载时调用） */
  clear(): void {
    this.listeners.clear();
  }
}
