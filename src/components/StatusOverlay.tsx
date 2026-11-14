import { useEffect, useState } from 'react';

export interface StatusOverlayProps {
  loading: boolean;
  needPassword: boolean;
  passwordReason: number;
  error: Error | null;
  progress: { loaded: number; total: number } | null;
  onSubmitPassword(password: string): void;
  onCancelPassword(): void;
  renderError?: (error: Error, retry: () => void) => React.ReactNode;
}

/** 加载 / 密码 / 错误三态覆盖层 */
export function StatusOverlay({
  loading,
  needPassword,
  passwordReason,
  error,
  progress,
  onSubmitPassword,
  onCancelPassword,
  renderError,
}: StatusOverlayProps) {
  const [password, setPassword] = useState('');

  useEffect(() => {
    setPassword('');
  }, [needPassword, passwordReason]);

  if (needPassword) {
    return (
      <div className="pdfh5-status" role="dialog" aria-label="需要密码">
        <form
          className="pdfh5-password"
          onSubmit={(event) => {
            event.preventDefault();
            if (password) onSubmitPassword(password);
          }}
        >
          <h2>{passwordReason === 2 ? '密码错误，请重试' : '该文档需要密码'}</h2>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入打开密码"
            autoFocus
            inputMode="text"
            enterKeyHint="done"
          />
          <div className="pdfh5-password-actions">
            <button type="button" className="pdfh5-btn pdfh5-btn-ghost" onClick={onCancelPassword}>
              取消
            </button>
            <button type="submit" className="pdfh5-btn pdfh5-btn-primary" disabled={!password}>
              打开
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (error) {
    if (renderError) return <>{renderError(error, () => window.location.reload())}</>;
    return (
      <div className="pdfh5-status" role="alert">
        <p className="pdfh5-status-title">文档加载失败</p>
        <p className="pdfh5-status-detail">{error.message}</p>
        <button type="button" className="pdfh5-btn pdfh5-btn-primary" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }

  if (loading) {
    const ratio = progress && progress.total > 0 ? progress.loaded / progress.total : null;
    return (
      <div className="pdfh5-status" role="status" aria-live="polite">
        <div className="pdfh5-spinner" />
        <p className="pdfh5-status-title">正在加载文档…</p>
        {ratio !== null ? (
          <div className="pdfh5-progress" aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
          </div>
        ) : null}
      </div>
    );
  }

  return null;
}
