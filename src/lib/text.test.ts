import { describe, expect, it } from 'vitest';
import { estimateFallback, findInPage, makeSnippet, splitSnippet } from './text';

describe('text 工具', () => {
  it('片段截取并标记命中', () => {
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const snippet = makeSnippet(text, 10, 13, 2);
    expect(snippet).toBe('…IJ\u0000KLM\u0000NO…');
    const parts = splitSnippet(snippet);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['KLM']);
    expect(parts.map((p) => p.text).join('')).toBe('…IJKLMNO…');
  });

  it('短文本不加省略号', () => {
    expect(makeSnippet('hello world', 6, 11, 20)).toBe('hello \u0000world\u0000');
  });

  it('跨文本项搜索：定位所属 item 与偏移', () => {
    const items = [
      { str: '第一章 ', start: 0 },
      { str: 'PDF 渲染', start: 4 },
      { str: ' 与懒加载', start: 11 },
    ];
    const joined = items.map((i) => i.str).join('');
    const hits = findInPage(3, items, joined, 'pdf');
    expect(hits).toHaveLength(1);
    expect(hits[0].pageNumber).toBe(3);
    expect(hits[0].itemIndex).toBe(1);
    expect(hits[0].start).toBe(4);
    expect(hits[0].end).toBe(7);
  });

  it('忽略大小写、可多次命中、空查询返回空', () => {
    const items = [{ str: 'A a a', start: 0 }];
    expect(findInPage(1, items, 'A a a', 'a')).toHaveLength(3);
    expect(findInPage(1, items, 'A a a', 'A')).toHaveLength(3);
    expect(findInPage(1, items, 'A a a', '')).toHaveLength(0);
  });

  it('尊重 limit', () => {
    const items = [{ str: 'xxxxx', start: 0 }];
    expect(findInPage(1, items, 'xxxxx', 'x', 2)).toHaveLength(2);
  });

  it('fallback 用平均值，无数据时兜底 A4', () => {
    expect(estimateFallback([{ width: 600, height: 800 }, undefined, { width: 400, height: 400 }], 3)).toEqual({
      width: 500,
      height: 600,
    });
    const a4 = estimateFallback([], 1);
    expect(a4.width).toBeCloseTo(595.28);
  });
});
