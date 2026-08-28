import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // Build stamp for the Settings → About page — generated from the current
  // build, never hand-edited. YYYY.MM.DD of the moment the bundle was built.
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10).replace(/-/g, '.')),
  },
  plugins: [react()],
  publicDir: 'public',
  resolve: {
    alias: {
      'react-quill': path.resolve(__dirname, './node_modules/react-quill'),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    strictPort: true,
    allowedHosts: true,
    hmr: {
      protocol: 'wss',
      host: undefined,
      clientPort: 443,
    },
  },
});
