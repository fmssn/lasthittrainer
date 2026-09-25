/**
 * Headless screenshot of the drill, for reviewing look-and-feel changes.
 *
 *   npm run dev                       # or vite preview, in another shell
 *   node tools/shot.mjs baseline 14
 *
 * Writes <label>-menu.png and <label>-lane.png to SHOTS (default ./shots), and
 * prints any console/page errors the run produced. Existing purely so a change
 * to the renderer can be looked at rather than reasoned about.
 */
import { chromium } from 'playwright';

const label = process.argv[2] ?? 'shot';
/** Seconds of drill to run before the lane shot, so a wave has formed. */
const seconds = Number(process.argv[3] ?? 14);
const dir = process.env.SHOTS ?? 'shots';
const url = process.env.URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({
  // The container ships Chromium at a revision this playwright build does not
  // expect, so point at it directly rather than downloading a second copy.
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
  // SwiftShader: there is no GPU here, and WebGL has to come from somewhere.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
// __lht is the dev-only handle main.ts exposes; it appears once boot() has the
// creep rig in memory, which is also the first moment there is anything to draw.
await page.waitForFunction(() => !!window.__lht, null, { timeout: 30000 });
await page.screenshot({ path: `${dir}/${label}-menu.png` });

await page.evaluate(() => {
  window.__lht.start({
    heroId: 'shadow_fiend',
    duration: 600,
    deniesEnabled: true,
    enemyHero: true,
    enemyHeroId: 'crystal_maiden',
    enemyDifficulty: 3,
    aggroEnabled: true,
    showKillableHighlight: true,
    showRangeRings: true,
    showDamagePreview: true,
    // Fixed, so two runs of this script frame the same moment of the same lane.
    seed: 4242,
  });
});
await page.waitForTimeout(seconds * 1000);
await page.screenshot({ path: `${dir}/${label}-lane.png` });

console.log(`wrote ${dir}/${label}-{menu,lane}.png`);
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
