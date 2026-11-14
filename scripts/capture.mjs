import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });

// 等「所有可见页都已绘制」再截图，避免拍到半成品
async function capture(page, file) {
  await page.waitForFunction(
    `(() => {
      const pages = [...document.querySelectorAll('.pdfh5-page')];
      if (pages.length === 0) return false;
      return pages.every((el) => {
        const holder = el.querySelector('.pdfh5-canvas');
        const visible = el.dataset.visible === 'true';
        return !visible || holder?.getAttribute('data-painted') === '1';
      });
    })()`,
    { timeout: 30000 },
  );
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: file });
}

const shots = [
  { name: 'final-desktop-zh.png', vp: { width: 1280, height: 900, deviceScaleFactor: 1 }, sample: null, scroll: 0 },
  { name: 'final-mobile-zh.png', vp: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, sample: null, scroll: 0 },
  { name: 'final-mobile-zh-page3.png', vp: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, sample: null, scroll: 2.0 },
  { name: 'final-mobile-large.png', vp: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, sample: '大文档', scroll: 0 },
  { name: 'final-mobile-large-mid.png', vp: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, sample: '大文档', scroll: 12 },
];

for (const shot of shots) {
  const page = await browser.newPage();
  await page.setViewport(shot.vp);
  await page.goto('http://127.0.0.1:5274/', { waitUntil: 'networkidle2' });
  await page.waitForFunction('window.__pdfh5?.page() > 0');
  if (shot.sample) {
    await page.evaluate((t) => {
      [...document.querySelectorAll('.demo-tab')].find((b) => b.textContent.includes(t))?.click();
    }, shot.sample);
    await new Promise((r) => setTimeout(r, 2500));
    await page.waitForFunction('window.__pdfh5.status().indexOf("已加载") >= 0', { timeout: 60000 });
  }
  if (shot.scroll > 0) {
    await page.evaluate(async (count) => {
      const s = document.querySelector('.pdfh5-viewport');
      for (let i = 0; i < count; i += 1) {
        s.scrollTop += s.clientHeight * 1.02;
        await new Promise((r) => setTimeout(r, 260));
      }
    }, shot.scroll);
  }
  await capture(page, `screenshots/${shot.name}`);
  const n = await page.evaluate(() => document.querySelector('.pdfh5-hud-page')?.textContent ?? '');
  console.log(`✓ ${shot.name}  (${n})`);
  await page.close();
}

await browser.close();
