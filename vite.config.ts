import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // L'URL des GitHub Pages de projet reprend le nom du dépôt : /portail/.
  base: '/portail/',
})
