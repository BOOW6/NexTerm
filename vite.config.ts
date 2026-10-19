import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('node_modules')) {
            return;
          }
          if (/\/(react|react-dom|scheduler)\//.test(normalized)) {
            return 'react';
          }
          if (normalized.includes('/@xterm/xterm/')) {
            return 'xterm';
          }
          if (normalized.includes('/@xterm/addon-search/')) {
            return 'xterm-search';
          }
          if (normalized.includes('/@xterm/')) {
            return 'xterm-addons';
          }
          if (normalized.includes('/dockview')) {
            return 'dockview';
          }
          if (normalized.includes('/@tauri-apps/')) {
            return 'tauri';
          }
          return 'vendor';
        }
      }
    }
  },
  server: {
    port: 1420,
    strictPort: true
  }
});
