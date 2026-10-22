import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const EMPTY_MODULE_ID = '\0empty-node-module';
const nodeOnlyFontPackages = new Set([
  'font-finder',
  'get-system-fonts',
  'promise-stream-reader'
]);
const nodeBuiltins = new Set(['fs', 'os', 'path', 'stream', 'util']);

function stubFontLigaturesNodeBranches(): Plugin {
  return {
    name: 'stub-font-ligatures-node-branches',
    enforce: 'pre',
    resolveId(source, importer) {
      if (nodeOnlyFontPackages.has(source)) {
        return EMPTY_MODULE_ID;
      }
      if (
        importer &&
        importer.replace(/\\/g, '/').includes('/node_modules/font-ligatures/') &&
        nodeBuiltins.has(source)
      ) {
        return EMPTY_MODULE_ID;
      }
    },
    load(id) {
      if (id === EMPTY_MODULE_ID) {
        return 'export default {};';
      }
    }
  };
}

export default defineConfig({
  plugins: [stubFontLigaturesNodeBranches(), react()],
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
