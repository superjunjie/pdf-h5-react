/**
 * 构建后清理 dist。
 *
 * vite-plugin-dts 会把 src 下所有 .ts 的类型声明都产出，包括测试文件
 * （内容都是空声明 `export {}`），它们对使用方毫无意义，只会增加包体积和困惑。
 * 这里在构建后删掉，顺带校验关键产物是否存在 —— 缺文件时直接失败，
 * 避免把半成品发到 registry。
 *
 * 用法：node scripts/clean-dist.mjs
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist 不存在，请先运行 npm run build');
  process.exit(1);
}

/** 递归删除匹配的文件，返回删除数量 */
async function removeMatching(dir, predicate) {
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await removeMatching(full, predicate);
    } else if (predicate(entry.name)) {
      await rm(full);
      removed += 1;
    }
  }
  return removed;
}

const removedCount = await removeMatching(dist, (name) => /\.test\.(d\.ts|d\.mts|js|js\.map)$/.test(name));
console.log(`清理测试残留声明：${removedCount} 个`);

// 移除 sourcemap：它内嵌完整源码，占包体 60% 以上（287KB / 445KB）。
// 源码在 GitHub 上本就公开，下载方不需要通过 map 才能调试；
// 卸载体积翻倍的代价换不来等价收益，因此发布产物只保留可运行文件。
// 本地开发仍可用 `npm run build` 后回源码断点调试（vite 直接读 src）。
const removedMaps = await removeMatching(dist, (name) => name.endsWith('.map'));
console.log(`清理 sourcemap：${removedMaps} 个`);

// 关键产物校验：缺任何一个都不应发布
const required = [
  'index.js',
  'index.d.ts',
  'pdf-h5-react.css',
];
let missing = 0;
for (const file of required) {
  const full = join(dist, file);
  if (!existsSync(full)) {
    console.error(`✗ 缺少构建产物：dist/${file}`);
    missing += 1;
    continue;
  }
  const size = (await stat(full)).size;
  console.log(`✓ dist/${file}  ${(size / 1024).toFixed(1)} KB`);
}

if (missing > 0) {
  console.error(`\n构建产物不完整（缺 ${missing} 个），中止。`);
  process.exit(1);
}
console.log('\ndist 已就绪。');
