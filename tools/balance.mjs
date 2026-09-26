/**
 * Difficulty calibration for the enemy laner.
 *
 *   npm run dev          # in another shell
 *   node tools/balance.mjs
 *
 * Drives *both* heroes with the same laning AI and holds your side at a fixed
 * middling skill, so the only thing changing down the table is the opponent.
 * That makes two things checkable that nothing else here can check:
 *
 *   - the ladder is monotonic, i.e. profile 1..5 actually get harder
 *   - the lane has no side bias, i.e. level 3 against level 3 comes out even
 *
 * The second is the one worth keeping. A drill where Radiant quietly farms
 * better than Dire would flatter you for three minutes and teach you nothing,
 * and no amount of staring at the code finds that — it only shows up in a
 * symmetric run.
 *
 * Reports averages over a few fixed seeds; it is a measurement, not a pass/fail.
 */
import { chromium } from 'playwright';
import { chromiumPath } from './chromium.mjs';

const url = process.env.URL ?? 'http://localhost:5173/';
const SEEDS = [3, 17, 42];
const MINUTES = 3;

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });

const rows = await page.evaluate(
  async ({ seeds, minutes }) => {
    const { World } = await import('/src/sim/world.ts');
    const { DEFAULT_CONFIG, ENEMY_PROFILES } = await import('/src/sim/config.ts');
    const { EnemyHeroAi } = await import('/src/sim/ai/enemyHeroAi.ts');

    const out = [];
    for (const d of [1, 2, 3, 4, 5]) {
      const acc = { plh: 0, pdn: 0, elh: 0, edn: 0, deaths: 0 };
      for (const seed of seeds) {
        const w = new World({
          ...DEFAULT_CONFIG,
          // Same hero both sides: the row is about the profile, not the matchup.
          heroId: 'frost_archer',
          enemyHeroId: 'frost_archer',
          enemyDifficulty: d,
          // Six waves on a three-minute cap is the window the recorded
          // readings were taken over: the lane is cut off with the sixth
          // wave still fighting, rather than farmed out to the end.
          waves: minutes * 2,
          seed,
        });
        const me = new EnemyHeroAi(w.player, ENEMY_PROFILES[3]);
        for (let i = 0; i < minutes * 60 * 120 && !w.finished; i++) {
          if (w.player.alive) me.update(w, 1 / 120);
          w.step(1 / 120);
        }
        acc.plh += w.stats.lastHits;
        acc.pdn += w.stats.denies;
        acc.elh += w.stats.enemyLastHits;
        acc.edn += w.stats.enemyDenies;
        acc.deaths += w.stats.deaths;
      }
      const n = seeds.length;
      out.push({
        d,
        plh: acc.plh / n,
        pdn: acc.pdn / n,
        elh: acc.elh / n,
        edn: acc.edn / n,
        deaths: acc.deaths / n,
      });
    }
    return out;
  },
  { seeds: SEEDS, minutes: MINUTES },
);

await browser.close();

const f = (v) => v.toFixed(1).padStart(7);
console.log(`${MINUTES} min, both sides driven by the level-3 AI, mean of ${SEEDS.length} seeds\n`);
console.log('opponent   yourLH   yourDN  theirLH  theirDN   deaths');
for (const r of rows) {
  console.log(`       ${r.d}  ${f(r.plh)}  ${f(r.pdn)}  ${f(r.elh)}  ${f(r.edn)}  ${f(r.deaths)}`);
}

const even = rows.find((r) => r.d === 3);
const gap = Math.abs(even.plh - even.elh);
console.log(`\nlevel 3 vs level 3 gap: ${gap.toFixed(1)} last hits (want ~0 — a bigger gap is side bias)`);
const ladder = rows.map((r) => r.elh);
const monotonic = ladder.every((v, i) => i === 0 || v >= ladder[i - 1] - 0.5);
console.log(`ladder ${monotonic ? 'is' : 'is NOT'} monotonic: ${ladder.map((v) => v.toFixed(1)).join(' -> ')}`);
