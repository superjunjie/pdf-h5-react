import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';

/**
 * pdf.js 运行时配置。
 *
 * 默认指向与依赖版本严格一致的 CDN 资源，因此零配置即可运行。
 * 生产环境建议自托管（把 pdfjs-dist 的 build/cmaps/standard_fonts/wasm 拷到静态目录），
 * 再调用 configurePdfjs 指向自己的路径，避免依赖第三方 CDN。
 */
export interface PdfjsOptions {
  workerSrc?: string;
  cMapUrl?: string;
  standardFontDataUrl?: string;
  wasmUrl?: string;
  iccUrl?: string;
}

export const PDFJS_VERSION: string = pdfjsLib.version;

const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;

let options: PdfjsOptions = {
  workerSrc: `${CDN}build/pdf.worker.min.mjs`,
  cMapUrl: `${CDN}cmaps/`,
  standardFontDataUrl: `${CDN}standard_fonts/`,
  wasmUrl: `${CDN}wasm/`,
  iccUrl: `${CDN}iccs/`,
};

let workerApplied = false;

function applyWorker(): void {
  if (workerApplied) return;
  if (options.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerSrc;
    workerApplied = true;
  }
}

export function configurePdfjs(next: PdfjsOptions): void {
  const workerChanged = next.workerSrc && next.workerSrc !== options.workerSrc;
  options = { ...options, ...next };
  if (workerChanged) workerApplied = false;
  applyWorker();
}

/** PDF 来源：URL / 二进制 */
export type PdfSource =
  | string
  | URL
  | ArrayBuffer
  | Uint8Array
  | { url?: string | URL; data?: ArrayBuffer | Uint8Array; withCredentials?: boolean };

export interface LoadOptions {
  /** 加载进度回调 */
  onProgress?: (loaded: number, total: number) => void;
}

function isBinary(source: unknown): source is ArrayBuffer | Uint8Array {
  return source instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(source as ArrayBufferView));
}

/**
 * 加载 PDF。
 *
 * 注意：pdf.js 会「转移」TypedArray 的所有权，因此二进制输入必须复制一份，
 * 否则调用方的数据会被置空。
 */
export function loadPdf(
  source: PdfSource,
  loadOptions: LoadOptions = {},
): { task: PDFDocumentLoadingTask; document: Promise<PDFDocumentProxy> } {
  applyWorker();

  const params: Record<string, unknown> = {
    cMapUrl: options.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: options.standardFontDataUrl,
    wasmUrl: options.wasmUrl,
    iccUrl: options.iccUrl,
  };

  if (typeof source === 'string') {
    params.url = source;
  } else if (source instanceof URL) {
    params.url = source.href;
  } else if (isBinary(source)) {
    params.data = source instanceof Uint8Array ? source.slice() : new Uint8Array(source.slice(0));
  } else if (source && typeof source === 'object') {
    if (source.url) params.url = String(source.url);
    if (source.data) {
      params.data = source.data instanceof Uint8Array ? source.data.slice() : source.data.slice(0);
    }
    if (source.withCredentials) params.withCredentials = true;
  }

  const task = pdfjsLib.getDocument(params);

  if (loadOptions.onProgress) {
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      loadOptions.onProgress?.(loaded, total);
    };
  }

  return { task, document: task.promise };
}

export { pdfjsLib };