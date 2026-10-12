import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the build works from any folder or sub-path (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Bananagram Solver',
        short_name: 'Bananagrams',
        description: 'Offline Bananagrams solver: snap your tiles, get a grid.',
        start_url: '.',
        display: 'standalone',
        background_color: '#fffbea',
        theme_color: '#f5c518',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // Precache everything, including the dictionaries, so the app runs with no network.
        globPatterns: ['**/*.{js,css,html,svg,png,txt}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
});
