import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The replay inspector (Phase 7 B5): one static route, no runtime network
// beyond its own files. `base: './'` lets dist/ be served from any path (or
// embedded in a sandboxed iframe, threat-model-arena.md §4.2).
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// The CSP goes in only for the build: the dev server injects <style> tags.
// (frame-ancestors cannot be set from a meta tag; the host must send it.)
const csp = {
  name: 'inspector-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  base: './',
  plugins: [react(), csp],
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  test: { environment: 'happy-dom', include: ['test/**/*.test.{ts,tsx}'] },
});
