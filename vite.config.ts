import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Demo / 开发服务器配置（库自身的构建见 vite.lib.config.ts）
export default defineConfig({
  plugins: [react()],
  resolve: {
    // demo 通过包名引用库，统一映射到 src，避免同一模块被打进两份（会导致模块级状态分裂）
    alias: {
      'pdf-h5-react': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
    dedupe: ['react', 'react-dom', 'pdfjs-dist'],
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5274,
    strictPort: true,
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    target: 'es2022',
  },
});
