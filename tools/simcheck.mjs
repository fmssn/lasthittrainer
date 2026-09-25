/**
 * Headless assertions against the simulation.
 *
 *   npm run dev          # in another shell
 *   node tools/simcheck.mjs
 *
 * There is no test runner in this project and adding one would drag in a
 * toolchain, so this borrows the one the screenshot harness already uses: vite
 * is already transforming the TypeScript, so the checks just import the real
 * modules in the page and compare numbers. Exits non-zero on the first failure,
 * which is all a pre-commit gate needs.
 *
 * The reference values are Valve's own, from npc_units.txt and
 * scripts/npc/heroes/*.txt, worked through Dota's published attribute rules.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });

const results = await page.evaluate(async () => {
  const out = [];
  const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
  const check = (name, actual, expected, eps) => {
    const ok = typeof expected === 'number' ? near(actual, expected, eps ?? 0.005) : actual === expected;
    out.push({ name, ok, actual, expected });
  };

  const heroes = await import('/src/sim/heroes.ts');
  const units = await import('/src/sim/units.ts');
  const constants = await import('/src/sim/constants.ts');
  const { World } = await import('/src/sim/world.ts');
  const { DEFAULT_CONFIG } = await import('/src/sim/config.ts');

  // --- Dota formulas ------------------------------------------------------
  // Melee creep armor 2 -> 1 - (0.06*2)/(1+0.12) = 0.892857
  check('armorMultiplier(2)', constants.armorMultiplier(2), 0.892857, 1e-5);
  check('armorMultiplier(0)', constants.armorMultiplier(0), 1, 1e-9);
  // Turn rate is radians per 0.03s, so 180 degrees at 0.6 takes 0.03*PI/0.6.
  check('180deg turn at 0.6', Math.PI / constants.turnSpeed(0.6), 0.157, 0.001);

  // --- Lane creeps, straight from npc_units.txt ---------------------------
  const melee = units.MELEE_CREEP;
  check('melee hp', melee.maxHp, 550);
  check('melee armor', melee.armor, 2);
  check('melee dmg min', melee.damageMin, 19);
  check('melee dmg max', melee.damageMax, 23);
  check('melee attack point', melee.attackPoint, 0.467);
  check('melee BAT', melee.baseAttackTime, 1.0);
  check('melee bounty', `${melee.bountyMin}-${melee.bountyMax}`, '34-39');
  check('melee xp', melee.xp, 57);

  const ranged = units.RANGED_CREEP;
  check('ranged hp', ranged.maxHp, 300);
  check('ranged armor', ranged.armor, 0);
  check('ranged regen', ranged.hpRegen, 2);
  check('ranged dmg', `${ranged.damageMin}-${ranged.damageMax}`, '21-26');
  check('ranged attack point', ranged.attackPoint, 0.5);
  check('ranged projectile', ranged.projectileSpeed, 900);
  check('ranged xp', ranged.xp, 69);

  const siege = units.SIEGE_CREEP;
  check('siege hp', siege.maxHp, 935);
  check('siege dmg', `${siege.damageMin}-${siege.damageMax}`, '35-46');
  check('siege attack point', siege.attackPoint, 0.7);
  check('siege BAT', siege.baseAttackTime, 3.0);

  const tower = units.TOWER;
  check('tower armor', tower.armor, 12);
  check('tower dmg', `${tower.damageMin}-${tower.damageMax}`, '88-92');
  check('tower BAT', tower.baseAttackTime, 0.9);
  check('tower attack point', tower.attackPoint, 0.6);

  // --- Acquisition ranges -------------------------------------------------
  check('acq melee', constants.acquisitionRange('melee_creep'), 500);
  check('acq ranged', constants.acquisitionRange('ranged_creep'), 600);
  check('acq siege', constants.acquisitionRange('siege_creep'), 800);
  check('acq tower', constants.acquisitionRange('tower'), 700);

  // --- Level 1 heroes, derived from attributes ----------------------------
  // Shadow Fiend: 16-22 base + 25 agi, 120 + 19*22 hp, 25 IAS, BAT 1.6.
  const sf = heroes.heroById('shadow_fiend');
  check('SF damage', `${sf.damageMin}-${sf.damageMax}`, '41-47');
  check('SF hp', sf.maxHp, 538);
  check('SF armor', sf.armor, 4.175, 0.001);
  check('SF attack speed', sf.attackSpeedBonus, 25);
  check('SF interval', constants.attackInterval(sf.baseAttackTime, sf.attackSpeedBonus), 1.28, 0.001);
  check('SF windup', constants.attackPointTime(sf.attackPoint, sf.attackSpeedBonus), 0.4, 0.001);

  // Juggernaut: 22-24 + 32 agi, authored 0.33 point but 0.25 in the lane.
  const jug = heroes.heroById('juggernaut');
  check('Jug damage', `${jug.damageMin}-${jug.damageMax}`, '54-56');
  check('Jug hp', jug.maxHp, 560);
  check('Jug windup', constants.attackPointTime(jug.attackPoint, jug.attackSpeedBonus), 0.25, 0.001);
  check('Jug interval', constants.attackInterval(jug.baseAttackTime, jug.attackSpeedBonus), 1.0606, 0.001);

  const sniper = heroes.heroById('sniper');
  check('Sniper damage', `${sniper.damageMin}-${sniper.damageMax}`, '40-46');
  check('Sniper windup', constants.attackPointTime(sniper.attackPoint, sniper.attackSpeedBonus), 0.1339, 0.001);

  const cm = heroes.heroById('crystal_maiden');
  check('CM damage', `${cm.damageMin}-${cm.damageMax}`, '48-54');
  check('CM hp', cm.maxHp, 494);

  const am = heroes.heroById('antimage');
  check('AM damage', `${am.damageMin}-${am.damageMax}`, '54-58');
  check('AM armor', am.armor, 6.175, 0.001);

  const drow = heroes.heroById('drow');
  check('Drow damage', `${drow.damageMin}-${drow.damageMax}`, '51-58');

  // --- Melee creeps hit heroes for 25% less -------------------------------
  {
    const w = new World({ ...DEFAULT_CONFIG, seed: 7, enemyHero: false });
    const creep = [...w.units.values()].find((u) => u.kind === 'melee_creep');
    const rangedCreep = [...w.units.values()].find((u) => u.kind === 'ranged_creep');
    const hero = w.player;
    const meleeToHero = w.expectedDamage(creep, hero);
    const meleeRaw = ((creep.damageMin + creep.damageMax) / 2) * constants.armorMultiplier(hero.armor);
    check('melee creep -25% vs hero', meleeToHero / meleeRaw, 0.75, 0.0001);
    const rangedToHero = w.expectedDamage(rangedCreep, hero);
    const rangedRaw = ((rangedCreep.damageMin + rangedCreep.damageMax) / 2) * constants.armorMultiplier(hero.armor);
    check('ranged creep full vs hero', rangedToHero / rangedRaw, 1, 0.0001);
  }

  // --- Determinism: same seed, same lane ----------------------------------
  {
    const run = () => {
      const w = new World({ ...DEFAULT_CONFIG, seed: 99, duration: 120 });
      for (let i = 0; i < 120 * 30; i++) w.step(1 / 120);
      return JSON.stringify(w.stats) + '|' + w.killLog.length;
    };
    check('deterministic replay', run(), run());
  }

  return out;
});

await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed++;
    console.log(`FAIL  ${r.name}: got ${r.actual}, want ${r.expected}`);
  }
}
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
