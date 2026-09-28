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
import { chromiumPath } from './chromium.mjs';

const label = process.argv[2] ?? 'shot';
/** Game-clock seconds before the lane shot. The waves leave at 0:00 and meet about eight seconds later. */
const seconds = Number(process.argv[3] ?? 14);
const dir = process.env.SHOTS ?? 'shots';
const url = process.env.URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({
  executablePath: chromiumPath(),
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
    heroId: 'frost_archer',
    // A real opening buy, so the HUD inventory and the results strip are in frame.
    items: ['tango', 'tango', 'quelling_blade', 'iron_branch', 'iron_branch', 'magic_stick'],
    waves: 20,
    deniesEnabled: true,
    enemyHero: true,
    enemyHeroId: 'swordmaster',
    enemyDifficulty: 3,
    aggroEnabled: true,
    // Fixed, so two runs of this script frame the same moment of the same lane.
    seed: 4242,
  });
});
// Walk up to the lane during the countdown, as a player would; the camera
// follows the hero, and the hero starts behind its tower.
await page.evaluate(() => {
  const w = window.__lht.world;
  w.orderMove(w.player, { x: 2600, y: 0 });
});
// On the lane's clock, which starts at minus the countdown, so a slow frame
// under SwiftShader cannot move the moment that is framed.
await page.waitForFunction((s) => window.__lht.world.time >= s, seconds, { timeout: 120000 });
await page.screenshot({ path: `${dir}/${label}-lane.png` });

// End the run to catch the results screen, which is otherwise only reachable
// by waiting out the whole drill.
await page.evaluate(() => window.__lht.finish());
await page.waitForTimeout(400);
await page.screenshot({ path: `${dir}/${label}-results.png` });

console.log(`wrote ${dir}/${label}-{menu,lane,results}.png`);
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
