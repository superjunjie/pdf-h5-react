# pdf-h5-react

**极简** PDF 分页渲染 React 组件。基于 [pdf.js](https://mozilla.github.io/pdf.js/)。

只做一件事：把 PDF 加载出来、逐页渲染成 canvas、竖向连续滚动、按容器宽度适配。

```
加载 → 分页渲染 → 竖向滚动 → 按宽度适配 → 按需渲染可见页 → 双击放大
```

- 库产物 **10 KB**（gzip 约 3.3 KB），样式 **1.1 KB**
- 源码约 **700 行**，无状态管理、无事件系统、无 UI 控件
- `pdfjs-dist` 作为 peerDependency，不打包进来

---

## 安装

```bash
npm i pdf-h5-react pdfjs-dist
```

`react` / `react-dom` 是 peer 依赖，宿主项目已有则不会重复安装。

## 快速开始

```tsx
import { PdfViewer } from 'pdf-h5-react';
import 'pdf-h5-react/style.css';

export default function App() {
  return (
    <div style={{ height: '100dvh' }}>
      <PdfViewer src="/files/report.pdf" />
    </div>
  );
}
```

容器必须有确定高度（`height` 不能是 `auto`），组件会填满父容器。

### 自托管 pdf.js 资源（生产建议）

默认从 jsDelivr 加载与依赖版本一致的 worker / cmaps / 字体 / wasm，**零配置可运行**。
内网或不想依赖 CDN 时，把资源拷到自己的静态目录：

```bash
node node_modules/pdf-h5-react/scripts/copy-pdfjs-assets.mjs public/pdfjs
```

```ts
import { configurePdfjs } from 'pdf-h5-react';

configurePdfjs({
  workerSrc: '/pdfjs/build/pdf.worker.min.mjs',
  cMapUrl: '/pdfjs/cmaps/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
});
```

> worker 版本必须与 `pdfjs-dist` 一致，否则会抛 `API version does not match Worker version`。
> 上面的脚本按 `node_modules` 里的实际版本拷贝，并在目录下写 `VERSION` 文件。

---

## API

### `<PdfViewer />`

| Prop | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `src` | `PdfSource` | — | `string \| URL \| ArrayBuffer \| Uint8Array \| { url, data }` |
| `gap` | `number` | `8` | 页间距（px） |
| `padding` | `number` | `0` | 内容上下内边距（px） |
| `maxPixelRatio` | `number` | `2` | 画布像素比上限。**调低可显著省内存**，1 代最省、3 代最清晰 |
| `maxCanvasPixels` | `number` | `16777216` | 单页画布总像素上限（iOS Safari 安全值） |
| `maxCanvasDimension` | `number` | `8192` | 单页画布单边上限 |
| `zoomable` | `boolean` | `true` | 是否允许双击放大 |
| `doubleTapZoom` | `number` | `2` | 双击放大到的倍率 |
| `className` / `style` | — | — | 作用于滚动容器 |
| `onLoad` | `(doc, total) => void` | — | 文档加载完成 |
| `onProgress` | `(loaded, total) => void` | — | 加载进度 |
| `onPageChange` | `(page, total) => void` | — | 当前阅读页变化（1 基） |
| `onError` | `(error) => void` | — | 加载失败 |
| `renderLoading` | `() => ReactNode` | — | 自定义加载态 |
| `renderError` | `(error) => ReactNode` | — | 自定义错误态 |

### 导出的工具函数

版面与画布计算都是纯函数，可单独复用或自行实现 UI：

```ts
import {
  computeLayout,        // 计算每页位置与显示尺寸
  pageAtOffset,         // 给定滚动位置求当前页
  quantizePixelRatio,   // 设备像素比量化
  clampCanvasSize,      // 画布尺寸 + iOS 上限保护
  viewportScaleFor,     // 换算传给 page.getViewport 的 scale
  loadPdf,              // 拿到底层 pdf.js loading task
  pdfjsLib,             // 直接访问 pdfjs-dist
} from 'pdf-h5-react';
```

### 命令式 API

组件没有暴露 ref。需要跳页、缩放、搜索、批注等能力时，请用状态驱动：

```tsx
<PdfViewer key={fileId} src={url} />
```

换 `key` 即可整体重建（重载新文档）。

---

## 设计说明

### 双击放大

双击（或桌面端双击）在 **1 倍（按宽度适配）** 与 `doubleTapZoom`（默认 2 倍）之间切换，
以点击位置为锚点，放大后该处内容保持不动，并可横向滚动查看页面两侧。

实现上有意选择**放大布局宽度**而不是 CSS `transform: scale()`：

- 布局变宽 → 画布按新尺寸**重新渲染**，放大后文字依然清晰
- `transform` 只会把已渲染的位图拉伸，2 倍放大就发虚

代价是放大瞬间需要重渲染当前可见的几页（通常 3–5 页，约 100–300ms）。
位图缓存 key 里带了显示宽度，所以不会误用放大前的低分辨率图。

### 按需渲染

用 `IntersectionObserver` 监听每页占位元素，只渲染视口前后各一屏内的页面：

- 300 页文档实测同时只有 **3–5 个 canvas**
- 离开视口的页面立即卸载 canvas，内存不随页数增长
- 已渲染的位图放进 8 条 FIFO 缓存，回滚时不重复渲染

### 画布尺寸的三个量

这是 PDF 渲染最容易出错的地方，`src/layout.ts` 集中处理并加了测试：

| 量 | 含义 | 窄屏 A4 示例 |
| --- | --- | --- |
| `displayScale` | CSS 显示宽 / PDF 宽 | 0.62 |
| `pixelRatio` | 画布像素 / CSS 像素 | 2 |
| `viewportScale` | 画布像素 / PDF 单位 = `displayScale × pixelRatio` | 1.24 |

两个经典错误（都会导致**文字被截断**）：

1. 给 `displayScale` 加下限（如 `Math.max(scale, 1)`）—— 画布远大于显示区域，只看到左上角。
2. 把 `pixelRatio` 直接传给 `getViewport` —— 渲染内容比画布大 `1/displayScale` 倍，右侧被切掉。

单元测试里有两条断言专门锁这两个不变式。

---

## 开发

```bash
npm i
npm run assets     # 首次：准备 pdf.js 运行时资源（demo 用）
npm run dev        # http://127.0.0.1:5273
npm test           # 18 项单元测试
npm run build      # 构建库产物
```

浏览器验证（需先 `npm run build:demo && npm run preview`）：

```bash
node scripts/check.mjs
```

## 发布

推 `v*` tag 触发 GitHub Actions，通过 **Trusted Publishing (OIDC)** 发布到 npmjs，无需任何 Secret。

```bash
npm version 0.4.1 --no-git-tag-version
git commit -am "chore: release v0.4.1"
node scripts/publish-gh.mjs --tag 0.4.1
```

## 从 0.3.x 升级

**0.4.0 是破坏性重构**：移除了工具栏、文本层、搜索、目录、缩略图、批注、捏合缩放、事件系统与 LRU 缓存。

保留的是：分页渲染、竖向滚动、按宽度适配、按需渲染、**双击放大**。

如果仍需要被移除的能力，请锁定 `pdf-h5-react@0.3.1`。

## License

MIT