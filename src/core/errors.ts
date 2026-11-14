export class PdfH5Error extends Error {
  readonly name = 'PdfH5Error';
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly code: 'load' | 'password' | 'render' | 'unknown' = 'unknown',
  ) {
    super(message);
  }
}

/** 渲染任务被主动取消（离开视口 / 缩放变化），不应作为错误上报 */
export class RenderCancelledError extends Error {
  readonly name = 'RenderCancelledError';
  constructor(message = 'render cancelled') {
    super(message);
  }
}

export function isCancelledError(error: unknown): boolean {
  if (error instanceof RenderCancelledError) return true;
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'RenderingCancelledException' || name === 'AbortException' || name === 'RenderCancelledError';
}
