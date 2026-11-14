import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// 组件库构建：ESM 输出 + 类型声明 + 单独抽出的样式文件
export default defineConfig({
  // 库产物不应包含 demo 的静态资源（public/ 里的示例 PDF 与 self-host 的 pdf.js）
  publicDir: false,
  plugins: [
    react(),
    dts({
      include: ['src'],
      tsconfigPath: './tsconfig.json',
      rollupTypes: false,
      insertTypesEntry: true,
      // 测试文件的类型声明没有意义（都是空声明），不要打进包
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'pdf-h5-react',
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'pdfjs-dist',
        /^pdfjs-dist\//,
      ],
    },
  },
});
