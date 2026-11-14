import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { configurePdfjs, PdfH5Reader, type PdfH5ReaderHandle, type ThemeMode, type ViewerMode } from '@superjunjie/pdf-h5-react';
import './demo.css';

// 演示站自托管 pdf.js 资源（npm run assets 生成到 public/pdfjs/）。
// 库默认走 jsDelivr CDN；这里覆盖成同源地址，离线 / 内网也能跑。
configurePdfjs({
  workerSrc: '/pdfjs/build/pdf.worker.min.mjs',
  cMapUrl: '/pdfjs/cmaps/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
});

type SampleKey = 'zh' | 'large' | 'encrypted';

const SAMPLES: Array<{ key: SampleKey; label: string; url: string; hint: string }> = [
  { key: 'zh', label: '中文演示 (22 页)', url: '/samples/demo-zh.pdf', hint: '含多级目录 / 内外链 / 横向页 / 旋转页 / 矢量图' },
  { key: 'large', label: '大文档 (300 页)', url: '/samples/large.pdf', hint: '验证懒加载与 LRU 缓存' },
  { key: 'encrypted', label: '加密文档', url: '/samples/encrypted.pdf', hint: '打开密码：test' },
];

function App() {
  const readerRef = useRef<PdfH5ReaderHandle | null>(null);
  const [sample, setSample] = useState<SampleKey>('zh');
  const [mode, setMode] = useState<ViewerMode>('scroll');
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [phone, setPhone] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>('加载中');
  const [fps, setFps] = useState<number | null>(null);

  const source = useMemo(() => SAMPLES.find((item) => item.key === sample)!.url, [sample]);

  // FPS 采样：验证滚动 / 缩放是否掉帧（真实设备上最直观的指标）
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

  // 暴露给自动化验证脚本
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__pdfh5 = {
      reader: () => readerRef.current,
      stats: () => readerRef.current?.getCacheStats(),
      goTo: (n: number) => readerRef.current?.goToPage(n),
      search: (q: string) => readerRef.current?.search(q),
      zoom: (z: number) => readerRef.current?.setZoom(z),
      page: () => readerRef.current?.getCurrentPage(),
      status: () => status,
      fps: () => fps,
    };
  }, [status, fps]);

  const onDocumentLoad = useCallback((doc: { numPages: number }) => {
    setTotal(doc.numPages);
    setStatus(`已加载 · ${doc.numPages} 页`);
  }, []);

  const onPageChange = useCallback((next: number) => setPage(next), []);

  return (
    <div className="demo-app">
      <header className="demo-header">
        <h1 className="demo-title">
          pdf-<span>h5</span>-react
        </h1>
        <div className="demo-tabs">
          {SAMPLES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`demo-tab ${sample === item.key ? 'is-active' : ''}`}
              onClick={() => {
                setSample(item.key);
                setPage(1);
                setStatus('加载中');
              }}
              title={item.hint}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="demo-spacer" />
        <div className="demo-tabs">
          <button
            type="button"
            className={`demo-tab ${mode === 'scroll' ? 'is-active' : ''}`}
            onClick={() => setMode('scroll')}
          >
            连续滚动
          </button>
          <button
            type="button"
            className={`demo-tab ${mode === 'page' ? 'is-active' : ''}`}
            onClick={() => setMode('page')}
          >
            翻页
          </button>
          <button
            type="button"
            className={`demo-tab ${theme === 'dark' ? 'is-active' : ''}`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '深色' : '浅色'}
          </button>
          <button
            type="button"
            className={`demo-tab ${phone ? 'is-active' : ''}`}
            onClick={() => setPhone(!phone)}
          >
            手机框
          </button>
        </div>
      </header>

      <main className={`demo-stage ${phone ? 'is-phone' : ''}`}>
        <div className={phone ? 'demo-phone' : 'demo-full'}>
          <PdfH5Reader
            key={`${sample}-${mode}`}
            ref={readerRef}
            src={source}
            mode={mode}
            fitMode={mode === 'page' ? 'page' : 'width'}
            theme={theme}
            initialPage={1}
            onDocumentLoad={onDocumentLoad}
            onPageChange={onPageChange}
            onError={(error) => setStatus(`失败：${error.message}`)}
            onExternalLink={(url) => window.open(url, '_blank', 'noopener')}
          />
        </div>
      </main>

      <footer className="demo-footer">
        <span className="demo-chip">
          第 <strong>{page}</strong> / {total} 页
        </span>
        <span className="demo-chip">{status}</span>
        <span className="demo-chip">
          FPS <strong>{fps ?? '—'}</strong>
        </span>
        <span className="demo-chip">{mode === 'page' ? '翻页模式' : '连续模式'}</span>
      </footer>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
