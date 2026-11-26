/**
 * 极简版端到端验证：只验证「分页渲染」这一件事是否正确。
 *
 * 重点是画布尺寸不变式 —— 之前的「文字被截断」就是这里算错导致的：
 *   渲染内容宽（PDF 宽 × viewportScale）必须等于画布像素宽。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const PORT = process.env.PORT ?? '5278';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? '  -- ' + detail : ''}`);
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__pdfv && window.__pdfv.total() > 0', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

// 1. 加载与页数
const info = await page.evaluate(() => ({
  total: window.__pdfv.total(),
  status: window.__pdfv.status(),
  pages: document.querySelectorAll('.pdfv-page').length,
}));
check('文档加载成功', info.total === 300, `${info.total} 页 / ${info.status}`);
check('页面占位全部创建', info.pages === 300, `${info.pages} 个 .pdfv-page`);

// 2. 只渲染可见页（按需渲染生效）
const painted = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.pdfv-page')];
  const withCanvas = all.filter((p) => p.querySelector('canvas')).length;
  return { withCanvas, total: all.length };
});
check(
  '按需渲染：只绘制少量页面',
  painted.withCanvas > 0 && painted.withCanvas < 12,
  `${painted.withCanvas} / ${painted.total} 页有 canvas`,
);

// 3. 画布尺寸不变式（防文字截断的关键）
const canvasCheck = await page.evaluate(() => {
  const out = [];
  for (const pageEl of document.querySelectorAll('.pdfv-page')) {
    const canvas = pageEl.querySelector('canvas');
    if (!canvas) continue;
    const rect = pageEl.getBoundingClientRect();
    out.push({
      page: pageEl.dataset.page,
      cssW: Math.round(rect.width),
      cssH: Math.round(rect.height),
      pxW: canvas.width,
      pxH: canvas.height,
      // 画布像素比：应接近 DPR（示例里设为 2）
      ratioW: +(canvas.width / rect.width).toFixed(2),
      // 画布自身宽高比 vs 页面宽高比
      canvasAspect: +(canvas.width / canvas.height).toFixed(4),
      pageAspect: +(rect.width / rect.height).toFixed(4),
    });
  }
  return out;
});
const aspectOk = canvasCheck.every((c) => Math.abs(c.canvasAspect - c.pageAspect) / c.pageAspect < 0.01);
check(
  '画布宽高比与页面一致（无截断）',
  aspectOk && canvasCheck.length > 0,
  canvasCheck.map((c) => `${c.page}:${c.canvasAspect}/${c.pageAspect}`).slice(0, 3).join(' '),
);
const ratioOk = canvasCheck.every((c) => c.ratioW >= 1.9 && c.ratioW <= 2.1);
check('画布像素比 ≈ DPR 2', ratioOk, canvasCheck.map((c) => `${c.page}:${c.ratioW}`).slice(0, 4).join(' '));

// 4. 画布确实画了内容（不是空白）
const inked = await page.evaluate(() => {
  const canvas = document.querySelector('.pdfv-page canvas');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const w = Math.min(canvas.width, 300);
  const h = Math.min(canvas.height, 300);
  const data = ctx.getImageData(0, 0, w, h).data;
  let nonWhite = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite += 1;
  }
  return { ratio: +(nonWhite / (data.length / 4)).toFixed(4) };
});
check('画布有实际内容', (inked?.ratio ?? 0) > 0.001, `非白像素占比 ${((inked?.ratio ?? 0) * 100).toFixed(2)}%`);

// 5. 滚动后页码更新，且无空白页
const scrollCheck = await page.evaluate(async () => {
  const root = document.querySelector('.pdfv-root');
  for (let i = 0; i < 20; i += 1) {
    root.scrollTop += root.clientHeight * 1.2;
    await new Promise((r) => requestAnimationFrame(r));
  }
  await new Promise((r) => setTimeout(r, 2000));
  const pages = [...document.querySelectorAll('.pdfv-page')];
  const withCanvas = pages.filter((p) => p.querySelector('canvas')).length;
  return { page: window.__pdfv.page(), withCanvas };
});
check('滚动后当前页更新', scrollCheck.page > 5, `第 ${scrollCheck.page} 页`);
check('滚动后仍只绘制少量页', scrollCheck.withCanvas > 0 && scrollCheck.withCanvas < 14, `${scrollCheck.withCanvas} 页`);

// 6. 无横向溢出（页面居中，不超出视口）
const overflow = await page.evaluate(() => {
  const root = document.querySelector('.pdfv-root');
  return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
});
check('无横向滚动条', overflow.scrollWidth <= overflow.clientWidth + 1, `${overflow.scrollWidth} / ${overflow.clientWidth}`);

// 7. 无运行时错误
const realErrors = errors.filter((t) => !/favicon|DevTools|preload|deprecated/i.test(t));
check('无运行时错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || '无');

await page.evaluate(() => {
  const root = document.querySelector('.pdfv-root');
  root.scrollTop = 0;
});
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: 'debug-simple.png' });

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== ${passed}/${results.length} 通过 ===`);
await browser.close();
if (passed !== results.length) process.exitCode = 1;