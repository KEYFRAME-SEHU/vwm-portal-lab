import { defineConfig, loadEnv } from 'vite';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the site from /<repo name>/, so the default must match
  // the GitHub repository name exactly. Hosts that serve from the domain root
  // (Render, see render.yaml) set BASE_PATH=/.
  base: loadEnv(mode, '.', '').BASE_PATH || '/vwm-portal-lab/',
  plugins: [iwsdkDev()],
  server: {
    host: '0.0.0.0',
    open: false,
  },
}));
