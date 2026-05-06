import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const cadProxyTarget = env.VITE_CAD_BACKEND_PROXY_TARGET || 'http://localhost:4000';

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['vite.svg', 'pwa-192x192.png', 'pwa-512x512.png'],
        manifest: {
          name: 'Survey Calculator Suite',
          short_name: 'SurveyCalc',
          description: 'Professional geomatics survey calculation and CAD visualization tool',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'landscape',
          start_url: '/',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,woff2}'],
          runtimeCaching: [
            {
              // Never cache CAD API calls — always network
              urlPattern: /^.*\/api\/cad\/.*/,
              handler: 'NetworkOnly',
            },
            {
              // Geoid files: long-lived, cache-first
              urlPattern: /\/geoid\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'geoid-v1',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              // Static background images: cache-first
              urlPattern: /\/backgrounds\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'backgrounds-v1',
                expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 7 },
              },
            },
          ],
        },
      }),
    ],
    server: {
      // Enable proper handling of range requests for large static files (geoid TIFs)
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range'
      },
      middlewareMode: false,
      // Enable CORS for range requests
      cors: {
        origin: '*',
        methods: ['GET', 'HEAD', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Range'],
        credentials: false
      },
      proxy: {
        '/api/cad': {
          target: cadProxyTarget,
          changeOrigin: true,
        }
      }
    },
    resolve: {
      alias: {
        buffer: 'buffer/'
      }
    },
    define: {
      'global': 'globalThis'
    },
    optimizeDeps: {
      exclude: ['cesium'],
      include: ['buffer']
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            proj4: ['proj4'],
            geotiff: ['geotiff'],
            cesium: ['cesium'],
            three: ['three', 'react-globe.gl'],
            leaflet: ['leaflet', 'react-leaflet'],
            xlsxParsers: ['shpjs', 'jszip', 'xlsx'],
            mathjs: ['mathjs'],
          }
        }
      },
      // Cesium/geospatial libraries produce intentionally large chunks in this app.
      // Raise the warning limit so Vercel logs focus on actionable issues.
      chunkSizeWarningLimit: 5000
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.js'],
      include: ['src/**/*.test.{js,jsx}'],
      coverage: {
        provider: 'v8',
        include: ['src/utils/**', 'src/Components/**'],
        exclude: ['src/test/**'],
      },
    }
  };
})
