import { defineConfig } from 'vite';

// GitHub Pages sert le site sous /<repo>/ (ex. /accessibility-map-fr/).
// Surchargeable via VITE_BASE pour un domaine custom ou un preview local.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/accessibility-map-fr/',
  build: {
    target: 'es2021',
    sourcemap: false,
  },
});
