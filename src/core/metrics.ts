/**
 * 高频事件计数器（仅用于可观测性，不做业务逻辑）。
 *
 * 阅读器里滚动、尺寸变化、手势移动都是高频源，光「用了节流」无法验证效果，
 * 这里记录「产生了多少次事件」与「实际处理了多少次」，供 getCacheStats 暴露。
 * 计数器是模块级的、极轻量（两次自增），不会影响性能。
 */
export interface ThrottleCounters {
  scrollEvents: number;
  scrollHandled: number;
  sizeEvents: number;
  sizeHandled: number;
  gestureEvents: number;
  gestureHandled: number;
}

const counters: ThrottleCounters = {
  scrollEvents: 0,
  scrollHandled: 0,
  sizeEvents: 0,
  sizeHandled: 0,
  gestureEvents: 0,
  gestureHandled: 0,
};

export type CounterKey = 'scroll' | 'size' | 'gesture';

/** 记录一次「源事件」（未经节流） */
export function countEvent(source: CounterKey): void {
  if (source === 'scroll') counters.scrollEvents += 1;
  else if (source === 'size') counters.sizeEvents += 1;
  else counters.gestureEvents += 1;
}

/** 记录一次「实际处理」（经节流后） */
export function countHandled(source: CounterKey): void {
  if (source === 'scroll') counters.scrollHandled += 1;
  else if (source === 'size') counters.sizeHandled += 1;
  else counters.gestureHandled += 1;
}

export function readCounters(): ThrottleCounters {
  return { ...counters };
}

export function resetCounters(): void {
  counters.scrollEvents = 0;
  counters.scrollHandled = 0;
  counters.sizeEvents = 0;
  counters.sizeHandled = 0;
  counters.gestureEvents = 0;
  counters.gestureHandled = 0;
}
