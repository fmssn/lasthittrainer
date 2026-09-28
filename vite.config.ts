import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so a built copy works from any path rather than only
  // from a server root. `import.meta.env.BASE_URL` follows, which is what the
  // creep rig's URL is built from.
  base: './',
  server: {
    // Loopback only: the tailnet reaches the dev server through `tailscale
    // serve` forwarding 5173-5175 here, so nothing on the LAN or beyond
    // can. An explicit address also stops Node picking ::1 for "localhost",
    // which the forwarder would miss.
    host: '127.0.0.1',
    // Vite refuses unknown Host headers; the tailnet's MagicDNS names end
    // in .ts.net.
    allowedHosts: ['.ts.net'],
  },
});
