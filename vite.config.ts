import { defineConfig } from 'vite';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';

export default defineConfig({
  // IMPORTANT: This must match the GitHub repository name exactly.
  base: '/vwm-portal-lab/',
  plugins: [iwsdkDev()],
  server: {
    host: '0.0.0.0',
    open: false,
  },
});
