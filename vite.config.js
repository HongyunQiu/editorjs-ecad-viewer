import { defineConfig } from 'vite';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'EcadViewerTool',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'ecadViewer.mjs' : 'ecadViewer.umd.js'),
    },
    rollupOptions: {
      external: [],
    },
  },
  plugins: [cssInjectedByJsPlugin(), dts({ insertTypesEntry: true })],
});
