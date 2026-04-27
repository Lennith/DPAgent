import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const reactVendorPattern = /[\\/]node_modules[\\/](react|react-dom)[\\/]/;
const highlightVendorPattern = /[\\/]node_modules[\\/](highlight\.js|lowlight)[\\/]/;
const markdownVendorPattern =
  /[\\/]node_modules[\\/](react-markdown|remark-gfm|remark-parse|remark-rehype|unified|vfile|micromark|mdast-util-[^\\/]+|hast-util-[^\\/]+|unist-util-[^\\/]+|property-information|space-separated-tokens|comma-separated-tokens|character-entities[^\\/]*|decode-named-character-reference|html-void-elements|bail|trough)[\\/]/;

export default defineConfig({
  plugins: [react()],
  root: 'src/web/client',
  build: {
    outDir: '../../../dist/web/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }
          if (reactVendorPattern.test(id)) {
            return 'react-vendor';
          }
          if (highlightVendorPattern.test(id)) {
            return 'highlight-vendor';
          }
          if (markdownVendorPattern.test(id)) {
            return 'markdown-vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 53722,
    strictPort: true,
    hmr: {
      port: 53723,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:53721',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:53721',
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/web/client'),
    },
  },
});
