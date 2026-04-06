import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [
    tailwindcss(),
    tsConfigPaths(),
    TanStackRouterVite(),
    react(),
  ],
  worker: {
    format: 'es',
  },
  server: {
    port: 7000,
    host: '0.0.0.0',
    allowedHosts: true,
  },
})
