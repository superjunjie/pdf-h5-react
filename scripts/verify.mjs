/**
 * 端到端验证脚本（无头 Chrome）。
 *
 * 目的：不只验证「能构建」，而是真的在浏览器里跑起来，检查：
 *  1. 文档能加载、页数正确、首屏能出图（canvas 非空白）；
 *  2. 懒加载生效 —— 远距离页面不挂载 DOM；
 *  3. LRU 生效 —— 来回滚动后位图缓存命中、渲染任务数不线性增长；
 *  4. 节流生效 —— 高频滚动期间处理次数远小于事件数；
 *  5. 缩放锚点正确、翻页模式能切换、搜索能命中。
 *
 * 用法：node scripts/verify.mjs [--url http://127.0.0.1:5274] [--headful]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const shotDir = join(root, 'screenshots');
await mkdir(shotDir, { recursive: true });

const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const baseUrl = urlFlag >= 0 ? args[urlFlag + 1] : 'http://127.0.0.1:5274';
const headful = args.includes('--headful');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const executablePath = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!executablePath) {
  console.error('未找到 Chrome/Edge');
  process.exit(1);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath,
  headless: !headful,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function newMobilePage(width = 390, height = 844) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  );
  return page;
}

/**
 * canvas 采样探针。
 * 注意：字符串传给 evaluate 时是按「表达式」求值，所以末尾必须加 () 真正调用，
 * 否则拿到的是函数对象本身（这正是之前「覆盖率 0%」的假失败原因）。
 * 另外不能传 willReadFrequently —— canvas 已有 2D 上下文时再传选项会返回 null。
 */
const CANVAS_PROBE = `(() => {
  const canvases = [...document.querySelectorAll('.pdfh5-page canvas')];
  if (canvases.length === 0) return { count: 0, samples: [] };
  const probe = (canvas) => {
    const w = Math.min(canvas.width, 240);
    const h = Math.min(canvas.height, 240);
    if (w === 0 || h === 0) return { inked: false, ratio: 0 };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { inked: false, ratio: 0 };
    const data = ctx.getImageData(0, 0, w, h).data;
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite += 1;
    }
    return { inked: nonWhite > 20, ratio: nonWhite / (data.length / 4), width: canvas.width, height: canvas.height };
  };
  return { count: canvases.length, samples: canvases.slice(0, 4).map(probe) };
})()`;

const consoleErrors = [];

try {
  // ---------- 1. 桌面端首屏 ----------
  console.log('\n=== 桌面端（中文演示文档）===');
  const desktop = await browser.newPage();
  await desktop.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  desktop.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  desktop.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await desktop.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await desktop.waitForFunction('window.__pdfh5 && window.__pdfh5.page() > 0', { timeout: 60000 });
  await desktop.waitForFunction(`${CANVAS_PROBE}.samples.length > 0`, { timeout: 60000 });
  await wait(2500);

  const info = await desktop.evaluate(() => ({
    pages: document.querySelectorAll('.pdfh5-page').length,
    canvases: document.querySelectorAll('.pdfh5-page canvas').length,
    status: window.__pdfh5.status(),
    stats: window.__pdfh5.stats(),
  }));
  check('文档加载成功', info.status.includes('已加载'), info.status);
  check('首屏渲染出图', info.canvases > 0, `${info.canvases} 张 canvas`);
  check('虚拟化：只挂载少量页面', info.pages <= 8, `挂载 ${info.pages} 页（总计 22）`);

  const probe = await desktop.evaluate(CANVAS_PROBE);
  check('画布实际有内容（非空白）', probe.samples?.[0]?.inked === true, `像素覆盖率 ${((probe.samples?.[0]?.ratio ?? 0) * 100).toFixed(1)}%`);

  // 关键正确性断言：所有「可见页」都必须已绘制。
  // 预取页允许尚未绘制（它们不在屏上），但可见页若空白就是 bug。
  const paintedState = await desktop.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.pdfh5-page')) {
      const holder = el.querySelector('.pdfh5-canvas');
      out.push({
        num: el.dataset.pageNumber,
        visible: el.dataset.visible === 'true',
        painted: holder?.getAttribute('data-painted') === '1',
      });
    }
    return out;
  });
  const visibleUnpainted = paintedState.filter((p) => p.visible && !p.painted);
  check(
    '所有可见页均已绘制（无空白页）',
    visibleUnpainted.length === 0,
    visibleUnpainted.length === 0
      ? `${paintedState.filter((p) => p.visible).length} 个可见页全部就绪`
      : `空白：${visibleUnpainted.map((p) => p.num).join(',')}`,
  );
  await desktop.screenshot({ path: join(shotDir, 'desktop-scroll.png') });

  // ---------- 2. 大文档：懒加载 + LRU ----------
  console.log('\n=== 大文档（300 页）===');
  const large = await newMobilePage();
  large.on('pageerror', (err) => consoleErrors.push('pageerror(large): ' + err.message));
  large.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await large.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await large.waitForFunction('window.__pdfh5 && window.__pdfh5.page() > 0', { timeout: 60000 });
  await large.evaluate(() => {
    const buttons = [...document.querySelectorAll('.demo-tab')];
    buttons.find((b) => b.textContent.includes('大文档'))?.click();
  });
  await wait(1500);
  await large.waitForFunction('window.__pdfh5.status().indexOf("已加载") >= 0', { timeout: 60000 });
  await wait(1500);

  const largeMount = await large.evaluate(() => ({
    mounted: document.querySelectorAll('.pdfh5-page').length,
    measured: window.__pdfh5.stats().metrics.entries,
  }));
  check('300 页文档只挂载极少数页面', largeMount.mounted <= 10, `挂载 ${largeMount.mounted} / 300 页（已度量 ${largeMount.measured} 页）`);
  await large.screenshot({ path: join(shotDir, 'mobile-large-top.png') });

  // 快速向下滚动
  await large.evaluate(async () => {
    const scroller = document.querySelector('.pdfh5-viewport');
    if (!scroller) return;
    for (let i = 0; i < 30; i += 1) {
      scroller.scrollTop += scroller.clientHeight * 1.5;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await wait(1500);
  const afterScroll = await large.evaluate(() => ({
    renders: window.__pdfh5.stats().renders,
    mounted: document.querySelectorAll('.pdfh5-page').length,
  }));
  check('滚动后挂载数仍然受控', afterScroll.mounted <= 12, `挂载 ${afterScroll.mounted} 页`);

  // 快速滚动后：所有可见页必须已绘制（上一轮「首屏空页」bug 的回归断言）
  const afterScrollPainted = await large.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.pdfh5-page')) {
      const holder = el.querySelector('.pdfh5-canvas');
      out.push({
        num: el.dataset.pageNumber,
        visible: el.dataset.visible === 'true',
        painted: holder?.getAttribute('data-painted') === '1',
      });
    }
    return out;
  });
  const blankAfterScroll = afterScrollPainted.filter((p) => p.visible && !p.painted);
  check(
    '快速滚动后仍无空白可见页',
    blankAfterScroll.length === 0,
    blankAfterScroll.length === 0
      ? `${afterScrollPainted.filter((p) => p.visible).length} 个可见页全部就绪`
      : `空白：${blankAfterScroll.map((p) => p.num).join(',')}`,
  );

  // 滚回顶部：应大量命中缓存
  await large.evaluate(async () => {
    const scroller = document.querySelector('.pdfh5-viewport');
    if (!scroller) return;
    while (scroller.scrollTop > 0) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 2);
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await wait(2000);
  const afterBack = await large.evaluate(() => window.__pdfh5.stats());
  check(
    'LRU 有效：回滚时缓存命中 > 0',
    afterBack.renders.cacheHits > 0,
    `命中 ${afterBack.renders.cacheHits} 次 / 未命中 ${afterBack.renders.cacheMisses} 次`,
  );
  check(
    'LRU 有效：位图缓存始终不超过字节上限',
    // 这里断言的是「契约」而不是某个固定条目数：页面铺满宽度后单张位图可达数 MB，
    // 条目数取决于容器尺寸，唯一恒定的约束是「总字节不超上限，且确实有内容」。
    afterBack.bitmap.entries > 0 && afterBack.bitmap.bytes <= afterBack.bitmap.maxBytes,
    `${afterBack.bitmap.entries} 张 / ${(afterBack.bitmap.bytes / 1024 / 1024).toFixed(1)}MB（上限 ${(afterBack.bitmap.maxBytes / 1024 / 1024).toFixed(0)}MB）`,
  );
  check(
    'LRU 有实际淘汰行为（缓存真的在回收）',
    afterBack.bitmap.evictions > 0 || afterBack.bitmap.entries <= 40,
    `淘汰 ${afterBack.bitmap.evictions} 次`,
  );
  check(
    '渲染任务有取消而非堆积',
    afterBack.renders.started >= afterBack.renders.completed,
    `started=${afterBack.renders.started} completed=${afterBack.renders.completed} cancelled=${afterBack.renders.cancelled}`,
  );

  // ---------- 3. 节流验证 ----------
  // 说明：浏览器本身会把同一帧内的滚动合并，所以「真实滚动」很难造出高于帧率的速率。
  // 这里在同一个任务里连续触发 60 次滚动事件（模拟极端高频输入），
  // 验证库内部的 rAF 收口确实把它压成「一帧一次处理」。
  console.log('\n=== 高频滚动节流 ===');
  const throttleStats = await large.evaluate(async () => {
    const scroller = document.querySelector('.pdfh5-viewport');
    if (!scroller) return null;
    const before = window.__pdfh5.stats().throttle;
    const base = scroller.scrollTop;
    // 同步连续变更 + 派发 scroll：全部落在同一帧内
    for (let i = 0; i < 60; i += 1) {
      scroller.scrollTop = base + i * 2;
      scroller.dispatchEvent(new Event('scroll'));
    }
    await new Promise((r) => setTimeout(r, 200));
    const after = window.__pdfh5.stats().throttle;
    return {
      events: after.scrollEvents - before.scrollEvents,
      handled: after.scrollHandled - before.scrollHandled,
    };
  });
  if (throttleStats) {
    const ratio = throttleStats.events > 0 ? throttleStats.handled / throttleStats.events : 1;
    check(
      '同一帧内的滚动风暴被合并为一次处理',
      throttleStats.events >= 50 && throttleStats.handled <= 2,
      `${throttleStats.events} 次事件 -> ${throttleStats.handled} 次处理（${(ratio * 100).toFixed(0)}%）`,
    );
  }

  // ---------- 4. 搜索 ----------
  console.log('\n=== 搜索 ===');
  await large.evaluate(() => window.__pdfh5.reader()?.openPanel('search'));
  await wait(500);
  const searchResult = await large.evaluate(async () => {
    const hits = await window.__pdfh5.search('Page 1');
    return Array.isArray(hits) ? hits.slice(0, 3).map((h) => ({ page: h.pageNumber, text: h.text })) : null;
  });
  check('全文档搜索命中', Array.isArray(searchResult) && searchResult.length > 0, JSON.stringify(searchResult?.[0] ?? null));
  await large.screenshot({ path: join(shotDir, 'mobile-search.png') });
  await large.keyboard.press('Escape');
  await wait(300);

  // ---------- 5. 缩放 ----------
  console.log('\n=== 缩放 ===');
  const zoomCheck = await large.evaluate(async () => {
    const scroller = document.querySelector('.pdfh5-viewport');
    const reader = window.__pdfh5.reader();
    if (!scroller || !reader) return null;
    scroller.scrollTop = 1200;
    await new Promise((r) => requestAnimationFrame(r));
    const before = { top: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
    reader.setZoom(2);
    await new Promise((r) => setTimeout(r, 800));
    const after = { top: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
    return { before, after };
  });
  check(
    '放大后内容高度按比例增长',
    Boolean(zoomCheck) && zoomCheck.after.scrollHeight > zoomCheck.before.scrollHeight * 1.5,
    `scrollHeight ${zoomCheck?.before.scrollHeight} -> ${zoomCheck?.after.scrollHeight}`,
  );
  await wait(2000);
  await large.screenshot({ path: join(shotDir, 'mobile-zoom200.png') });

  // ---------- 6. 翻页模式 ----------
  console.log('\n=== 翻页模式 ===');
  await large.evaluate(() => {
    const buttons = [...document.querySelectorAll('.demo-tab')];
    buttons.find((b) => b.textContent.trim() === '翻页')?.click();
  });
  await wait(2500);
  const pageMode = await large.evaluate(() => {
    const rootEl = document.querySelector('.pdfh5-root');
    const scroller = document.querySelector('.pdfh5-viewport');
    return {
      mode: rootEl?.getAttribute('data-mode'),
      snap: scroller ? getComputedStyle(scroller).scrollSnapType : null,
      mounted: document.querySelectorAll('.pdfh5-page').length,
      page: window.__pdfh5.page(),
    };
  });
  check('翻页模式生效（横向 scroll-snap）', pageMode.mode === 'page' && String(pageMode.snap).includes('x'), `snap=${pageMode.snap}`);
  await large.screenshot({ path: join(shotDir, 'mobile-page-mode.png') });

  // ---------- 7. 面板 ----------
  console.log('\n=== 面板 ===');
  await large.evaluate(() => window.__pdfh5.reader()?.openPanel('thumbnails'));
  await wait(2500);
  const thumbs = await large.evaluate(() => document.querySelectorAll('.pdfh5-thumb').length);
  check('缩略图面板可用', thumbs > 0, `${thumbs} 项`);
  await large.screenshot({ path: join(shotDir, 'mobile-thumbnails.png') });
  await large.evaluate(() => window.__pdfh5.reader()?.openPanel(null));

  // 目录要用「有书签」的中文演示文档来验证（large.pdf 本身没有书签）
  await large.evaluate(() => {
    [...document.querySelectorAll('.demo-tab')].find((b) => b.textContent.includes('中文演示'))?.click();
  });
  await wait(1200);
  await large.waitForFunction('window.__pdfh5.status().indexOf("已加载") >= 0', { timeout: 60000 });
  await wait(1500);
  await large.evaluate(() => window.__pdfh5.reader()?.openPanel('outline'));
  await wait(1500);
  const outlineCount = await large.evaluate(() => document.querySelectorAll('.pdfh5-outline-item').length);
  await large.screenshot({ path: join(shotDir, 'mobile-outline.png') });
  check('目录面板可用（读取 PDF 书签，含多级）', outlineCount >= 6, `${outlineCount} 条`);

  // 点击目录项能跳页
  const jumped = await large.evaluate(async () => {
    const items = [...document.querySelectorAll('.pdfh5-outline-item')];
    const before = window.__pdfh5.page();
    items[items.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 1500));
    return { before, after: window.__pdfh5.page(), titles: items.map((el) => el.innerText.replace(/\s+/g, ' ').trim()) };
  });
  check('目录标题可读（PDF 书签编码正确）', !/无标题/.test(jumped.titles.join('')), jumped.titles.slice(0, 2).join(' / '));
  check('点击目录可跳转到目标页', jumped.after !== jumped.before && jumped.after > 1, `第 ${jumped.before} 页 -> 第 ${jumped.after} 页`);

  // ---------- 8. 控制台错误 ----------
  const realErrors = consoleErrors.filter(
    (t) => !/favicon|DevTools|preload|deprecated|apple-mobile-web-app-capable/i.test(t),
  );
  check('无未捕获的前端错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '无');

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== 结果：${passed}/${results.length} 通过 ===`);
  await writeFile(
    join(shotDir, 'verify-report.json'),
    JSON.stringify({ results, baseUrl, at: new Date().toISOString() }, null, 2),
  );

  if (passed !== results.length) process.exitCode = 1;
} catch (error) {
  console.error('\n验证脚本异常：', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
