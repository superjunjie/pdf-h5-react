import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RenderQueue } from '../core/renderQueue';
import { RenderCancelledError } from '../core/errors';

export interface ThumbnailResult {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * 生成缩略图。
 *
 * 用低分辨率（默认 120px 宽）+ JPEG 压缩，单张约 3-8KB，
 * 100 页的缩略图总占用可以控制在 1MB 以内 —— 因此可以放心缓存成 dataURL。
 */
export async function createThumbnailCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number,
  options: { targetWidth?: number; rotation?: number; quality?: number } = {},
  queue?: RenderQueue,
): Promise<ThumbnailResult> {
  const targetWidth = options.targetWidth ?? 120;
  const rotation = options.rotation ?? 0;
  const quality = options.quality ?? 0.72;

  const render = async (signal?: AbortSignal) => {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1, rotation: page.rotate + rotation });
    const scale = targetWidth / base.width;
    const viewport = page.getViewport({ scale, rotation: page.rotate + rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 2D 上下文');

    if (signal?.aborted) throw new RenderCancelledError();
    const task = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
    const onAbort = () => task.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await task.promise;
    } catch (error) {
      if (signal?.aborted) throw new RenderCancelledError();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    // 及时释放位图内存
    canvas.width = 0;
    canvas.height = 0;
    return { dataUrl, width: Math.round(viewport.width), height: Math.round(viewport.height) };
  };

  if (!queue) return render();
  return queue.enqueue(`thumb:${pageNumber}@${targetWidth}`, 'prefetch', (signal) => render(signal));
}
