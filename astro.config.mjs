// @ts-check
import { defineConfig } from 'astro/config';

// Served at the root custom domain theleague.patrickflower.com, so base is '/'.
// Committed static assets (CNAME, favicon, box scores) live in ./static; the
// build output goes to ./public, which is gitignored.
export default defineConfig({
  site: 'https://theleague.patrickflower.com',
  base: '/',
  publicDir: './static',
  outDir: './public',
  build: { format: 'directory' },
});
