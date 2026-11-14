#!/usr/bin/env node
/**
 * make-samples.mjs — 为 pdf-h5-react 生成演示用 PDF 样本
 *
 * 产物（只写入 public/samples/）：
 *   demo-zh.pdf     中文演示文档 22 页：页眉/页码/中文段落、A4 横版与 480×800 窄页、
 *                   /Rotate 90、内链（第 2 页 → 第 10 页）、外链（PDF.js 官网）、
 *                   6 组共 13 条大纲（Outline）、一页纯矢量插图。
 *   large.pdf       300 页英文轻量文档，用于懒加载 / 虚拟滚动性能演示。
 *   encrypted.pdf   从 Mozilla pdf.js 官方测试集下载的加密 PDF（密码 test），
 *                   网络不可用时跳过，不影响其它产物。
 *
 * 特性：
 *   - 幂等：重复运行直接覆盖，固定元数据日期，输出字节级一致。
 *   - 自带自检：生成后用 pdfjs-dist 在 Node 内打开每个文件，断言页数、
 *     大纲条目、文本层可提取、页面尺寸/旋转、链接目标、文本是否越界。
 *
 * 用法：node scripts/make-samples.mjs   （或 npm run samples）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';

import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFHexString,
  PDFString,
  PDFOperator,
  StandardFonts,
  degrees,
  rgb,
  pushGraphicsState,
  popGraphicsState,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
/**
 * 输出目录。默认 public/samples；可用环境变量 SAMPLES_OUT_DIR 指向别处，
 * 方便在不覆盖现有产物的前提下重跑验证。
 */
const OUT_DIR = process.env.SAMPLES_OUT_DIR
  ? path.resolve(process.env.SAMPLES_OUT_DIR)
  : path.join(PROJECT_ROOT, 'public', 'samples');
const FONT_PATH = 'C:\\Windows\\Fonts\\simhei.ttf';

/** 固定时间戳，保证重复运行输出字节一致（幂等） */
const FIXED_DATE = new Date('2024-01-01T00:00:00Z');

const A4 = [595.28, 841.89];
const A4_LANDSCAPE = [841.89, 595.28];
const NARROW = [480, 800];

const LIMITS = {
  demoBytes: 1.5 * 1024 * 1024,
  largeBytes: 800 * 1024,
  encryptedBytes: 200 * 1024,
};

const palette = {
  text: rgb(0.16, 0.17, 0.2),
  muted: rgb(0.45, 0.47, 0.52),
  accent: rgb(0.11, 0.42, 0.85),
  accentDeep: rgb(0.07, 0.29, 0.62),
  accentSoft: rgb(0.9, 0.94, 1),
  rule: rgb(0.8, 0.82, 0.86),
  box: rgb(0.965, 0.972, 0.985),
  warn: rgb(0.85, 0.36, 0.2),
  white: rgb(1, 1, 1),
};

const log = (...args) => console.log(...args);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function assert(condition, message) {
  if (!condition) throw new Error(`[assert] ${message}`);
}

// ---------------------------------------------------------------------------
// 文本排版：按字符宽度折行
// ---------------------------------------------------------------------------

/** 可参与「整词换行」的西文/数字片段 */
const LATIN_TOKEN = /[A-Za-z0-9@._+\-/:%#$&'*?=^~`|]/;

/** 把一行文本切成换行单元：西文单词整体、其它字符逐字（CJK 任意处可断行） */
function tokenize(text) {
  const tokens = [];
  let buffer = '';
  for (const ch of text) {
    if (LATIN_TOKEN.test(ch)) {
      buffer += ch;
      continue;
    }
    if (buffer) {
      tokens.push(buffer);
      buffer = '';
    }
    tokens.push(ch);
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

/** 贪心折行，确保每行宽度不超过 maxWidth */
function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    let line = '';
    for (let token of tokenize(raw)) {
      // 单个超长 token（长 URL 等）先硬切
      while (token && !line && font.widthOfTextAtSize(token, size) > maxWidth) {
        let cut = token.length;
        while (cut > 1 && font.widthOfTextAtSize(token.slice(0, cut), size) > maxWidth) cut -= 1;
        lines.push(token.slice(0, cut));
        token = token.slice(cut);
      }
      const candidate = line + token;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line.replace(/[ \t]+$/, ''));
        line = token === ' ' ? '' : token;
      } else {
        line = candidate;
      }
    }
    lines.push(line.replace(/[ \t]+$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 页面绘制上下文
// ---------------------------------------------------------------------------

/**
 * 打开「显示坐标系」：对设置了 /Rotate 的页面，先压入 cm 变换，
 * 之后所有绘制都用「用户看到的横向版面」坐标，文字方向自然正确。
 */
function beginDisplaySpace(page, rotation) {
  const { width: w, height: h } = page.getSize();
  if (rotation === 90) {
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of('cm', [0, 1, -1, 0, w, 0].map((n) => PDFNumber.of(n))),
    );
    return {
      width: h,
      height: w,
      end: () => page.pushOperators(popGraphicsState()),
    };
  }
  if (rotation !== 0) throw new Error(`未实现的页面旋转：${rotation}`);
  return { width: w, height: h, end: () => {} };
}

/** 依据显示尺寸创建绘制上下文（边距、字号随页面宽度自适应） */
function createContext(page, font, view, index, total) {
  const narrow = view.width < 520;
  const marginLeft = narrow ? 32 : 50;
  const marginRight = narrow ? 32 : 50;
  const bodySize = narrow ? 10.5 : 11;
  return {
    page,
    font,
    view,
    index,
    total,
    palette,
    marginLeft,
    marginRight,
    bodySize,
    contentWidth: view.width - marginLeft - marginRight,
    headerBaseline: view.height - 34,
    ruleBaseline: view.height - 42,
    contentTop: view.height - 68,
    contentBottom: 58,
    footerBaseline: 26,
    footerRule: 40,
  };
}

/** 页眉 + 页码（页脚）。返回本页二维码？不需要——只画文字。 */
function drawChrome(ctx) {
  const { page, font, view, palette, marginLeft, marginRight, index, total } = ctx;
  const header = 'pdf-h5-react 演示文档';
  page.drawText(header, {
    x: marginLeft,
    y: ctx.headerBaseline,
    size: 9,
    font,
    color: palette.muted,
  });
  const pageLabel = `第 ${index} 页 / 共 ${total} 页`;
  const labelWidth = font.widthOfTextAtSize(pageLabel, 9);
  page.drawText(pageLabel, {
    x: view.width - marginRight - labelWidth,
    y: ctx.headerBaseline,
    size: 9,
    font,
    color: palette.muted,
  });
  page.drawLine({
    start: { x: marginLeft, y: ctx.ruleBaseline },
    end: { x: view.width - marginRight, y: ctx.ruleBaseline },
    thickness: 0.7,
    color: palette.rule,
  });
  page.drawLine({
    start: { x: marginLeft, y: ctx.footerRule },
    end: { x: view.width - marginRight, y: ctx.footerRule },
    thickness: 0.5,
    color: palette.rule,
  });
  const footerWidth = font.widthOfTextAtSize(pageLabel, 9);
  page.drawText(pageLabel, {
    x: (view.width - footerWidth) / 2,
    y: ctx.footerBaseline,
    size: 9,
    font,
    color: palette.muted,
  });
}

/**
 * 绘制一段自动折行的文字，返回新的 y。
 * overflow 表示该段因为触底被截断。
 */
function drawWrapped(page, ctx, text, options = {}) {
  const size = options.size ?? ctx.bodySize;
  const lineHeight = options.lineHeight ?? Math.round(size * 1.7);
  const x = options.x ?? ctx.marginLeft;
  const maxWidth = options.maxWidth ?? ctx.contentWidth;
  const color = options.color ?? ctx.palette.text;
  const indent = options.indent ?? 0;

  let y = options.y;
  const lines = wrapText(text, ctx.font, size, maxWidth);
  for (const line of lines) {
    if (y < ctx.contentBottom) return { y, overflow: true };
    page.drawText(line, { x: x + indent, y, size, font: ctx.font, color });
    y -= lineHeight;
  }
  return { y, overflow: false };
}

/**
 * 无序列表：项目符号 + 悬挂缩进。
 *
 * 项目符号改用 drawEllipse 画实心小圆点，而不是画「•」(U+2022)：
 * SimHei 的 cmap 里没有 U+2022，画字符会渲染成豆腐块，而且文本层会多出
 * U+0000 这样的空字符（复制出来是乱码）。用矢量点既不会缺字，也不会污染文本层。
 */
function drawBullets(page, ctx, items, options = {}) {
  let y = options.y;
  const size = options.size ?? ctx.bodySize;
  const lineHeight = Math.round(size * 1.7);
  const bulletIndent = 14;
  for (const item of items) {
    if (y < ctx.contentBottom) return { y, overflow: true };
    page.drawEllipse({
      x: ctx.marginLeft + 4.5,
      y: y + size * 0.32,
      xScale: 1.7,
      yScale: 1.7,
      color: ctx.palette.accent,
    });
    const result = drawWrapped(page, ctx, item, {
      y,
      size,
      lineHeight,
      x: ctx.marginLeft + bulletIndent,
      maxWidth: ctx.contentWidth - bulletIndent,
      color: ctx.palette.text,
    });
    y = result.y - 3;
    if (result.overflow) return { y, overflow: true };
  }
  return { y, overflow: false };
}

/** 浅色提示框（矩形 + 边框 + 文本） */
function drawNoteBox(page, ctx, y, text, { tone = 'accent' } = {}) {
  const size = ctx.bodySize - 1;
  const lineHeight = Math.round(size * 1.7);
  const padding = 10;
  const lines = wrapText(text, ctx.font, size, ctx.contentWidth - padding * 2);
  const boxHeight = lines.length * lineHeight + padding * 2 - 4;
  if (y - boxHeight < ctx.contentBottom) return { y, overflow: true };

  const fill = tone === 'warn' ? rgb(1, 0.95, 0.93) : ctx.palette.accentSoft;
  const stroke = tone === 'warn' ? ctx.palette.warn : rgb(0.72, 0.8, 0.94);
  page.drawRectangle({
    x: ctx.marginLeft,
    y: y - boxHeight,
    width: ctx.contentWidth,
    height: boxHeight,
    color: fill,
    borderColor: stroke,
    borderWidth: 0.8,
  });
  // 左侧色条，纯矢量装饰
  page.drawRectangle({
    x: ctx.marginLeft,
    y: y - boxHeight,
    width: 3,
    height: boxHeight,
    color: stroke,
  });
  let cursor = y - padding - size;
  for (const line of lines) {
    page.drawText(line, {
      x: ctx.marginLeft + padding + 2,
      y: cursor,
      size,
      font: ctx.font,
      color: ctx.palette.text,
    });
    cursor -= lineHeight;
  }
  return { y: y - boxHeight - 12, overflow: false };
}

// ---------------------------------------------------------------------------
// 内链 / 外链
// ---------------------------------------------------------------------------

/**
 * 添加链接注释。
 * 内链使用低层 API：Dest = [目标页 ref, /XYZ, null, null, null]
 * 外链使用 URI Action。
 */
function addLinkAnnotation(pdfDoc, page, rect, link, pageRefs) {
  const ctx = pdfDoc.context;
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const safeRect = [
    Math.max(0, rect[0]),
    Math.max(0, rect[1]),
    Math.min(pageWidth, rect[2]),
    Math.min(pageHeight, rect[3]),
  ];
  const dict =
    link.kind === 'internal'
      ? ctx.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: safeRect,
          Border: [0, 0, 0],
          H: 'N',
          Dest: [pageRefs[link.target - 1], 'XYZ', null, null, null],
        })
      : ctx.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: safeRect,
          Border: [0, 0, 0],
          H: 'N',
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(link.url) },
        });
  page.node.addAnnot(ctx.register(dict));
}

/** 画一条可点击的「文字链」，并在下方注册注释 */
function drawLinkRow(pdfDoc, page, ctx, y, link, pageRefs) {
  const size = ctx.bodySize + 0.5;
  const label = link.label;
  const width = Math.min(ctx.font.widthOfTextAtSize(label, size), ctx.contentWidth);
  if (y < ctx.contentBottom + 26) return { y, overflow: true };

  page.drawText(label, {
    x: ctx.marginLeft,
    y,
    size,
    font: ctx.font,
    color: ctx.palette.accent,
  });
  page.drawLine({
    start: { x: ctx.marginLeft, y: y - 2.5 },
    end: { x: ctx.marginLeft + width, y: y - 2.5 },
    thickness: 0.7,
    color: ctx.palette.accent,
  });
  const hint = link.kind === 'internal' ? `内部跳转 → 第 ${link.target} 页` : '外部链接 → 浏览器打开';
  if (link.hint !== false) {
    page.drawText(hint, {
      x: ctx.marginLeft,
      y: y - 14,
      size: 8.5,
      font: ctx.font,
      color: ctx.palette.muted,
    });
  }
  addLinkAnnotation(
    pdfDoc,
    page,
    [ctx.marginLeft - 3, y - 6, ctx.marginLeft + width + 3, y + size + 4],
    link,
    pageRefs,
  );
  return { y: y - (link.hint === false ? 24 : 40), overflow: false };
}

// ---------------------------------------------------------------------------
// 矢量插图（第 13 页）
// ---------------------------------------------------------------------------

/**
 * 用矩形、直线、SVG 路径（三角形/六边形）拼一张「渲染管线」示意图。
 * 返回绘制后的底部 y。
 */
function drawPipelineDiagram(page, ctx, topY) {
  const { palette, font } = ctx;
  const left = ctx.marginLeft;
  const width = ctx.contentWidth;
  const gap = 16;
  const boxW = (width - gap * 3) / 4;
  const boxH = 62;
  const stages = [
    ['加载文档', 'getDocument()'],
    ['解析页面', 'getPage(n)'],
    ['渲染队列', 'RenderTask'],
    ['绘制', 'canvas + 文本层'],
  ];

  let y = topY;
  // 顶部标注：数据流方向
  page.drawText('数据流方向', {
    x: left,
    y: y - 10,
    size: 8.5,
    font,
    color: palette.muted,
  });
  page.drawLine({
    start: { x: left + 62, y: y - 13 },
    end: { x: left + width, y: y - 13 },
    thickness: 0.6,
    color: palette.rule,
    dashArray: [2, 3],
  });
  y -= 26;

  for (let i = 0; i < stages.length; i += 1) {
    const [label, sub] = stages[i];
    const bx = left + i * (boxW + gap);
    page.drawRectangle({
      x: bx,
      y: y - boxH,
      width: boxW,
      height: boxH,
      color: i === 2 ? palette.accentSoft : palette.box,
      borderColor: i === 2 ? palette.accent : palette.rule,
      borderWidth: i === 2 ? 1.2 : 0.8,
    });
    const labelWidth = font.widthOfTextAtSize(label, 11);
    page.drawText(label, {
      x: bx + (boxW - labelWidth) / 2,
      y: y - 26,
      size: 11,
      font,
      color: i === 2 ? palette.accentDeep : palette.text,
    });
    const subWidth = font.widthOfTextAtSize(sub, 7.5);
    page.drawText(sub, {
      x: bx + (boxW - subWidth) / 2,
      y: y - 44,
      size: 7.5,
      font,
      color: palette.muted,
    });
    if (i < stages.length - 1) {
      // SVG 路径画的箭头（三角形），验证矢量路径渲染
      page.drawSvgPath('M0,0 L11,5 L0,10 Z', {
        x: bx + boxW + 3,
        y: y - boxH / 2 - 5,
        color: palette.accent,
      });
    }
  }
  y -= boxH + 22;

  // 第二层：缓存与内存预算
  const bandH = 54;
  page.drawRectangle({
    x: left,
    y: y - bandH,
    width: width,
    height: bandH,
    color: palette.accentSoft,
    borderColor: rgb(0.75, 0.82, 0.95),
    borderWidth: 0.8,
  });
  page.drawText('LRU 缓存（最近 N 页位图 + 文本层）· 超出预算即淘汰最久未用项', {
    x: left + 14,
    y: y - 22,
    size: 9.5,
    font,
    color: palette.accentDeep,
  });
  page.drawText('节流 / 防抖 控制滚动时的重渲染频率，避免主线程被占满', {
    x: left + 14,
    y: y - 38,
    size: 8.5,
    font,
    color: palette.muted,
  });

  // 连接上下两层的虚线 + 六边形装饰（多边形路径）
  const cx = left + width - 26;
  const cy = y + bandH + 12;
  page.drawLine({
    start: { x: cx, y: y + 2 },
    end: { x: cx, y: cy - 10 },
    thickness: 0.8,
    color: palette.rule,
    dashArray: [3, 3],
  });
  page.drawSvgPath('M11,0 L22,6.3 L22,19 L11,25.3 L0,19 L0,6.3 Z', {
    x: cx - 11,
    y: cy - 44,
    color: palette.white,
    borderColor: palette.accent,
    borderWidth: 1.2,
  });
  page.drawSvgPath('M6,12.7 L9.6,16.3 L16.5,9.4', {
    borderColor: palette.accent,
    borderWidth: 1.4,
    x: cx - 11,
    y: cy - 44,
  });

  y -= bandH + 18;
  return y;
}

// ---------------------------------------------------------------------------
// 目录（Outline）
// ---------------------------------------------------------------------------

/**
 * 用低层 API 构造 /Outlines 树，写入 catalog。
 * groups: [{ title, pageIndex, children?: [{ title, pageIndex }] }]
 */
function buildOutline(pdfDoc, groups) {
  const ctx = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const destOf = (pageIndex) => [pages[pageIndex].ref, 'XYZ', null, null, null];

  const rootDict = ctx.obj({ Type: 'Outlines' });
  const rootRef = ctx.register(rootDict);

  const tops = [];
  for (const group of groups) {
    const dict = ctx.obj({
      Title: PDFHexString.fromText(group.title),
      Parent: rootRef,
      Dest: destOf(group.pageIndex),
    });
    const ref = ctx.register(dict);
    tops.push({ ref, dict });
  }

  // 一级项之间前后串链，并写 /Count
  for (let i = 1; i < tops.length; i += 1) tops[i].dict.set(PDFName.of('Prev'), tops[i - 1].ref);
  for (let i = 0; i < tops.length - 1; i += 1) tops[i].dict.set(PDFName.of('Next'), tops[i + 1].ref);

  groups.forEach((group, index) => {
    if (!group.children || group.children.length === 0) return;
    const parentRef = tops[index].ref;
    const children = group.children.map((child) => {
      const dict = ctx.obj({
        Title: PDFHexString.fromText(child.title),
        Parent: parentRef,
        Dest: destOf(child.pageIndex),
      });
      return { ref: ctx.register(dict), dict };
    });
    for (let i = 1; i < children.length; i += 1) {
      children[i].dict.set(PDFName.of('Prev'), children[i - 1].ref);
    }
    for (let i = 0; i < children.length - 1; i += 1) {
      children[i].dict.set(PDFName.of('Next'), children[i + 1].ref);
    }
    tops[index].dict.set(PDFName.of('First'), children[0].ref);
    tops[index].dict.set(PDFName.of('Last'), children[children.length - 1].ref);
    tops[index].dict.set(PDFName.of('Count'), PDFNumber.of(children.length));
  });

  rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
  rootDict.set(PDFName.of('First'), tops[0].ref);
  rootDict.set(PDFName.of('Last'), tops[tops.length - 1].ref);
  rootDict.set(PDFName.of('Count'), PDFNumber.of(tops.length));

  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  return { topLevel: tops.length, total: groups.reduce((n, g) => n + 1 + (g.children?.length ?? 0), 0) };
}

// ---------------------------------------------------------------------------
// demo-zh.pdf 的内容规划
// ---------------------------------------------------------------------------

const SPECS = [
  {
    kind: 'cover',
    title: 'pdf-h5-react 演示文档',
    lead: '基于 PDF.js 的移动端优先 React PDF 阅读器 · 演示样本',
    paragraphs: [
      '这份文件由 scripts/make-samples.mjs 生成，用来验证阅读器的渲染、懒加载、缓存、节流、目录、内链与外链等能力。它是确定性的：重复运行脚本会得到字节一致的输出。',
      '第 3 页使用横向 A4（841.89 × 595.28），第 5 页使用 480 × 800 的窄页，第 7 页在 A4 媒体框上设置了 /Rotate 90。三页都可用于检查尺寸探测与旋转换算是否正确。',
      '第 2 页含一个跳转到第 10 页的内链和一个指向 PDF.js 官网的外链；第 13 页是一张完全由矩形、直线和 SVG 路径拼出的矢量插图。',
    ],
    meta: ['22 页', 'SimHei 子集嵌入', 'make-samples.mjs 生成'],
  },
  {
    title: '快速开始',
    lead: '三步接入：安装、配置资源、渲染',
    paragraphs: [
      'pdf-h5-react 把 PDF.js 的加载、分页渲染、文本层、搜索与目录封装成 React 组件。默认从 jsDelivr 加载与依赖版本严格一致的 worker、cmaps 与标准字体，因此零配置即可跑通。',
      '生产环境建议自托管静态资源：运行 npm run assets 把 pdfjs-dist 的 worker、cmaps、standard_fonts、wasm 拷到 public 下，再用 configurePdfjs({ workerSrc, cMapUrl }) 指向本地路径，避免 CDN 抖动影响首屏。',
      '加载文档时注意：pdf.js 会「转移」传入 TypedArray 的所有权，组件内部必须先复制再传给 getDocument，否则调用方手里的字节会被置空。',
    ],
    bullets: [
      'npm i pdf-h5-react pdfjs-dist',
      '在入口调用 configurePdfjs 覆盖资源地址',
      '用 <PdfH5Reader src={url} /> 渲染，卸载时自动销毁 task',
    ],
    links: [
      { kind: 'internal', label: '→ 跳到第 10 页：LRU 缓存实现细节', target: 10 },
      { kind: 'external', label: '→ 打开 PDF.js 官方示例站', url: 'https://mozilla.github.io/pdf.js/' },
    ],
  },
  {
    title: '架构总览',
    lead: '横向页面：更宽的排版用于展示结构图',
    paragraphs: [
      '整个组件分成四层：文档层负责 getDocument 与密码回调；布局层根据页面尺寸与旋转计算每页占位高度；渲染层用队列调度 canvas 绘制；交互层处理滚动、缩放、选中与搜索。',
      '布局层的关键是「先占位、后绘制」：进入视口之前，每一页只是一个高度已知的占位元素，滚动条长度立刻正确，用户不会遇到「越滚越长」的跳动。',
      '横向页面本身也是测试用例：媒体框宽高互换后，页眉页脚与正文必须重新按显示尺寸排布，而不能沿用 A4 的固定坐标。',
    ],
    bullets: [
      '文档层：getDocument / 密码 / 进度',
      '布局层：页面尺寸 + 旋转换算 → 占位高度',
      '渲染层：RenderTask 队列 + 取消',
      '交互层：滚动、缩放、文本层、目录',
    ],
  },
  {
    title: 'PDF.js 渲染管线',
    lead: '从字节流到一帧画面',
    paragraphs: [
      'getDocument 解析交叉引用表与对象流，得到 PDFDocumentProxy；getPage(n) 取出页面字典，读出 MediaBox、CropBox、Rotate 与资源字典；getOperatorList 把内容流翻译成操作符数组，getTextContent 另外产出一份带坐标的文本项。',
      '渲染时 canvas 承担图形，文本层用绝对定位的 span 覆盖其上，两者共享同一套视口变换。文本层不是为了「好看」，而是为了选中、复制、搜索高亮与无障碍访问。',
      '页面旋转不会改变内容流坐标，只改变视口的变换矩阵。因此布局计算必须使用 getViewport({ rotation }) 的结果，而不是直接读 MediaBox 的宽高。',
    ],
  },
  {
    title: '移动端布局要点',
    lead: '480 × 800 窄页：验证窄屏排版',
    paragraphs: [
      '窄屏的第一原则是「一屏一页」。宽度固定、高度按比例缩放，用户上下滑动就能读完；双指缩放交给浏览器或容器统一处理，避免每页各自缩放导致错位。',
      '第二原则是安全区。刘海屏与手势条会吃掉上下边缘，页眉与页码必须落在 env(safe-area-inset-*) 之内，否则在 iPhone 上会被圆角裁掉。',
      '第三原则是「不要用 vh」。移动浏览器地址栏收起时 vh 会跳变，改用 100% 高度加 overscroll-behavior: contain，滚动位置才不会突然回弹。',
    ],
    bullets: ['固定宽度 + 等比高度', 'safe-area-inset 内边距', '避免 100vh，改用容器高度'],
  },
  {
    title: '文本层与搜索',
    lead: '让 PDF 像网页一样可选中、可检索',
    paragraphs: [
      '文本层由 getTextContent 的 items 生成：每一项带有 str、transform、width、height。把 transform 与视口矩阵相乘，就能得到它在屏幕上的位置与旋转角，再据此写入 span 的 left/top/font-size。',
      '搜索不是遍历 DOM，而是对拼好的文本做一次大小写无关的匹配，命中后按字符索引反查所属 item，再高亮对应的矩形。这样即使一页有几万个字符，也能在毫秒级完成。',
      '中文检索需要注意：PDF 里的文本常常按字断行，直接拼接会丢掉词边界。渲染时保留空格与换行信息，搜索时用「连续文本 + 索引映射」的方式还原位置。',
    ],
  },
  {
    title: '旋转页说明',
    lead: '本页 /Rotate 90：媒体框仍是 A4，显示尺寸为 841.89 × 595.28',
    paragraphs: [
      'PDF 的 Rotate 是「显示时旋转」，不是「内容旋转」。阅读器若直接按 MediaBox 宽高布局，这一页就会横向溢出；正确做法是读取页面字典里的 /Rotate，把宽高互换后再算占位。',
      '生成这份样本时，脚本先压入一个 cm 变换矩阵，把绘制坐标从「页面坐标系」映射到「显示坐标系」，再照常画页眉、正文和页码。因此你在屏幕上看到的文字是正的，而文件里这一页确实带着 /Rotate 90。',
      '注释（链接、批注）的坐标始终在页面坐标系里。旋转页面上的链接矩形不会自动跟着转，命中测试时必须先做同样的变换，否则点击区域会偏到别处。',
    ],
  },
  {
    title: '懒加载策略',
    lead: '只渲染看得见的页面',
    paragraphs: [
      '用 IntersectionObserver 观察每一页的占位元素，rootMargin 设成一屏左右：提前一屏开始渲染，用户滑到之前刚好画完；离开两屏以上则回收 canvas，只留占位。',
      'IntersectionObserver 的回调是批量异步的，不能在里面直接同步渲染，否则一次滚动会触发十几个渲染任务，主线程直接被占满。正确做法是把待渲染页塞进队列，由队列按「距离视口远近」排序逐个执行。',
      '首屏要特殊处理：不要等 observer 回调，直接在挂载后同步渲染当前页，否则用户会看到一片空白，误以为加载失败。',
    ],
    bullets: ['rootMargin 约一屏', '离开两屏回收 canvas', '首屏同步渲染，其余入队'],
  },
  {
    title: '渲染队列与优先级',
    lead: '同一时刻只做一件重活',
    paragraphs: [
      '渲染任务用「并发 1 + 可取消」最稳：新任务入队时把旧任务的 RenderTask.cancel() 掉，避免过期页面继续占用 CPU；已取消的任务要吞掉 RenderingCancelledException，不能当成错误上报。',
      '排序键用「距离当前视口的页数」，同一距离再按用户滚动方向优先。向下滚动时，下一页永远比上一页更值得先画。',
      '队列还要有节流：滚动过程中每 100 毫秒最多启动一个新任务，滚动停止后再补一轮。否则快速滑动会不断取消、重启，反而更慢。',
    ],
  },
  {
    title: 'LRU 缓存',
    lead: '内链目标页：第 2 页的链接会跳到这里',
    paragraphs: [
      '渲染结果（位图或 canvas）按页号缓存，容量按「像素预算」而不是「页数」计算：一页 4K 宽的位图可能有几十 MB，按页数限制在混合尺寸文档里会严重失衡。',
      '淘汰策略是标准 LRU：命中即刷新到队尾，插入超预算时从队首淘汰。注意 pin 住当前页与前后各一页，否则用户来回翻两页就会反复重渲染。',
      '文本层的缓存可以更激进：一份纯文本加坐标的体量远小于位图，保留全部页面也通常只有几 MB，搜索时能直接命中。',
    ],
    bullets: ['按像素预算计量', 'pin 当前页 ±1', '文本层可全量缓存'],
  },
  {
    title: '节流与防抖',
    lead: '把高频事件压成可控的帧',
    paragraphs: [
      '滚动事件用 requestAnimationFrame 合并：一次事件只记录最新的 scrollTop，下一帧统一读取布局并决定要渲染哪些页。读取与写入分离，避免强制同步布局造成 layout thrashing。',
      '缩放用防抖：手势结束 120 毫秒后才真正重新渲染，过程中只做 CSS transform 的视觉缩放，让画面跟手。这样既没有空白，也不会在手势中反复重建 canvas。',
      '搜索输入用防抖 + 取消令牌：新输入到来时丢弃上一次的搜索结果，避免旧结果覆盖新结果。',
    ],
  },
  {
    title: '缩放与手势',
    lead: '视觉缩放与重渲染分离',
    paragraphs: [
      '双指缩放分两段：手势进行中用 transform: scale() 让画面即时跟手；手势结束后按新的 devicePixelRatio 重新渲染当前页，把模糊的位图替换成清晰位图。',
      '缩放中心要跟随双指中点，而不是页面中心，否则用户会觉得画面在「乱跑」。换算公式：新滚动位置 = 中点位置 × 缩放比 - 中点偏移。',
      '为高 DPI 屏幕渲染时，canvas 的像素尺寸要乘以 devicePixelRatio，再用 CSS 缩回逻辑尺寸，否则文字会发虚。',
    ],
  },
  {
    title: '矢量插图与渲染验证',
    lead: '本页插图完全由 pdf-lib 的矩形、直线与 SVG 路径绘制',
    paragraphs: [
      '下面这张示意图没有任何位图：方框是 drawRectangle，箭头与六边形是 drawSvgPath，分隔线是 drawLine。它用来检查渲染器对填充、描边、虚线与路径的还原是否准确。',
    ],
    illustration: true,
    bullets: ['矩形：drawRectangle（含填充与描边）', '路径：drawSvgPath（三角形 / 六边形 / 对勾）', '直线：drawLine（含 dashArray 虚线）'],
  },
  {
    title: '内存与性能预算',
    lead: '给每一层都设上限',
    paragraphs: [
      '位图缓存设 256 MB 上限，文本层设 32 MB，渲染队列并发 1、待办不超过 8 页。三个数字要一起看：只限位图不限队列，快速滑动时仍会把 CPU 打满。',
      '在低端安卓机上，单页渲染耗时可能超过 200 毫秒。此时应降低渲染倍率（devicePixelRatio 上限 2），并在滚动中暂停渲染，只保留占位。',
      '内存告警可以监听 performance.memory（Chromium）或 document.willNavigate，主动清空缓存；iOS Safari 更常见的是标签页被回收，恢复时要能重新加载文档而不是白屏。',
    ],
  },
  {
    title: '大文档分片加载',
    lead: '300 页的 large.pdf 就是为此准备的',
    paragraphs: [
      'PDF.js 支持 Range 请求：服务器返回 Accept-Ranges 与 Content-Length 后，它只取需要的字节区间，几百 MB 的文档也能秒开。静态托管时要确认没有把 Range 头吃掉。',
      '没有 Range 支持时退化为整包下载，此时应显示真实进度并允许取消。进度回调的 total 有时是 0，要用 Content-Length 兜底。',
      '页面缩略图不要一次性全生成：先渲染可见的十几张，其余在用户打开目录面板时按需补齐。',
    ],
  },
  {
    title: '错误处理与降级',
    lead: '坏文件也要给出可读的提示',
    paragraphs: [
      '常见错误分三类：PasswordException（需要密码）、InvalidPDFException（结构损坏）、MissingPDFException（404 或跨域被拦）。三类要给不同的文案与操作，而不是统一的「加载失败」。',
      '跨域是最容易踩的坑：字体、cmaps、worker 都必须同源或带 CORS 头，否则控制台只有一句模糊的警告，页面却一直空白。',
      '降级策略：worker 启动失败时退回主线程渲染（设置 disableWorker），牺牲流畅度换取可用性；渲染失败的单页显示重试按钮，不影响其它页。',
    ],
  },
  {
    title: 'API 一览',
    lead: '组件与命令式接口',
    paragraphs: [
      '声明式入口是 <PdfH5Reader src mode fitMode theme textLayer onPageChange onError renderError />；需要精细控制时用 ref 拿到命令式方法：goToPage、nextPage、prevPage、setZoom、zoomIn、zoomOut、resetZoom、search、clearSearch、getCacheStats、clearCaches、openPanel。',
      'src 支持 string | URL | ArrayBuffer | Uint8Array | { url, data, password, httpHeaders, withCredentials }。二进制输入会被复制一份，调用方不必担心 ArrayBuffer 被 pdf.js 转移所有权后失效。',
      '类型上，PdfH5ReaderHandle 描述了全部命令式方法，CacheStatsSnapshot 描述缓存与渲染的运行时统计。',
    ],
    bullets: [
      'goToPage(n) / nextPage() / prevPage()',
      'setZoom(z) / zoomIn() / zoomOut() / resetZoom()',
      'search(keyword) → Promise<SearchHit[]>',
      'openPanel("outline" | "thumbnails" | "search")',
    ],
  },
  {
    title: '配置项',
    lead: '常用参数与默认值',
    paragraphs: [
      'configurePdfjs 接受 workerSrc、cMapUrl、standardFontDataUrl、wasmUrl、iccUrl 与 verbosity。默认值指向 jsDelivr 上与 pdfjs-dist 版本严格一致的路径。',
      '组件层参数：initialPage、initialScale、enableTextLayer、enableAnnotationLayer、renderMargin（预渲染屏数）、cacheBudget（像素预算）。',
      '调试时把 verbosity 调成 1 能看到 pdf.js 的警告，例如缺字体、CMap 加载失败、加密算法不支持等，定位问题比读堆栈快得多。',
    ],
  },
  {
    title: '常见问题（一）',
    lead: '中文不显示、文字发虚、首屏空白',
    paragraphs: [
      '中文不显示，九成是缺 CMap：未嵌入字体的中文 PDF 依赖 cmaps 目录做编码映射，cMapUrl 没配或路径少了结尾斜杠都会失败。',
      '文字发虚是 canvas 像素比没跟上 devicePixelRatio；在高分屏上按 CSS 尺寸建 canvas，等于把位图放大了两倍。',
      '首屏空白通常是等 IntersectionObserver 首次回调才渲染导致的。挂载后立刻渲染当前页，observer 只负责后续页面。',
    ],
  },
  {
    title: '常见问题（二）',
    lead: '链接点不动、目录是空的、滚动卡顿',
    paragraphs: [
      '链接点不动，先确认注释层是否开启：pdf.js 的 getAnnotations 返回的是原始数据，命中区域需要自己按视口变换铺一层透明元素。',
      '目录是空的，说明文件的 catalog 里没有 /Outlines，或者条目缺少 /Dest 与 /Parent。本文件的目录就是用低层 API 手工拼出来的，可用 getOutline() 验证。',
      '滚动卡顿多半是渲染任务没有取消：上一页还没画完就开始画下一页，两个任务抢同一个主线程。',
    ],
  },
  {
    title: '附录 A · 术语表',
    lead: '读源码前先统一名词',
    paragraphs: [
      'MediaBox：页面媒体框，定义物理尺寸；CropBox：可见裁剪框，通常等于 MediaBox；Rotate：显示时顺时针旋转的角度，只能是 90 的倍数。',
      'OperatorList：内容流翻译后的操作符数组，是渲染器的输入；TextContent：带坐标的文本项集合，是文本层与搜索的输入。',
      'RenderTask：一次渲染任务，可取消；Viewport：把 PDF 用户坐标映射到设备像素的变换，包含旋转与缩放。',
    ],
  },
  {
    title: '附录 B · 自检清单',
    lead: '每次改动后按这份清单回归',
    paragraphs: [
      '用本文件回归：第 3、5、7 页的尺寸与旋转、第 2 页的两个链接、第 13 页的矢量插图、目录的 6 个一级项，以及第 1 页的中文文本能否被提取。',
      '再用 large.pdf 回归：300 页快速滑动时内存是否稳定、滚动条长度是否立即正确、跳转到第 300 页是否只渲染附近几页。',
      '最后用 encrypted.pdf 回归密码流程：无密码时应提示输入，输入 test 后能正常打开。',
    ],
    note: '脚本会在生成后自动跑一遍上述断言，任何一项失败都会以非零退出码结束。',
  },
];

// ---------------------------------------------------------------------------
// demo-zh.pdf 生成
// ---------------------------------------------------------------------------

async function loadChineseFont(pdfDoc) {
  let fontBytes;
  try {
    fontBytes = await fs.readFile(FONT_PATH);
  } catch (error) {
    throw new Error(`无法读取系统字体 ${FONT_PATH}：${error.message}`);
  }
  pdfDoc.registerFontkit(fontkit);
  let subset = true;
  let font;
  try {
    font = await pdfDoc.embedFont(fontBytes, { subset: true });
  } catch (error) {
    subset = false;
    log(`[warn] fontkit 子集化失败（${error.message}），退化为完整嵌入，体积会明显变大`);
    font = await pdfDoc.embedFont(fontBytes, { subset: false });
  }
  return { font, subset, fontBytes: fontBytes.length };
}

/**
 * 检查待绘制文本里的每个字符是否都在字体 cmap 中。
 *
 * pdf-lib 遇到字体缺字不会报错，而是静默写入 glyph 0（渲染成豆腐块，
 * 文本层取出来是 U+0000）。所以必须在画之前显式扫一遍。
 */
function assertGlyphsCovered(font, texts) {
  const coverage = new Set(font.getCharacterSet());
  const missing = new Map();
  for (const text of texts) {
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      if (ch === '\n' || ch === '\r' || ch === '\t') continue;
      if (!coverage.has(code)) {
        const key = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
        missing.set(key, (missing.get(key) ?? 0) + 1);
      }
    }
  }
  if (missing.size) {
    const list = [...missing.entries()].map(([code, n]) => `${code}×${n}`).join(', ');
    throw new Error(`字体 SimHei 缺少以下字形，请替换文案或改用矢量绘制：${list}`);
  }
}

/** 收集 demo 中所有会交给 drawText 的字符串，供字形覆盖检查使用 */
function collectDemoTexts() {
  const texts = ['pdf-h5-react 演示文档', 'PDF-H5-REACT · SAMPLE', '相关链接', '数据流方向'];
  for (const spec of SPECS) {
    texts.push(spec.title);
    if (spec.lead) texts.push(spec.lead);
    texts.push(...(spec.paragraphs ?? []));
    texts.push(...(spec.bullets ?? []));
    if (spec.note) texts.push(spec.note);
    for (const link of spec.links ?? []) texts.push(link.label, link.kind === 'internal' ? `内部跳转 → 第 ${link.target} 页` : '外部链接 → 浏览器打开');
    texts.push(...(spec.meta ?? []));
  }
  for (let i = 1; i <= SPECS.length; i += 1) texts.push(`第 ${i} 页 / 共 ${SPECS.length} 页`);
  return texts;
}

async function buildDemoZh() {
  const pdfDoc = await PDFDocument.create();
  const { font, subset, fontBytes } = await loadChineseFont(pdfDoc);
  assertGlyphsCovered(font, collectDemoTexts());

  pdfDoc.setTitle('pdf-h5-react 演示文档');
  pdfDoc.setSubject('PDF.js 阅读器渲染 / 懒加载 / 缓存 / 节流演示');
  pdfDoc.setAuthor('pdf-h5-react');
  pdfDoc.setCreator('pdf-h5-react scripts/make-samples.mjs');
  pdfDoc.setProducer('pdf-lib + make-samples.mjs');
  pdfDoc.setCreationDate(FIXED_DATE);
  pdfDoc.setModificationDate(FIXED_DATE);

  const total = SPECS.length;

  // 1) 先建页：尺寸与旋转在这一步确定，后面画内容时可直接读到正确尺寸
  const rotationByIndex = new Map([[6, 90]]); // 第 7 页（0 基索引 6）
  const pages = SPECS.map((spec, index) => {
    const size = index === 2 ? A4_LANDSCAPE : index === 4 ? NARROW : A4;
    const page = pdfDoc.addPage(size);
    const rotation = rotationByIndex.get(index);
    if (rotation) page.setRotation(degrees(rotation));
    return page;
  });
  const pageRefs = pages.map((page) => page.ref);

  // 2) 逐页绘制
  pages.forEach((page, index) => {
    const spec = SPECS[index];
    const rotation = rotationByIndex.get(index) ?? 0;
    const view = beginDisplaySpace(page, rotation);
    const ctx = createContext(page, font, view, index + 1, total);

    drawChrome(ctx);

    let y = ctx.contentTop;
    let overflow = false;

    if (spec.kind === 'cover') {
      // 封面：大标题 + 强调线 + 副标题
      const titleSize = 30;
      for (const line of wrapText(spec.title, font, titleSize, ctx.contentWidth)) {
        page.drawText(line, { x: ctx.marginLeft, y: y - titleSize, size: titleSize, font, color: palette.text });
        y -= titleSize * 1.35;
      }
      y -= 6;
      page.drawRectangle({ x: ctx.marginLeft, y: y - 3, width: 96, height: 3, color: palette.accent });
      y -= 26;
      const lead = drawWrapped(page, ctx, spec.lead, {
        y,
        size: 13,
        lineHeight: 22,
        color: palette.accentDeep,
      });
      y = lead.y - 14;
      for (const paragraph of spec.paragraphs) {
        const result = drawWrapped(page, ctx, paragraph, { y, size: 11.5, lineHeight: 20 });
        y = result.y - 10;
        overflow ||= result.overflow;
      }
      // 元信息：等宽小字 + 分隔线
      page.drawLine({
        start: { x: ctx.marginLeft, y: 96 },
        end: { x: ctx.marginLeft + ctx.contentWidth, y: 96 },
        thickness: 0.6,
        color: palette.rule,
      });
      let mx = ctx.marginLeft;
      for (const item of spec.meta) {
        page.drawText(item, { x: mx, y: 78, size: 9, font, color: palette.muted });
        mx += font.widthOfTextAtSize(item, 9) + 18;
      }
    } else {
      // 正文页：小标签 + 标题 + 导语 + 段落 / 列表 / 提示框
      page.drawText('PDF-H5-REACT · SAMPLE', {
        x: ctx.marginLeft,
        y: y - 8,
        size: 7.5,
        font,
        color: palette.accent,
      });
      y -= 24;

      const titleSize = ctx.view.width < 520 ? 18 : 21;
      for (const line of wrapText(spec.title, font, titleSize, ctx.contentWidth)) {
        if (y - titleSize < ctx.contentBottom) {
          overflow = true;
          break;
        }
        page.drawText(line, { x: ctx.marginLeft, y: y - titleSize, size: titleSize, font, color: palette.text });
        y -= titleSize * 1.4;
      }
      y -= 2;
      page.drawRectangle({ x: ctx.marginLeft, y: y - 2, width: 56, height: 2.4, color: palette.accent });
      y -= 20;

      if (spec.lead) {
        const result = drawWrapped(page, ctx, spec.lead, {
          y,
          size: ctx.bodySize + 1.5,
          lineHeight: Math.round((ctx.bodySize + 1.5) * 1.7),
          color: palette.accentDeep,
        });
        y = result.y - 12;
        overflow ||= result.overflow;
      }

      for (const paragraph of spec.paragraphs ?? []) {
        const result = drawWrapped(page, ctx, paragraph, { y, lineHeight: Math.round(ctx.bodySize * 1.85) });
        y = result.y - 10;
        overflow ||= result.overflow;
      }

      if (spec.illustration) {
        y -= 4;
        y = drawPipelineDiagram(page, ctx, y);
      }

      if (spec.bullets?.length) {
        const result = drawBullets(page, ctx, spec.bullets, { y: y + 2 });
        y = result.y - 8;
        overflow ||= result.overflow;
      }

      if (spec.note) {
        const result = drawNoteBox(page, ctx, y - 4, spec.note);
        y = result.y;
        overflow ||= result.overflow;
      }

      if (spec.links?.length) {
        y -= 4;
        page.drawText('相关链接', {
          x: ctx.marginLeft,
          y,
          size: 9,
          font,
          color: palette.muted,
        });
        y -= 22;
        for (const link of spec.links) {
          const result = drawLinkRow(pdfDoc, page, ctx, y, link, pageRefs);
          y = result.y;
          overflow ||= result.overflow;
        }
      }
    }

    if (overflow) log(`[warn] 第 ${index + 1} 页内容超出可用高度，已被截断`);
    view.end();
  });

  // 3) 目录（6 组 13 条）
  const outlineSpec = [
    { title: '封面', pageIndex: 0 },
    {
      title: '快速开始',
      pageIndex: 1,
      children: [
        { title: '架构总览', pageIndex: 2 },
        { title: 'PDF.js 渲染管线', pageIndex: 3 },
      ],
    },
    {
      title: 'API',
      pageIndex: 16,
      children: [{ title: '配置项', pageIndex: 17 }],
    },
    {
      title: '性能',
      pageIndex: 7,
      children: [
        { title: '懒加载策略', pageIndex: 7 },
        { title: '渲染队列与优先级', pageIndex: 8 },
        { title: 'LRU 缓存', pageIndex: 9 },
        { title: '节流与防抖', pageIndex: 10 },
        { title: '内存与性能预算', pageIndex: 13 },
      ],
    },
    {
      title: 'FAQ',
      pageIndex: 18,
      children: [{ title: '常见问题（二）', pageIndex: 19 }],
    },
    {
      title: '附录',
      pageIndex: 20,
      children: [
        { title: '术语表', pageIndex: 20 },
        { title: '自检清单', pageIndex: 21 },
      ],
    },
  ];
  const outline = buildOutline(pdfDoc, outlineSpec);

  const bytes = await pdfDoc.save();
  await fs.mkdir(OUT_DIR, { recursive: true });
  const filePath = path.join(OUT_DIR, 'demo-zh.pdf');
  await fs.writeFile(filePath, bytes);

  log(
    `[build] demo-zh.pdf  ${total} 页  ${bytes.length} 字节（${kb(bytes.length)}）  ` +
      `字体：SimHei ${subset ? '子集嵌入' : '完整嵌入'}（源文件 ${kb(fontBytes)}）  大纲：${outline.total} 条`,
  );
  return { filePath, bytes: bytes.length, pages: total, outline };
}

// ---------------------------------------------------------------------------
// large.pdf 生成
// ---------------------------------------------------------------------------

const LARGE_PAGE_COUNT = 300;
const LARGE_LINES = [
  'Lazy rendering mounts a page only when it enters the viewport margin.',
  'A small LRU cache keeps recently rendered pages ready for instant reuse.',
  'Throttled scroll handlers keep the main thread responsive on mobile.',
];

async function buildLarge() {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  pdfDoc.setTitle('pdf-h5-react performance sample (300 pages)');
  pdfDoc.setSubject('Lazy loading / virtual scrolling benchmark document');
  pdfDoc.setAuthor('pdf-h5-react');
  pdfDoc.setCreator('pdf-h5-react scripts/make-samples.mjs');
  pdfDoc.setProducer('pdf-lib + make-samples.mjs');
  pdfDoc.setCreationDate(FIXED_DATE);
  pdfDoc.setModificationDate(FIXED_DATE);

  for (let i = 1; i <= LARGE_PAGE_COUNT; i += 1) {
    const page = pdfDoc.addPage(A4);
    page.drawText(`Page ${i}`, {
      x: 56,
      y: 760,
      size: 20,
      font: bold,
      color: palette.text,
    });
    page.drawLine({
      start: { x: 56, y: 748 },
      end: { x: 539, y: 748 },
      thickness: 0.6,
      color: palette.rule,
    });
    let y = 716;
    for (const line of LARGE_LINES) {
      page.drawText(line, { x: 56, y, size: 10.5, font, color: rgb(0.3, 0.31, 0.35) });
      y -= 18;
    }
    page.drawText(`${i} / ${LARGE_PAGE_COUNT}`, {
      x: 56,
      y: 60,
      size: 8.5,
      font,
      color: palette.muted,
    });
  }

  const bytes = await pdfDoc.save();
  await fs.mkdir(OUT_DIR, { recursive: true });
  const filePath = path.join(OUT_DIR, 'large.pdf');
  await fs.writeFile(filePath, bytes);
  log(
    `[build] large.pdf     ${LARGE_PAGE_COUNT} 页  ${bytes.length} 字节（${kb(bytes.length)}）  ` +
      `每页 1 个标题 + 3 行短句`,
  );
  return { filePath, bytes: bytes.length, pages: LARGE_PAGE_COUNT };
}

// ---------------------------------------------------------------------------
// encrypted.pdf：从 Mozilla pdf.js 测试集下载
// ---------------------------------------------------------------------------

const ENCRYPTED_BASES = [
  'https://cdn.jsdelivr.net/gh/mozilla/pdf.js@master/test/pdfs/',
  'https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/',
];

/** 候选样本：文件小、能打开、已知密码（来自 pdf.js test_manifest.json） */
const ENCRYPTED_CANDIDATES = [
  {
    file: 'issue15893_reduced.pdf',
    password: 'test',
    md5: 'cf889b927f9f53d164622a99378bf39d',
    note: '1 页，文本层含 “Issue 15893 - password”',
  },
  {
    file: 'issue6010_1.pdf',
    password: 'abc',
    md5: 'b58adce5dbb08936ddb0d904f0da8716',
    note: '1 页，文本层含 “Issue 6010”',
  },
];

/** 从 Windows 注册表读取系统代理（Node 的 fetch 不会自动使用 IE 代理） */
function readWindowsProxy() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const match = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (!match) return [];
    const value = match[1].trim();
    // 形如 "127.0.0.1:7897" 或 "http=...;https=..."
    const part = value.includes('=') ? (value.match(/https=([^;]+)/i)?.[1] ?? '') : value;
    return part ? [`http://${part.replace(/^https?:\/\//, '')}`] : [];
  } catch {
    return [];
  }
}

function listProxies() {
  const fromEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .map((key) => process.env[key])
    .filter(Boolean)
    .map((value) => value.replace(/^socks/i, 'http'));
  return [...new Set([...fromEnv, ...readWindowsProxy()])];
}

/** 通过 HTTP CONNECT 隧道下载（https 模块 + 自建 Agent） */
function createProxyAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  class ConnectAgent extends https.Agent {
    createConnection(options, callback) {
      const target = `${options.host}:${options.port || 443}`;
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: target,
        headers: { Host: target },
      });
      req.setTimeout(12000, () => req.destroy(new Error('proxy CONNECT timeout')));
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          callback(new Error(`proxy CONNECT ${res.statusCode}`));
          return;
        }
        callback(null, tls.connect({ socket, servername: options.servername || options.host }));
      });
      req.on('error', callback);
      req.end();
    }
  }
  return new ConnectAgent({ keepAlive: false });
}

/** 下载到内存；超时、重定向与代理都在这里处理 */
function download(url, { proxy, timeoutMs = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'pdf-h5-react-make-samples/1.0',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      },
    };
    if (proxy) options.agent = createProxyAgent(proxy);
    const req = https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        resolve(download(next, { proxy, timeoutMs, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > LIMITS.encryptedBytes * 4) {
          res.destroy();
          reject(new Error('响应过大，放弃'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

const md5 = (buffer) => crypto.createHash('md5').update(buffer).digest('hex');

/** 用 pdf.js 校验：无密码必须失败，有密码能打开 */
async function checkEncrypted(buffer, password) {
  let withoutPassword = 'opened';
  try {
    const task = getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const doc = await task.promise;
    withoutPassword = `opened(${doc.numPages}p)`;
    await task.destroy();
  } catch (error) {
    withoutPassword = `${error.name}/${error.code ?? '-'}`;
  }
  if (!withoutPassword.startsWith('PasswordException')) {
    return { ok: false, reason: `无密码也能打开（${withoutPassword}），不是加密文件` };
  }
  try {
    const task = getDocument({
      data: new Uint8Array(buffer),
      password,
      verbosity: 0,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const doc = await task.promise;
    const pages = doc.numPages;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join('').trim();
    await task.destroy();
    return { ok: true, pages, text, withoutPassword };
  } catch (error) {
    return { ok: false, reason: `密码 ${password} 打开失败：${error.name} ${error.message}` };
  }
}

async function fetchEncrypted() {
  const deadline = Date.now() + 45000; // 整体预算，失败就优雅跳过
  const proxies = listProxies();
  const transports = [{ label: '直连' }, ...proxies.map((proxy) => ({ label: `代理 ${proxy}`, proxy }))];

  for (const candidate of ENCRYPTED_CANDIDATES) {
    for (const base of ENCRYPTED_BASES) {
      for (const transport of transports) {
        if (Date.now() > deadline) {
          return { ok: false, reason: `下载超过 45 秒预算，跳过（已尝试 ${candidate.file}）` };
        }
        const url = base + candidate.file;
        let buffer;
        try {
          buffer = await download(url, { proxy: transport.proxy, timeoutMs: 12000 });
        } catch (error) {
          continue;
        }
        if (buffer.length === 0 || buffer.length >= LIMITS.encryptedBytes) continue;
        if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') continue;
        if (candidate.md5 && md5(buffer) !== candidate.md5) {
          log(`[warn] ${candidate.file} md5 不匹配，忽略该来源`);
          continue;
        }
        const check = await checkEncrypted(buffer, candidate.password);
        if (!check.ok) {
          log(`[warn] ${candidate.file} 校验失败：${check.reason}`);
          continue;
        }
        await fs.mkdir(OUT_DIR, { recursive: true });
        const filePath = path.join(OUT_DIR, 'encrypted.pdf');
        await fs.writeFile(filePath, buffer);
        log(
          `[build] encrypted.pdf ${check.pages} 页  ${buffer.length} 字节（${kb(buffer.length)}）  ` +
            `密码：“${candidate.password}”  来源：${transport.label} ${url}`,
        );
        return {
          ok: true,
          filePath,
          bytes: buffer.length,
          pages: check.pages,
          password: candidate.password,
          source: url,
          transport: transport.label,
          md5: md5(buffer),
          note: candidate.note,
        };
      }
    }
  }
  return { ok: false, reason: `所有候选与传输方式均失败（直连${proxies.length ? ` + 代理 ${proxies.length} 个` : '，未检测到代理'}）` };
}

// ---------------------------------------------------------------------------
// 自检：用 pdfjs-dist 在 Node 中打开生成的文件
// ---------------------------------------------------------------------------

function pdfjsOptions(extra = {}) {
  return {
    verbosity: 0,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    ...extra,
  };
}

async function openPdf(filePath, extra = {}) {
  const data = new Uint8Array(await fs.readFile(filePath));
  const task = getDocument(pdfjsOptions({ data, ...extra }));
  const doc = await task.promise;
  return { doc, task };
}

const firstChars = (text, n = 60) => text.slice(0, n).replace(/\s+/g, ' ');

/**
 * 计算文本项在视口（设备）坐标系里的包围盒。
 *
 * pdf.js 的 item.transform 位于 PDF 用户空间，item.width / item.height 则是
 * 「字号已计入」的宽度/高度值。需要先把视图矩阵与文本矩阵相乘，再用变换后的
 * 单位方向向量拼出四个角点；直接乘 transform 会把字号缩放算两遍。
 */
function collectTextBounds(item, viewport) {
  const m1 = viewport.transform;
  const m2 = item.transform;
  const d = [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
  const [a, b, c, c2, e, f] = d;
  const lenX = Math.hypot(a, b) || 1;
  const lenY = Math.hypot(c, c2) || 1;
  const ux = a / lenX;
  const uy = b / lenX;
  const vx = c / lenY;
  const vy = c2 / lenY;
  const w = item.width;
  const h = item.height;
  const corners = [
    [e, f],
    [e + ux * w, f + uy * w],
    [e + vx * h, f + vy * h],
    [e + ux * w + vx * h, f + uy * w + vy * h],
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

async function verifyDemoZh(state) {
  const { filePath, pages, outline } = state;
  const { doc, task } = await openPdf(filePath);
  const report = { checks: [], ok: true };
  const record = (label, passed, detail) => {
    report.checks.push({ label, passed, detail });
    if (!passed) report.ok = false;
  };

  record('页数', doc.numPages === pages, `${doc.numPages} 页（期望 ${pages}）`);

  // 大纲
  const tree = (await doc.getOutline()) ?? [];
  const countAll = (items) => items.reduce((n, item) => n + 1 + countAll(item.items ?? []), 0);
  const topTitles = tree.map((item) => item.title);
  const totalItems = countAll(tree);
  record(
    '大纲一级条目 ≥ 6',
    tree.length >= 6,
    `${tree.length} 个一级项 / 共 ${totalItems} 条：${topTitles.join(' / ')}`,
  );
  record('大纲条目数', totalItems === outline.total, `${totalItems} 条（期望 ${outline.total}）`);

  // 大纲目标页是否可解析
  const destPages = [];
  const walk = (items) => {
    for (const item of items) {
      if (Array.isArray(item.dest)) destPages.push(item.dest);
      if (item.items?.length) walk(item.items);
    }
  };
  walk(tree);
  let resolved = 0;
  for (const dest of destPages) {
    try {
      await doc.getPageIndex(dest[0]);
      resolved += 1;
    } catch {
      /* 解析失败计入下方断言 */
    }
  }
  record('大纲目标页可解析', resolved === destPages.length, `${resolved}/${destPages.length} 条 /Dest 指向有效页面`);

  // 第 1 页文本层
  const page1 = await doc.getPage(1);
  const text1 = (await page1.getTextContent()).items.map((item) => item.str).join(' ');
  const preview = firstChars(text1, 60);
  record('第 1 页文本层可提取', /[\u4e00-\u9fa5]/.test(text1) && text1.includes('pdf-h5-react'), `"${preview}"`);

  // 页面尺寸 / 旋转
  const sizeOf = async (n) => {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height, rotate: page.rotate };
  };
  const p3 = await sizeOf(3);
  const p5 = await sizeOf(5);
  const p7 = await sizeOf(7);
  record(
    '第 3 页横向 A4',
    Math.abs(p3.width - 841.89) < 0.5 && Math.abs(p3.height - 595.28) < 0.5,
    `${p3.width} × ${p3.height}`,
  );
  record('第 5 页窄页 480×800', Math.abs(p5.width - 480) < 0.5 && Math.abs(p5.height - 800) < 0.5, `${p5.width} × ${p5.height}`);
  record(
    '第 7 页 /Rotate 90',
    p7.rotate === 90 && Math.abs(p7.width - 841.89) < 0.5 && Math.abs(p7.height - 595.28) < 0.5,
    `rotate=${p7.rotate}，显示尺寸 ${p7.width} × ${p7.height}`,
  );

  // 链接
  const page2 = await doc.getPage(2);
  const annots = await page2.getAnnotations();
  const links = annots.filter((annot) => annot.subtype === 'Link');
  const external = links.find((annot) => annot.url?.startsWith('https://mozilla.github.io/pdf.js'));
  const internal = links.find((annot) => Array.isArray(annot.dest));
  let internalTarget = null;
  if (internal) {
    try {
      internalTarget = await doc.getPageIndex(internal.dest[0]);
    } catch {
      internalTarget = null;
    }
  }
  record('外链存在', Boolean(external), external ? `${external.url}（矩形 ${external.rect.map((v) => Math.round(v)).join(',')}）` : '未找到');
  record('内链跳转到第 10 页', internalTarget === 9, internalTarget === null ? '未找到可解析的内链' : `目标页索引 ${internalTarget}（0 基）→ 第 ${internalTarget + 1} 页`);

  // 全页文本越界检查 + 文本层「豆腐块」检查
  // 字体缺字时 pdf-lib 会静默写入 U+0000，复制出来是乱码，必须当成错误。
  let overflowPages = 0;
  let textItems = 0;
  let nullChars = 0;
  const nullSamples = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let bad = false;
    for (const item of content.items) {
      if (!item.str) continue;
      const nuls = (item.str.match(/\u0000/g) ?? []).length;
      if (nuls) {
        nullChars += nuls;
        if (nullSamples.length < 3) nullSamples.push(`第 ${n} 页 ${JSON.stringify(item.str.slice(0, 16))}`);
      }
      if (!item.str.trim()) continue;
      textItems += 1;
      const b = collectTextBounds(item, viewport);
      const tol = 3;
      if (b.minX < -tol || b.minY < -tol || b.maxX > viewport.width + tol || b.maxY > viewport.height + tol) {
        bad = true;
        if (overflowPages < 3) {
          log(`[verify] 第 ${n} 页文本越界：${JSON.stringify(item.str.slice(0, 24))} bbox=${JSON.stringify(b)}`);
        }
      }
    }
    if (bad) overflowPages += 1;
    page.cleanup();
  }
  record('所有文本均在页面范围内', overflowPages === 0, `${doc.numPages} 页 / ${textItems} 个文本项，越界页 ${overflowPages}`);
  record(
    '文本层无缺字（U+0000）',
    nullChars === 0,
    nullChars === 0 ? '未发现缺字符' : `${nullChars} 个 U+0000：${nullSamples.join('；')}`,
  );

  // 文本层逐页可提取（中文）
  let pagesWithChinese = 0;
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join('');
    if (/[\u4e00-\u9fa5]/.test(text)) pagesWithChinese += 1;
    page.cleanup();
  }
  record('中文文本层覆盖', pagesWithChinese === doc.numPages, `${pagesWithChinese}/${doc.numPages} 页含中文`);

  const sizeMB = (await fs.stat(filePath)).size;
  record('体积 < 1.5 MB', sizeMB < LIMITS.demoBytes, `${mb(sizeMB)}（${sizeMB} 字节）`);

  await task.destroy();
  return report;
}

async function verifyLarge(state) {
  const { filePath, bytes, pages } = state;
  const { doc, task } = await openPdf(filePath);
  const report = { checks: [], ok: true };
  const record = (label, passed, detail) => {
    report.checks.push({ label, passed, detail });
    if (!passed) report.ok = false;
  };

  record('页数', doc.numPages === pages, `${doc.numPages} 页（期望 ${pages}）`);

  const page1 = await doc.getPage(1);
  const content = await page1.getTextContent();
  const text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
  record('第 1 页文本层', text.includes('Page 1'), `"${firstChars(text, 60)}"`);

  const last = await doc.getPage(doc.numPages);
  const lastText = (await last.getTextContent()).items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
  record('末页可读', lastText.includes(`Page ${pages}`), `"${firstChars(lastText, 40)}"`);

  // 抽查中间页，确认每页只有一标题 + 三行
  const mid = await doc.getPage(150);
  const midText = (await mid.getTextContent()).items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
  record('第 150 页结构', midText.includes('Page 150') && midText.split('.').length >= 4, `"${firstChars(midText, 70)}"`);

  record('体积 < 800 KB', bytes < LIMITS.largeBytes, `${kb(bytes)}（${bytes} 字节）`);
  await task.destroy();
  return report;
}

async function verifyEncrypted(filePath, password) {
  const report = { checks: [], ok: true };
  const record = (label, passed, detail) => {
    report.checks.push({ label, passed, detail });
    if (!passed) report.ok = false;
  };
  const check = await checkEncrypted(await fs.readFile(filePath), password);
  record('无密码时要求密码', check.withoutPassword?.startsWith('PasswordException') ?? false, check.withoutPassword ?? check.reason);
  record('已知密码可打开', Boolean(check.ok), check.ok ? `${check.pages} 页，文本层 "${firstChars(check.text ?? '', 50)}"` : check.reason);
  return report;
}

function printReport(name, report) {
  log(`\n[verify] ${name}`);
  for (const check of report.checks) {
    log(`   ${check.passed ? '✓' : '✗'} ${check.label}：${check.detail}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  log('生成演示 PDF →', OUT_DIR);

  const demo = await buildDemoZh();
  const large = await buildLarge();
  const encrypted = await fetchEncrypted();

  const failures = [];

  const demoReport = await verifyDemoZh(demo);
  printReport('demo-zh.pdf', demoReport);
  if (!demoReport.ok) failures.push('demo-zh.pdf');

  const largeReport = await verifyLarge(large);
  printReport('large.pdf', largeReport);
  if (!largeReport.ok) failures.push('large.pdf');

  let encryptedReport = null;
  if (encrypted.ok) {
    encryptedReport = await verifyEncrypted(encrypted.filePath, encrypted.password);
    printReport('encrypted.pdf', encryptedReport);
    if (!encryptedReport.ok) failures.push('encrypted.pdf');
  } else {
    log(`\n[verify] encrypted.pdf 未生成：${encrypted.reason}`);
  }

  log('\n================ 汇总 ================');
  log(`demo-zh.pdf    ${demo.pages} 页   ${demo.bytes} 字节（${kb(demo.bytes)}）   大纲 ${demo.outline.total} 条（一级 ${demo.outline.topLevel}）`);
  log(`large.pdf      ${large.pages} 页   ${large.bytes} 字节（${kb(large.bytes)}）`);
  if (encrypted.ok) {
    log(`encrypted.pdf  ${encrypted.pages} 页   ${encrypted.bytes} 字节（${kb(encrypted.bytes)}）   密码：“${encrypted.password}”`);
    log(`               md5 ${encrypted.md5}   ${encrypted.note}`);
    log(`               来源 ${encrypted.source}（${encrypted.transport}）`);
  } else {
    log(`encrypted.pdf  未生成 —— ${encrypted.reason}`);
  }
  log('=====================================');

  if (failures.length) {
    throw new Error(`自检未通过：${failures.join(', ')}`);
  }
  log('\n全部自检通过。');
}

main().catch((error) => {
  console.error('\n[error]', error?.stack ?? error);
  process.exitCode = 1;
});
