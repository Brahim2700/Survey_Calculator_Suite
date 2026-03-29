import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
          cesium: ['cesium']
        }
      }
    },
    // Cesium/geospatial libraries produce intentionally large chunks in this app.
    // Raise the warning limit so Vercel logs focus on actionable issues.
    chunkSizeWarningLimit: 5000
  }
})
