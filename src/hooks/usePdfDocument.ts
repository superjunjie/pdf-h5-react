import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import { loadPdf } from '../core/pdfjs';
import type { PdfSource } from '../types';
import { throttle } from '../core/throttle';

export interface PdfDocumentState {
  doc: PDFDocumentProxy | null;
  numPages: number;
  loading: boolean;
  progress: { loaded: number; total: number } | null;
  error: Error | null;
  /** 需要密码时为 true */
  needPassword: boolean;
  /** pdf.js PasswordResponses：1 = NEED_PASSWORD，2 = INCORRECT_PASSWORD */
  passwordReason: number;
  submitPassword(password: string): void;
  cancelPassword(): void;
}

/** 把 source 归一化为可比较的 key，避免同一份数据反复触发重载 */
function sourceKeyOf(source: PdfSource): string {
  if (typeof source === 'string') return `url:${source}`;
  if (source instanceof URL) return `url:${source.href}`;
  if (source instanceof ArrayBuffer) return `bin:${source.byteLength}:${source.slice(0, 32).toString()}`;
  if (ArrayBuffer.isView(source)) return `bin:${source.byteLength}:${source.buffer.slice(0, 32).toString()}`;
  if (source && typeof source === 'object') {
    if (source.url) return `url:${String(source.url)}`;
    if (source.data) return `bin:${(source.data as ArrayBuffer).byteLength ?? 0}`;
  }
  return 'unknown';
}

export function usePdfDocument(source: PdfSource | null | undefined, enabled = true): PdfDocumentState {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(Boolean(source) && enabled);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [passwordReason, setPasswordReason] = useState(0);

  const passwordUpdater = useRef<((password: string) => void) | null>(null);
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const key = useMemo(() => (source ? sourceKeyOf(source) : ''), [source]);

  useEffect(() => {
    if (!source || !enabled || !key) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    setProgress(null);
    setNeedPassword(false);

    // 加载进度是高频事件，节流后再进入 React
    const pushProgress = throttle((loaded: number, total: number) => {
      if (!cancelled) setProgress({ loaded, total });
    }, 120);

    const { task } = loadPdf(source, {
      onProgress: (loaded, total) => pushProgress(loaded, total),
    });
    taskRef.current = task;

    task.onPassword = (updatePassword: (pw: string) => void, reason: number) => {
      if (cancelled) return;
      passwordUpdater.current = updatePassword;
      setPasswordReason(reason);
      setNeedPassword(true);
      setLoading(true);
    };

    task.promise
      .then((loaded) => {
        if (cancelled) return;
        setDoc(loaded);
        setLoading(false);
        setNeedPassword(false);
        setProgress(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = (err as { name?: string }).name;
        if (code === 'PasswordException') {
          // onPassword 已经接管，这里不再当作错误
          return;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      pushProgress.cancel();
      passwordUpdater.current = null;
      // destroy 会中止网络请求并回收 worker 侧资源
      task.destroy().catch(() => {});
      if (taskRef.current === task) taskRef.current = null;
    };
  }, [source, key, enabled]);

  const submitPassword = useCallback((password: string) => {
    const update = passwordUpdater.current;
    if (!update) return;
    passwordUpdater.current = null;
    setNeedPassword(false);
    update(password);
  }, []);

  const cancelPassword = useCallback(() => {
    setNeedPassword(false);
    setLoading(false);
    setError(new Error('已取消输入密码'));
  }, []);

  return {
    doc,
    numPages: doc?.numPages ?? 0,
    loading,
    progress,
    error,
    needPassword,
    passwordReason,
    submitPassword,
    cancelPassword,
  };
}
