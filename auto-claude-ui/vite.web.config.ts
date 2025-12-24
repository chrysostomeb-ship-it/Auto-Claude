/**
 * Vite config for Web build (non-Electron)
 *
 * Builds the renderer as a standard web app that connects to the Express server.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { copyFileSync } from 'fs';

export default defineConfig({
  plugins: [
    react(),
    // Copy web-specific index.html
    {
      name: 'copy-web-html',
      buildStart() {
        try {
          copyFileSync(
            path.resolve(__dirname, 'src/renderer/index.web.html'),
            path.resolve(__dirname, 'src/renderer/index.html.bak')
          );
        } catch {}
      }
    }
  ],

  root: path.resolve(__dirname, 'src/renderer'),

  build: {
    outDir: path.resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/index.web.html')
    }
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },

  // Mark as web mode
  define: {
    'process.env.IS_WEB': '"true"'
  },

  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true
      }
    }
  }
});
