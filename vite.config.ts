import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so a built copy works from any path rather than only
  // from a server root. `import.meta.env.BASE_URL` follows, which is what the
  // creep rig's URL is built from.
  base: './',
});
