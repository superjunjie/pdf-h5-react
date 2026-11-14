import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { PdfSource } from '../types';

/**
 * pdf.js 的 DocumentInitParameters 在 6.x 里已不再从包根导出，
 * 这里从类型声明的实际路径推导，避免把内部结构写死。
 */
type DocumentInitParameters = Parameters<typeof pdfjsLib.getDocument>[0];

/**
 * pdf.js 运行时配置。
 *
 * 默认使用 jsDelivr CDN 上「与当前依赖版本严格一致」的 worker / cmaps /
 * standard_fonts / wasm，因此库可以零配置直接跑起来。生产环境建议自托管：
 * 运行 `npm run assets`（或手动拷贝 pdfjs-dist 的这几个目录），然后调用
 * `configurePdfjs({ workerSrc: '/pdfjs/pdf.worker.min.mjs', ... })`。
 */
export const PDFJS_VERSION: string = pdfjsLib.version;

const CDN_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;

export interface PdfjsRuntimeOptions {
  workerSrc?: string;
  cMapUrl?: string;
  standardFontDataUrl?: string;
  wasmUrl?: string;
  iccUrl?: string;
  /** 0 = errors, 1 = warnings, 5 = infos（pdf.js VerbosityLevel） */
  verbosity?: number;
}

let runtimeOptions: PdfjsRuntimeOptions = {
  workerSrc: `${CDN_BASE}build/pdf.worker.min.mjs`,
  cMapUrl: `${CDN_BASE}cmaps/`,
  standardFontDataUrl: `${CDN_BASE}standard_fonts/`,
  wasmUrl: `${CDN_BASE}wasm/`,
  iccUrl: `${CDN_BASE}iccs/`,
};

let workerConfigured = false;

function applyWorker() {
  if (workerConfigured) return;
  const src = runtimeOptions.workerSrc;
  if (src) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = src;
    workerConfigured = true;
  }
}

/** 覆盖 pdf.js 的静态资源地址（worker / cmaps / 字体 / wasm） */
export function configurePdfjs(options: PdfjsRuntimeOptions): void {
  runtimeOptions = { ...runtimeOptions, ...options };
  if (options.workerSrc && options.workerSrc !== pdfjsLib.GlobalWorkerOptions.workerSrc) {
    workerConfigured = false;
  }
  applyWorker();
}

export function getPdfjsRuntimeOptions(): Readonly<PdfjsRuntimeOptions> {
  return runtimeOptions;
}

export { pdfjsLib };

function isBinary(source: unknown): source is ArrayBuffer | Uint8Array {
  return (
    source instanceof ArrayBuffer ||
    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(source as ArrayBufferView)) ||
    (typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer)
  );
}

/** 把各种 PdfSource 归一化成 pdf.js 的 DocumentInitParameters */
export function toDocumentParams(source: PdfSource, extra?: Record<string, unknown>): DocumentInitParameters {
  const params: Record<string, unknown> = {};

  if (typeof source === 'string') {
    params.url = source;
  } else if (source instanceof URL) {
    params.url = source.href;
  } else if (isBinary(source)) {
    // pdf.js 会「转移」TypedArray 的所有权，这里必须复制，否则调用方数据会被置空
    const copy = source instanceof Uint8Array ? source.slice() : new Uint8Array(source.slice(0));
    params.data = copy;
  } else if (source && typeof source === 'object') {
    if (source.url) params.url = String(source.url);
    if (source.data) {
      params.data = source.data instanceof Uint8Array ? source.data.slice() : source.data.slice(0);
    }
    if (source.httpHeaders) params.httpHeaders = source.httpHeaders;
    if (source.withCredentials) params.withCredentials = source.withCredentials;
    if (source.password) params.password = source.password;
    if (source.range) params.range = source.range;
  }

  applyWorker();

  return {
    cMapUrl: runtimeOptions.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: runtimeOptions.standardFontDataUrl,
    wasmUrl: runtimeOptions.wasmUrl,
    iccUrl: runtimeOptions.iccUrl,
    ...(runtimeOptions.verbosity != null ? { verbosity: runtimeOptions.verbosity } : null),
    ...params,
    ...extra,
  } as DocumentInitParameters;
}

export interface LoadPdfOptions {
  password?: string;
  onProgress?: (loaded: number, total: number) => void;
  onPassword?: (reason: number) => void;
  /** 允许 pdf.js 在解析出错时尽量恢复，默认 true */
  stopAtErrors?: boolean;
  /** 关闭 worker 端 OffscreenCanvas（部分老安卓内核更稳） */
  disableOffscreenCanvas?: boolean;
}

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
}

/**
 * 加载 PDF。注意：调用方负责在卸载时销毁返回值里的 task。
 */
export function loadPdf(source: PdfSource, options: LoadPdfOptions = {}): LoadedPdf {
  const task = pdfjsLib.getDocument(
    toDocumentParams(source, {
      ...(options.password ? { password: options.password } : null),
      ...(options.stopAtErrors != null ? { stopAtErrors: options.stopAtErrors } : null),
      ...(options.disableOffscreenCanvas ? { isOffscreenCanvasSupported: false } : null),
    }),
  );

  if (options.onProgress) {
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      options.onProgress!(loaded, total);
    };
  }
  if (options.onPassword) {
    task.onPassword = (_updatePassword: (pw: string) => void, reason: number) => {
      options.onPassword!(reason);
    };
  }

  return { doc: null as unknown as PDFDocumentProxy, task };
}

/** 便捷方法：等待加载完成并返回文档代理 */
export async function loadPdfDocument(source: PdfSource, options: LoadPdfOptions = {}): Promise<PDFDocumentProxy> {
  const { task } = loadPdf(source, options);
  return task.promise;
}
