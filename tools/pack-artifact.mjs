/**
 * Pack the built app into one self-contained HTML file.
 *
 *   npm run pack   ->  dist-artifact/last-hit-trainer.html
 *
 * Everything is inlined — styles, the bundle, and every model and sound as a
 * base64 `data:` URL — for one reason: the page is meant to be published
 * somewhere with a strict content-security policy, where the only things it is
 * allowed to pull are scripts from a short CDN allowlist and stylesheets from
 * Google Fonts. A same-origin `fetch()` for a sprite sheet, or a `<script src>` next
 * to the page, is exactly the kind of request such a policy drops silently.
 * Inlining sidesteps the whole question. The sounds take the page from ~4.5MB
 * to ~11MB, still under the 16MB such hosts allow.
 *
 * The output is a fragment, not a document: no doctype, no <html>, no <head>.
 * Hosts that publish these wrap the file in their own skeleton, and a second
 * <html> inside that is a parse error waiting to happen. Serving the fragment
 * directly in a browser works anyway — the parser builds the missing elements.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'dist-artifact';
const OUT = join(OUT_DIR, 'last-hit-trainer.html');

execSync('npx vite build', { stdio: 'inherit' });

const assets = readdirSync('dist/assets');
const scripts = assets.filter((f) => f.endsWith('.js'));
const styles = assets.filter((f) => f.endsWith('.css'));

// An inline module cannot resolve a sibling chunk, so a split build would
// produce a page that loads and then does nothing. Fail loudly instead.
if (scripts.length !== 1) {
  throw new Error(`expected exactly one JS chunk to inline, found ${scripts.length}: ${scripts}`);
}
if (styles.length !== 1) {
  throw new Error(`expected exactly one CSS file to inline, found ${styles.length}: ${styles}`);
}

/**
 * `</script` inside the bundle would close the tag early. Escaping the slash is
 * safe: the sequence can only legally occur inside a string, template or regex,
 * and in all three `<\/` means `</`.
 */
const escapeClose = (code, tag) => code.split(`</${tag}`).join(`<\\/${tag}`);

const js = escapeClose(readFileSync(join('dist/assets', scripts[0]), 'utf8'), 'script');
const css = escapeClose(readFileSync(join('dist/assets', styles[0]), 'utf8'), 'style');
// Every sprite page, manifest and ground tile under public/sprites, keyed by
// its path under public/ as the loaders ask for it.
const models = {};
for (const f of readdirSync('public/sprites', { recursive: true })) {
  const path = `sprites/${f.split('\\').join('/')}`;
  const type = f.endsWith('.png') ? 'image/png' : f.endsWith('.json') ? 'application/json' : null;
  if (type) models[path] = `data:${type};base64,${readFileSync(join('public', path)).toString('base64')}`;
}
// The sounds ride the same map, keyed audio/<file>. The ambience loop is most
// of their 5MB; the whole page stays well under what a host accepts.
for (const f of readdirSync('public/audio').filter((f) => f.endsWith('.wav'))) {
  models[`audio/${f}`] = `data:audio/wav;base64,${readFileSync(join('public/audio', f)).toString('base64')}`;
}

// A charset declaration, even though a publishing host's own skeleton will
// carry one: the first meta in the document wins, so this is inert there and
// the difference between readable and mojibake anywhere the file is opened
// directly, where the parser would otherwise guess windows-1252.
const page = `<meta charset="utf-8" />
<title>Last Hit Trainer</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&display=swap"
/>
<style>
/* The host's own reset leaves the page a margin and a light ground; the drill
   is a full-bleed dark canvas and wants neither. */
html,
body {
  height: 100%;
  margin: 0;
  overflow: hidden;
}
${css}
</style>

<div id="app">
  <canvas id="game"></canvas>
  <div id="overlay"></div>
</div>

<script>
  // The sprites and sounds, inlined. main.ts reads these and the loaders decode them
  // rather than fetching them.
  window.__LHT_MODELS__ = ${JSON.stringify(models)};
</script>
<script type="module">
${js}
</script>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, page);
console.log(`wrote ${OUT} (${(statSync(OUT).size / 1024).toFixed(0)} KB)`);
