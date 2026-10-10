import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { paraglideVitePlugin } from '@inlang/paraglide-js'


const dashboardDir = dirname(fileURLToPath(import.meta.url))
const localEnvDir = resolve(dashboardDir, '.')
const rootEnvDir = resolve(dashboardDir, '../..')
const envDir = existsSync(resolve(localEnvDir, '.env')) ? localEnvDir : rootEnvDir

export default defineConfig({
  envDir,
  envPrefix: ['VITE_', 'DISCORD_'],
  plugins: [
    svelte({
      experimental: {
        disableSvelteResolveWarnings: true,
      },
    }),
    tailwindcss(),
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
    }),
  ],
  server: {
    // Sites communautaires en développement : même relais que nginx en
    // production, l'API ne servant le site qu'à un dashboard connu.
    proxy: {
      '/s/': {
        target: process.env.VITE_API_URL || 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => `/api/site/render${path}`,
        headers: { 'X-Forwarded-Host': 'localhost:5173', 'X-Forwarded-Proto': 'http' },
      },
      '/robots.txt': {
        target: process.env.VITE_API_URL || 'http://localhost:8787',
        changeOrigin: true,
        rewrite: () => '/api/site/robots.txt',
      },
    },
  },
  optimizeDeps: {
    include: [
      'monaco-editor/esm/vs/editor/editor.api.js',
      'monaco-editor/esm/vs/editor/edcore.main.js',
    ],
  },
  worker: {
    format: 'es',
  },
  build: {
    // Le calcul de la taille gzip de chaque asset au build est purement
    // informatif et coute plusieurs secondes sur un projet de cette taille.
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Le registre n'importe désormais que les icônes réellement
          // utilisées. Garder Lucide dans un chunk stable permet à nginx de le
          // conserver un an entre deux déploiements du code applicatif.
          if (id.includes('node_modules/lucide-svelte')) {
            return 'vendor-icons'
          }
          return undefined
        },
      },
    },
  },
})
