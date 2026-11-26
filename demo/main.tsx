import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { configurePdfjs, PdfViewer } from 'pdf-h5-react';
import './demo.css';

// 演示站自托管 pdf.js 资源（npm run assets 生成到 public/pdfjs/）。
configurePdfjs({
  workerSrc: '/pdfjs/build/pdf.worker.min.mjs',
  cMapUrl: '/pdfjs/cmaps/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
});

const SAMPLES = [
  { key: 'large', label: '300 页', url: '/samples/large.pdf' },
  { key: 'zh', label: '22 页中文', url: '/samples/demo-zh.pdf' },
] as const;

type SampleKey = (typeof SAMPLES)[number]['key'];

function App() {
  const [sample, setSample] = useState<SampleKey>('large');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('加载中');
  const [maxPixelRatio, setMaxPixelRatio] = useState(2);
  const [fps, setFps] = useState<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const url = SAMPLES.find((s) => s.key === sample)!.url;

  // FPS 采样：滚动流畅度的直观指标
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      frames += 1;
      const now = performance.now();
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 暴露给自动化验证
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__pdfv = {
      page: () => page,
      total: () => total,
      status: () => statusRef.current,
      fps: () => fps,
    };
  }, [page, total, fps]);

  const handleLoad = useCallback((_doc: unknown, n: number) => {
    setTotal(n);
    setStatus(`已加载 ${n} 页`);
  }, []);

  return (
    <div className="demo-app">
      <header className="demo-header">
        <h1 className="demo-title">
          pdf-<span>h5</span>-react
        </h1>
        {SAMPLES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`demo-tab ${sample === s.key ? 'is-active' : ''}`}
            onClick={() => {
              setSample(s.key);
              setPage(1);
              setTotal(0);
              setStatus('加载中');
            }}
          >
            {s.label}
          </button>
        ))}
        <span className="demo-spacer" />
        <label className="demo-field">
          像素比
          <select value={maxPixelRatio} onChange={(e) => setMaxPixelRatio(Number(e.target.value))}>
            <option value={1}>1x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
            <option value={3}>3x</option>
          </select>
        </label>
      </header>

      <main className="demo-stage">
        <PdfViewer
          key={`${sample}-${maxPixelRatio}`}
          src={url}
          gap={8}
          padding={8}
          maxPixelRatio={maxPixelRatio}
          className="demo-viewer"
          onLoad={handleLoad}
          onPageChange={setPage}
          onError={(error) => setStatus(`失败：${error.message}`)}
        />
      </main>

      <footer className="demo-footer">
        <span className="demo-chip">
          第 <strong>{page}</strong> / {total} 页
        </span>
        <span className="demo-chip">{status}</span>
        <span className="demo-chip">
          FPS <strong>{fps ?? '—'}</strong>
        </span>
      </footer>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}