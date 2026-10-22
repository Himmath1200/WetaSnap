import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  server: {
    // 0.0.0.0 so a phone on the same Wi-Fi can open the app.
    host: '0.0.0.0',
    // Allow Cloudflare quick-tunnel hosts (each run gets a new random subdomain).
    allowedHosts: true,
    watch: {
      // Playwright writes traces and screenshots here while a run is in progress; watching them
      // sends the dev server into a reload loop and the site stops answering.
      // Test sources are never bundled, so saving them must not reload the app mid-run either.
      ignored: ['**/e2e/.results/**', '**/e2e/.report/**', '**/e2e/*.ts', '**/dist/**', '**/docs/**'],
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  plugins: [
    preact(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'logo.png', 'push-sw.js'],
      manifest: {
        name: 'WeTa Snap',
        short_name: 'WeTa Snap',
        description: 'Scan business cards at exhibitions — online or offline.',
        theme_color: '#047857',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // onnx + wasm are the Pro scanner's detector (model + ONNX Runtime, both
        // lazy-loaded). Precached so detection still works on a cold offline launch.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest,onnx,wasm}'],
        // Admin-only extras stay out of the installed app; they load on demand (§8.1).
        globIgnores: ['**/exceljs*', '**/tesseract*', '**/jspdf*', '**/html2canvas*', '**/index.es*', '**/purify*'], // the API chunk stays cached — the app must work offline
        // The ORT wasm runtime alone is ~11 MB (URS §8.1 allows 2 MB installed for the
        // core app; the Pro scanner is the one opt-in feature that exceeds it).
        maximumFileSizeToCacheInBytes: 20_000_000,
        navigateFallback: '/index.html',
        importScripts: ['push-sw.js'], // push + notification click handling
      },
    }),
  ],
});
