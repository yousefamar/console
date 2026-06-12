/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Vite serves plain HTTP; Caddy terminates TLS for con.amar.io in front.
export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    allowedHosts: true,
    headers: {
      'Cache-Control': 'no-store',
      // Opt into the JS Self-Profiling API so we can capture call-stack
      // samples via `new Profiler(...)` from debug/eval.
      'Document-Policy': 'js-profiling',
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
