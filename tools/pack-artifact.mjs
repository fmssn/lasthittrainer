/**
 * Pack the built app into one self-contained HTML file.
 *
 *   npm run pack   ->  dist-artifact/last-hit-trainer.html
 *
 * Everything is inlined — styles, the bundle, and every model as a base64
 * `data:` URL — for one reason: the page is meant to be published somewhere
 * with a strict content-security policy, where the only things it is allowed to
 * pull are scripts from a short CDN allowlist and stylesheets from Google
 * Fonts. A same-origin `fetch()` for the GLB, or a `<script src>` next to the
 * page, is exactly the kind of request such a policy drops silently. Inlining
 * sidesteps the whole question, and at ~4.5MB the page is nowhere near any
 * size limit worth worrying about.
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
// Every GLB under public/models, keyed by its path under public/ as main.ts
// asks for it.
const glbs = [
  'models/melee_creep.glb',
  ...['units', 'heroes'].flatMap((dir) =>
    readdirSync(`public/models/${dir}`)
      .filter((f) => f.endsWith('.glb'))
      .map((f) => `models/${dir}/${f}`),
  ),
];
const models = Object.fromEntries(
  glbs.map((p) => [p, `data:model/gltf-binary;base64,${readFileSync(join('public', p)).toString('base64')}`]),
);

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
  // The models, inlined. main.ts reads these and hands them to a glTF parser
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
