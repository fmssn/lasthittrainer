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
import { chromiumPath } from './chromium.mjs';

const url = process.env.URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({
  executablePath: chromiumPath(),
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

  // Juggernaut: 22-24 + 32 agi. `BaseAttackSpeed 110` in his hero file, so
  // 142 attack speed at level 1 and an authored 0.33 point is 0.232 in lane.
  const jug = heroes.heroById('juggernaut');
  check('Jug damage', `${jug.damageMin}-${jug.damageMax}`, '54-56');
  check('Jug hp', jug.maxHp, 560);
  check('Jug attack speed', jug.attackSpeedBonus, 42);
  check('Jug windup', constants.attackPointTime(jug.attackPoint, jug.attackSpeedBonus), 0.2324, 0.001);
  check('Jug interval', constants.attackInterval(jug.baseAttackTime, jug.attackSpeedBonus), 0.9859, 0.001);

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
  // Nobody else overrides BaseAttackSpeed, so agility is all of it.
  check('Drow attack speed', drow.attackSpeedBonus, 24);

  // --- Starting items, from items.txt -------------------------------------
  const items = await import('/src/sim/items.ts');
  {
    // Two branches are +2 agility on Jug: +2 damage, +2 attack speed, +0.334
    // armor, +44 HP. Quell adds nothing to the listed damage — it is creep-only.
    const j = heroes.heroById('juggernaut', ['quelling_blade', 'iron_branch', 'iron_branch']);
    check('Jug+QB+2IB damage', `${j.damageMin}-${j.damageMax}`, '56-58');
    check('Jug+QB+2IB attack speed', j.attackSpeedBonus, 44);
    check('Jug+QB+2IB hp', j.maxHp, 604);
    check('Jug+QB+2IB armor', j.armor, jug.armor + 0.334, 0.001);
    check('Jug quell (melee)', j.creepDamageBonus, 8);
    check('SF quell (ranged)', heroes.heroById('shadow_fiend', ['quelling_blade']).creepDamageBonus, 4);
    // Slippers are damage on an agility hero, a Mantle is not; the reverse on CM.
    check('SF+slippers damage', heroes.heroById('shadow_fiend', ['slippers']).damageMin, 44);
    check('SF+mantle damage', heroes.heroById('shadow_fiend', ['mantle']).damageMin, 41);
    check('CM+mantle damage', heroes.heroById('crystal_maiden', ['mantle']).damageMin, 51);
    check('CM+circlet hp', heroes.heroById('crystal_maiden', ['circlet']).maxHp, 538);
    check('faerie fire damage', heroes.heroById('sniper', ['faerie_fire']).damageMin, 42);
    // Level 1 stats are untouched by asking for a hero with nothing bought.
    check('no items is the base template', heroes.heroById('juggernaut', []), jug);

    // What a shop at 0:00 would let you buy: one blade, six slots, 600 gold.
    check('one quelling blade', items.legalLoadout(['quelling_blade', 'quelling_blade']).length, 1);
    check('six slots', items.legalLoadout(Array(8).fill('iron_branch')).length, 6);
    check('600 gold', items.legalLoadout(['circlet', 'circlet', 'circlet', 'circlet']).length, 3);
    check('unknown items dropped', items.legalLoadout(['rapier', 'iron_branch']).join(), 'iron_branch');
    check('garbage loadout', items.legalLoadout('rapier').length, 0);
  }
  {
    // Quell lands on enemy creeps, before armor, and nowhere else.
    const w = new World({
      ...DEFAULT_CONFIG,
      heroId: 'juggernaut',
      items: ['quelling_blade'],
      enemyHeroId: 'juggernaut',
      seed: 7,
    });
    const hero = w.player;
    const avg = (hero.damageMin + hero.damageMax) / 2;
    const enemyMelee = [...w.units.values()].find((u) => u.team === 'dire' && u.kind === 'melee_creep');
    const ownMelee = [...w.units.values()].find((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    check('quell vs enemy creep', w.expectedDamage(hero, enemyMelee), (avg + 8) * constants.armorMultiplier(2), 1e-6);
    check('no quell on a deny', w.expectedDamage(hero, ownMelee), avg * constants.armorMultiplier(2), 1e-6);
    check('no quell vs hero', w.expectedDamage(hero, w.enemy), avg * constants.armorMultiplier(w.enemy.armor), 1e-6);
    check('bot starts empty-handed', w.enemy.creepDamageBonus, 0);
    // A config saved by an older build has no items at all.
    const legacy = { ...DEFAULT_CONFIG, heroId: 'juggernaut', seed: 7 };
    delete legacy.items;
    check('config without items', new World(legacy).player.damageMin, 54);
  }

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

  // --- Swing timing on an isolated pair -----------------------------------
  // Strip the lane down to one hero and one inert dummy so nothing else can
  // touch the creep's health, then measure when damage actually lands.
  const rig = (heroId) => {
    const w = new World({ ...DEFAULT_CONFIG, heroId, seed: 5, enemyHero: false, duration: 1e9 });
    const hero = w.player;
    const creep = [...w.units.values()].find((u) => u.team === 'dire' && u.kind === 'melee_creep');
    w.units.clear();
    w.units.set(hero.id, hero);
    w.units.set(creep.id, creep);
    // Inert: it cannot move, swing back, or heal out from under the measurement.
    creep.moveSpeed = 0;
    creep.damageMin = 0;
    creep.damageMax = 0;
    creep.hpRegen = 0;
    creep.pos = { x: hero.pos.x + 100, y: hero.pos.y };
    hero.facing = 0;
    return { w, hero, creep };
  };
  const STEP = 1 / 120;
  /** Seconds until the creep's health next moves, or Infinity. */
  const timeToDamage = (w, creep, limit = 5) => {
    const before = creep.hp;
    for (let t = 0; t < limit; t += STEP) {
      w.step(STEP);
      if (creep.hp !== before) return t + STEP;
    }
    return Infinity;
  };

  {
    // Melee: damage lands exactly on the end of the wind-up, no travel.
    const { w, hero, creep } = rig('juggernaut');
    w.orderAttack(hero, creep);
    const first = timeToDamage(w, creep);
    // Tight on purpose: at a 1/120 step a 0.232s attack point runs out inside
    // frame 28, so a landing any later than that means a frame is being lost.
    check('melee hit lands on attack point', first, constants.attackPointTime(hero.attackPoint, hero.attackSpeedBonus), 0.002);
    // And the next one lands one attack interval later, not one interval plus
    // a backswing — the follow-through never gates the next swing.
    const second = timeToDamage(w, creep);
    check('melee cadence is the attack interval', second, constants.attackInterval(hero.baseAttackTime, hero.attackSpeedBonus), 0.012);
  }

  {
    // Ranged: wind-up plus honest projectile travel over 100 units.
    const { w, hero, creep } = rig('shadow_fiend');
    w.orderAttack(hero, creep);
    const windup = constants.attackPointTime(hero.attackPoint, hero.attackSpeedBonus);
    check('ranged hit lands after travel', timeToDamage(w, creep), windup + 100 / hero.projectileSpeed, 0.02);
  }

  {
    // Cancelling the wind-up throws the attack away entirely.
    const { w, hero, creep } = rig('juggernaut');
    w.orderAttack(hero, creep);
    for (let t = 0; t < 0.1; t += STEP) w.step(STEP);
    w.orderMove(hero, { x: hero.pos.x - 400, y: 0 });
    const hp = creep.hp;
    for (let t = 0; t < 1.5; t += STEP) w.step(STEP);
    check('cancelled wind-up deals nothing', creep.hp, hp);
  }

  {
    // Attack-move: the flag has to actually drive acquisition. Park the creep
    // outside melee range but inside acquisition range and walk at it.
    const { w, hero, creep } = rig('juggernaut');
    creep.pos = { x: hero.pos.x + 400, y: hero.pos.y };
    w.orderAttackMove(hero, { x: hero.pos.x + 900, y: 0 });
    let acquired = false;
    for (let t = 0; t < 3; t += STEP) {
      w.step(STEP);
      if (hero.attackTargetId === creep.id) acquired = true;
      if (creep.hp < creep.maxHp) break;
    }
    check('attack-move acquires', acquired, true);
    check('attack-move damages', creep.hp < creep.maxHp, true);
  }

  {
    // ...but it must never pick up an ally, or it would deny for you.
    const { w, hero, creep } = rig('juggernaut');
    creep.team = 'radiant';
    creep.hp = creep.maxHp * 0.2; // well under the deny line
    creep.pos = { x: hero.pos.x + 300, y: hero.pos.y };
    w.orderAttackMove(hero, { x: hero.pos.x + 900, y: 0 });
    for (let t = 0; t < 2; t += STEP) w.step(STEP);
    check('attack-move ignores allies', hero.attackTargetId, null);
  }

  // --- Creep targeting and aggro ------------------------------------------
  const settle = (w, seconds) => { for (let i = 0; i < seconds * 120; i++) w.step(STEP); };

  {
    // The rule the whole aggro layer rests on: creeps prefer other creeps, so a
    // hero standing inside an engaged wave takes nothing.
    const w = new World({ ...DEFAULT_CONFIG, seed: 11, enemyHero: false, duration: 1e9 });
    settle(w, 4); // let the waves meet and pair off
    const busy = [...w.units.values()].find(
      (u) => u.team === 'dire' && u.kind === 'melee_creep' && u.attackTargetId,
    );
    const hero = w.player;
    hero.pos = { x: busy.pos.x + 60, y: busy.pos.y };
    hero.hp = hero.maxHp;
    settle(w, 4);
    check('creeps ignore a hero standing in the wave', hero.hp, hero.maxHp);
  }

  {
    // ...and the exception: an attack order on their hero turns them onto you.
    const w = new World({ ...DEFAULT_CONFIG, seed: 12, enemyHero: true, duration: 1e9 });
    settle(w, 2);
    const hero = w.player;
    const enemy = w.enemy;
    hero.pos = { x: enemy.pos.x - 200, y: enemy.pos.y };
    w.orderAttack(hero, enemy);
    const pulled = () =>
      [...w.units.values()].filter((u) => u.team === 'dire' && u.aggroTargetId === hero.id);
    check('attacking their hero pulls their creeps', pulled().length > 0, true);
    check('the pull puts the puller on cooldown', hero.aggroCooldown > 0, true);

    // Clicking one of your own units hands the wave straight back.
    const mine = [...w.units.values()].find((u) => u.team === 'radiant' && u.kind !== 'hero');
    w.orderAttack(hero, mine);
    check('attacking your own unit gives aggro back', pulled().length, 0);
  }

  {
    // Forced aggro lets go on its own after AGGRO_DURATION.
    const w = new World({ ...DEFAULT_CONFIG, seed: 13, enemyHero: true, duration: 1e9 });
    settle(w, 2);
    const hero = w.player;
    hero.pos = { x: w.enemy.pos.x - 200, y: w.enemy.pos.y };
    w.orderAttack(hero, w.enemy);
    const held = [...w.units.values()].filter((u) => u.aggroTargetId === hero.id).length;
    check('pull actually took hold', held > 0, true);
    settle(w, constants.AGGRO_DURATION + 0.2);
    check('aggro expires', [...w.units.values()].filter((u) => u.aggroTargetId === hero.id).length, 0);
  }

  {
    // Sticky targeting: a creep mid-fight does not swap to something nearer.
    const w = new World({ ...DEFAULT_CONFIG, seed: 14, enemyHero: false, duration: 1e9 });
    settle(w, 4);
    const attacker = [...w.units.values()].find(
      (u) => u.team === 'dire' && u.kind === 'melee_creep' && w.get(u.attackTargetId),
    );
    const held = attacker.attackTargetId;
    // Drop a fresh, closer radiant creep right on top of it.
    const bait = [...w.units.values()].find(
      (u) => u.team === 'radiant' && u.kind === 'melee_creep' && u.id !== held,
    );
    bait.pos = { x: attacker.pos.x + 20, y: attacker.pos.y };
    settle(w, 0.5);
    check('creeps do not chase whatever is nearest', attacker.attackTargetId, held);
  }

  {
    // Siege creeps are built for buildings and rank a tower above anything else.
    const w = new World({ ...DEFAULT_CONFIG, seed: 15, enemyHero: false, duration: 1e9 });
    const tower = [...w.units.values()].find((u) => u.kind === 'tower' && u.team === 'dire');
    const siegeTpl = units.SIEGE_CREEP;
    const { spawnUnit } = units;
    const siege = spawnUnit(siegeTpl, 'radiant', { x: tower.pos.x - 400, y: tower.pos.y }, w.rng);
    w.units.set(siege.id, siege);
    const foe = spawnUnit(units.MELEE_CREEP, 'dire', { x: siege.pos.x + 80, y: siege.pos.y }, w.rng);
    w.units.set(foe.id, foe);
    settle(w, 0.2);
    check('siege creeps go for the tower first', siege.attackTargetId, tower.id);
  }

  {
    // Contact behaviour. A creep walking into a hero should be turned aside and
    // go around, and the hero — being the heavier of the two — should be moved
    // far less than the creep is.
    const w = new World({ ...DEFAULT_CONFIG, heroId: 'juggernaut', seed: 31, enemyHero: false, duration: 1e9 });
    const hero = w.player;
    const creep = [...w.units.values()].find((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    w.units.clear();
    w.units.set(hero.id, hero);
    w.units.set(creep.id, creep);
    creep.pos = { x: 2000, y: 0 };
    creep.attackTargetId = null;
    hero.pos = { x: 2000 + creep.radius + hero.radius - 4, y: 0 };
    const heroFrom = { x: hero.pos.x, y: hero.pos.y };
    let deflection = 0;
    for (let i = 0; i < 2.5 * 120; i++) {
      w.step(STEP);
      deflection = Math.max(deflection, Math.abs(creep.pos.y));
    }
    const heroMoved = Math.hypot(hero.pos.x - heroFrom.x, hero.pos.y - heroFrom.y);
    check('a blocked creep is turned aside rather than stalled', deflection > 10, true);
    check('the creep still gets past', creep.pos.x > 2500, true);
    // It walked 800 units through him; he should have given ground in tens.
    check('a hero outweighs a creep in a shove', heroMoved < 80, true);
  }

  {
    // Separation invariant: nothing should end a busy lane inside anything else.
    const w = new World({ ...DEFAULT_CONFIG, seed: 44, duration: 1e9 });
    settle(w, 60);
    let worst = 0;
    const alive = w.aliveUnits();
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (a.moveSpeed <= 0 && b.moveSpeed <= 0) continue;
        const gap = a.radius + b.radius - Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        worst = Math.max(worst, gap);
      }
    }
    // One step of overlap can survive a frame; a body-length cannot.
    check('units do not end up stacked', worst < 8, true);
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

// --- Phase 2: the input path ----------------------------------------------
// Picking is the renderer's job, not the sim's, so nothing above touches it.
// This is the only check that covers pickUnit -> orderAttack end to end: a real
// right-click at a real screen position, against the upright cylinders the
// renderer tests the cursor ray against.
await page.evaluate(() => {
  window.__lht.start({
    heroId: 'shadow_fiend',
    duration: 600,
    deniesEnabled: true,
    enemyHero: false,
    enemyHeroId: 'crystal_maiden',
    enemyDifficulty: 3,
    aggroEnabled: true,
    showKillableHighlight: true,
    showRangeRings: true,
    showDamagePreview: true,
    seed: 4242,
  });
});
await page.waitForTimeout(2500);

const aim = await page.evaluate(() => {
  const w = window.__lht.world;
  const creep = [...w.units.values()].find(
    (u) => u.alive && u.team === 'dire' && u.kind === 'melee_creep',
  );
  if (!creep) return null;
  // Aim at the chest, which is what the cursor looks like it is over and the
  // whole reason picking uses a cylinder instead of the ground point.
  return { id: creep.id, at: window.__lht.toScreen(creep.pos, 55) };
});

if (!aim) {
  results.push({ name: 'a dire creep exists to click', ok: false, actual: 'none', expected: 'one' });
} else {
  await page.mouse.click(aim.at.x, aim.at.y, { button: 'right' });
  const ordered = await page.evaluate(() => window.__lht.world.player.attackTargetId);
  results.push({
    name: 'right-clicking a creep orders an attack on it',
    ok: ordered === aim.id,
    actual: ordered,
    expected: aim.id,
  });

  // And empty lane must stay a move order, not grab whatever is nearest.
  await page.mouse.click(60, 700, { button: 'right' });
  const after = await page.evaluate(() => ({
    target: window.__lht.world.player.attackTargetId,
    moving: !!window.__lht.world.player.moveTarget,
  }));
  results.push({
    name: 'right-clicking empty lane is a move order',
    ok: after.target === null && after.moving,
    actual: JSON.stringify(after),
    expected: '{"target":null,"moving":true}',
  });
}

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
