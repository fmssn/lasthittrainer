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
  check('melee xp', melee.bountyXp, 57);

  const ranged = units.RANGED_CREEP;
  check('ranged hp', ranged.maxHp, 300);
  check('ranged armor', ranged.armor, 0);
  check('ranged regen', ranged.hpRegen, 2);
  check('ranged dmg', `${ranged.damageMin}-${ranged.damageMax}`, '21-26');
  check('ranged attack point', ranged.attackPoint, 0.5);
  check('ranged projectile', ranged.projectileSpeed, 900);
  check('ranged xp', ranged.bountyXp, 69);

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
  // Swordmaster (npc_dota_hero_juggernaut): 22-24 + 32 agi. `BaseAttackSpeed
  // 110` in the hero file, so 142 attack speed at level 1 and an authored 0.33
  // point is 0.232 in lane.
  const sword = heroes.heroById('swordmaster');
  check('Swordmaster damage', `${sword.damageMin}-${sword.damageMax}`, '54-56');
  check('Swordmaster hp', sword.maxHp, 560);
  check('Swordmaster attack speed', sword.attackSpeedBonus, 42);
  check('Swordmaster windup', constants.attackPointTime(sword.attackPoint, sword.attackSpeedBonus), 0.2324, 0.001);
  check('Swordmaster interval', constants.attackInterval(sword.baseAttackTime, sword.attackSpeedBonus), 0.9859, 0.001);

  // Frost Archer (npc_dota_hero_drow_ranger): 27-34 + 24 agi, 120 + 16*22 hp,
  // and no BaseAttackSpeed override, so agility is all of its attack speed.
  const archer = heroes.heroById('frost_archer');
  check('Archer damage', `${archer.damageMin}-${archer.damageMax}`, '51-58');
  check('Archer hp', archer.maxHp, 472);
  check('Archer armor', archer.armor, 4, 1e-9);
  check('Archer attack speed', archer.attackSpeedBonus, 24);
  check('Archer windup', constants.attackPointTime(archer.attackPoint, archer.attackSpeedBonus), 0.4032, 0.001);
  check('Archer interval', constants.attackInterval(archer.baseAttackTime, archer.attackSpeedBonus), 1.371, 0.001);

  // --- Levels: the hero file's gains, once per level past the first -------
  // Swordmaster 2.0 str / 2.8 agi a level, Frost Archer 1.9 / 2.8
  // (AttributeStrengthGain, AttributeAgilityGain), used unrounded.
  const sword3 = heroes.heroById('swordmaster', [], 3);
  check('Swordmaster L3 hp', sword3.maxHp, 120 + 24 * 22, 1e-9);
  check('Swordmaster L3 regen', sword3.hpRegen, 0.5 + 24 * 0.1, 1e-9);
  check('Swordmaster L3 damage', sword3.damageMin, 22 + 37.6, 1e-9);
  check('Swordmaster L3 attack speed', sword3.attackSpeedBonus, 10 + 37.6, 1e-9);
  check('Swordmaster L3 armor', sword3.armor, 37.6 / 6, 1e-9);
  const archer2 = heroes.heroById('frost_archer', [], 2);
  check('Archer L2 hp', archer2.maxHp, 120 + 17.9 * 22, 1e-9);
  check('Archer L2 damage', archer2.damageMax, 34 + 26.8, 1e-9);
  check('level 1 is the spawn template', heroes.heroById('frost_archer', [], 1), archer);
  check('items and levels stack', heroes.heroById('frost_archer', ['slippers'], 2).damageMin, 27 + 26.8 + 3, 1e-9);

  // Experience per level, 7.32's table; one wave of creeps is level 2.
  check('one wave is level 2', constants.levelForXp(3 * 57 + 69), 2);
  check('239 xp is still level 1', constants.levelForXp(239), 1);
  check('2440 xp is level 6', constants.levelForXp(2440), 6);
  check('level 30 is the cap', constants.levelForXp(1e9), 30);
  check('respawn at level 1', constants.respawnTime(1), 12);
  check('respawn at level 5', constants.respawnTime(5), 24);
  check('respawn past level 25', constants.respawnTime(30), 100);

  // Saved configs and run history still carry the ids from before the rename.
  check('old melee id resolves', heroes.canonicalHeroId('juggernaut'), 'swordmaster');
  check('old ranged id resolves', heroes.canonicalHeroId('drow'), 'frost_archer');
  check('retired hero is unknown', heroes.canonicalHeroId('shadow_fiend'), undefined);
  check('retired hero still spawns something', heroes.heroById('shadow_fiend').id, 'swordmaster');

  // --- Starting items, from items.txt -------------------------------------
  const items = await import('/src/sim/items.ts');
  {
    // Two branches are +2 agility on the Swordmaster: +2 damage, +2 attack
    // speed, +1/3 armor, +44 HP. Quell adds nothing to the listed damage —
    // it is creep-only.
    const j = heroes.heroById('swordmaster', ['quelling_blade', 'iron_branch', 'iron_branch']);
    check('Swordmaster+QB+2IB damage', `${j.damageMin}-${j.damageMax}`, '56-58');
    check('Swordmaster+QB+2IB attack speed', j.attackSpeedBonus, 44);
    check('Swordmaster+QB+2IB hp', j.maxHp, 604);
    check('Swordmaster+QB+2IB armor', j.armor, sword.armor + 2 / 6, 1e-9);
    check('Swordmaster quell (melee)', j.creepDamageBonus, 8);
    check('Archer quell (ranged)', heroes.heroById('frost_archer', ['quelling_blade']).creepDamageBonus, 4);
    // Slippers are damage on an agility hero; a Mantle or Gauntlets are not.
    check('Archer+slippers damage', heroes.heroById('frost_archer', ['slippers']).damageMin, 54);
    check('Archer+mantle damage', heroes.heroById('frost_archer', ['mantle']).damageMin, 51);
    check('Swordmaster+gauntlets damage', heroes.heroById('swordmaster', ['gauntlets']).damageMin, 54);
    check('Swordmaster+gauntlets hp', heroes.heroById('swordmaster', ['gauntlets']).maxHp, 626);
    check('Archer+circlet hp', heroes.heroById('frost_archer', ['circlet']).maxHp, 516);
    check('faerie fire damage', heroes.heroById('frost_archer', ['faerie_fire']).damageMin, 53);
    // Tango and Magic Stick are bought for the slot and the gold, nothing else.
    const padded = heroes.heroById('frost_archer', ['tango', 'magic_stick']);
    check('tango+stick add no damage', padded.damageMin, archer.damageMin);
    check('tango+stick add no hp', padded.maxHp, archer.maxHp);
    check('tango+stick add no attack speed', padded.attackSpeedBonus, archer.attackSpeedBonus);
    // Level 1 stats are untouched by asking for a hero with nothing bought.
    check('no items is the base template', heroes.heroById('swordmaster', []), sword);

    // What a shop at 0:00 would let you buy: one blade, six slots, 600 gold.
    check('one quelling blade', items.legalLoadout(['quelling_blade', 'quelling_blade']).length, 1);
    check('six slots', items.legalLoadout(Array(8).fill('iron_branch')).length, 6);
    check('600 gold', items.legalLoadout(['circlet', 'circlet', 'circlet', 'circlet']).length, 3);
    check('unknown items dropped', items.legalLoadout(['rapier', 'iron_branch']).join(), 'iron_branch');
    check('garbage loadout', items.legalLoadout('rapier').length, 0);
    check('tango cost', items.itemById('tango').cost, 90);
    check('magic stick cost', items.itemById('magic_stick').cost, 200);
    // `ItemStackable 1` on Tango: a second one joins the first slot as six charges.
    const slots = items.inventorySlots(['tango', 'iron_branch', 'tango']);
    check('tangos share a slot', slots.length, 2);
    check('tango stack charges', slots[0].charges, 6);
    check('faerie fire does not stack', items.inventorySlots(['faerie_fire', 'faerie_fire']).length, 2);
    // Five branches fill five slots, and tangos keep fitting into the sixth.
    check('tangos stack past the slot cap', items.legalLoadout([...Array(5).fill('iron_branch'), 'tango', 'tango', 'tango']).length, 8);
    check('a full inventory refuses a new tango', items.legalLoadout([...Array(6).fill('iron_branch'), 'tango']).length, 6);
    check('selling takes one off the stack', items.sellOne(['tango', 'iron_branch', 'tango'], 'tango').join(), 'tango,iron_branch');
  }
  {
    // Quell lands on enemy creeps, before armor, and nowhere else.
    const w = new World({
      ...DEFAULT_CONFIG,
      heroId: 'swordmaster',
      items: ['quelling_blade'],
      enemyHeroId: 'swordmaster',
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
    // A config saved by an older build has no items at all, and names the
    // hero by the id it had before the rename.
    const legacy = { ...DEFAULT_CONFIG, heroId: 'juggernaut', seed: 7 };
    delete legacy.items;
    check('config without items', new World(legacy).player.damageMin, 54);
  }

  // --- Attack classes: creep_irresolute, creep_piercing, creep_siege -------
  {
    const w = new World({ ...DEFAULT_CONFIG, seed: 7, enemyHero: false, waves: Infinity });
    const { spawnUnit } = units;
    const at = { x: 3000, y: 0 };
    const make = (tpl, team) => spawnUnit(tpl, team, at, w.rng);
    const hero = w.player;
    const melee = make(units.MELEE_CREEP, 'dire');
    const ranged = make(units.RANGED_CREEP, 'dire');
    const siege = make(units.SIEGE_CREEP, 'dire');
    const tower = make(units.TOWER, 'dire');
    const theirMelee = make(units.MELEE_CREEP, 'radiant');
    const theirSiege = make(units.SIEGE_CREEP, 'radiant');
    // Multiplier over average damage after armor, which is what is left.
    const factor = (source, target) =>
      w.expectedDamage(source, target) /
      (((source.damageMin + source.damageMax) / 2) * constants.armorMultiplier(target.armor));
    check('melee creep -25% vs hero', factor(melee, hero), 0.75, 1e-9);
    check('melee creep full vs creep', factor(melee, theirMelee), 1, 1e-9);
    check('melee creep -30% vs siege', factor(melee, theirSiege), 0.7, 1e-9);
    check('ranged creep -50% vs hero', factor(ranged, hero), 0.5, 1e-9);
    check('ranged creep +50% vs creep', factor(ranged, theirMelee), 1.5, 1e-9);
    check('ranged creep 35% vs siege', factor(ranged, theirSiege), 0.35, 1e-9);
    check('siege creep full vs hero', factor(siege, hero), 1, 1e-9);
    check('siege creep 250% vs siege', factor(siege, theirSiege), 2.5, 1e-9);
    check('tower full vs hero', factor(tower, hero), 1, 1e-9);
    check('hero -50% vs siege', factor(hero, siege), 0.5, 1e-9);
    check('hero full vs creep', factor(hero, melee), 1, 1e-9);
  }

  // --- Swing timing on an isolated pair -----------------------------------
  // Strip the lane down to one hero and one inert dummy so nothing else can
  // touch the creep's health, then measure when damage actually lands.
  const rig = (heroId) => {
    const w = new World({ ...DEFAULT_CONFIG, heroId, seed: 5, enemyHero: false, waves: Infinity });
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
    const { w, hero, creep } = rig('swordmaster');
    w.orderAttack(hero, creep);
    const first = timeToDamage(w, creep);
    // Tight on purpose: at a 1/120 step a 0.232s attack point runs out inside
    // frame 28, so a landing any later than that means a frame is being lost.
    check('melee hit lands on attack point', first, constants.attackPointTime(hero.attackPoint, hero.attackSpeedBonus), 0.002);
    // And the next one lands one attack interval later, not one interval plus
    // a backswing — the follow-through never gates the next swing.
    const second = timeToDamage(w, creep);
    check('melee cadence is the attack interval', second, constants.attackInterval(hero.baseAttackTime, hero.attackSpeedBonus), 0.012);
    // The audio tells your blow from the bot's by who swung, not by kind and team.
    check('damage event names the melee swinger', w.damageLog.at(-1).sourceId, hero.id);
  }

  {
    // Ranged: wind-up plus honest projectile travel over 100 units.
    const { w, hero, creep } = rig('frost_archer');
    w.orderAttack(hero, creep);
    const windup = constants.attackPointTime(hero.attackPoint, hero.attackSpeedBonus);
    check('ranged hit lands after travel', timeToDamage(w, creep), windup + 100 / hero.projectileSpeed, 0.02);
    check('damage event names the archer, not the arrow', w.damageLog.at(-1).sourceId, hero.id);
  }

  {
    // Cancelling the wind-up throws the attack away entirely.
    const { w, hero, creep } = rig('swordmaster');
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
    const { w, hero, creep } = rig('swordmaster');
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
    const { w, hero, creep } = rig('swordmaster');
    creep.team = 'radiant';
    creep.hp = creep.maxHp * 0.2; // well under the deny line
    creep.pos = { x: hero.pos.x + 300, y: hero.pos.y };
    w.orderAttackMove(hero, { x: hero.pos.x + 900, y: 0 });
    for (let t = 0; t < 2; t += STEP) w.step(STEP);
    check('attack-move ignores allies', hero.attackTargetId, null);
  }

  // --- Experience: shared by the enemy heroes near a death ----------------
  {
    const w = new World({ ...DEFAULT_CONFIG, heroId: 'swordmaster', enemyHeroId: 'swordmaster', seed: 21, waves: Infinity });
    // Hold the bot still: this is about who gets paid, not about laning.
    w.enemyAi = null;
    const hero = w.player;
    const bot = w.enemy;
    const all = [...w.units.values()];
    const theirs = all.filter((u) => u.team === 'dire' && u.kind === 'melee_creep');
    const mine = all.filter((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    w.units.clear();
    const place = (u, x, hp) => {
      u.pos = { x, y: 0 };
      u.hp = hp;
      u.moveSpeed = 0;
      u.moveTarget = null;
      u.attackTargetId = null;
      u.damageMin = u.damageMax = u.kind === 'hero' ? u.damageMin : 0;
      w.units.set(u.id, u);
    };
    const until = (done, seconds = 2) => {
      for (let i = 0; i < seconds * 120 && !done(); i++) w.step(STEP);
    };
    place(hero, 1000, hero.maxHp);
    place(bot, 5000, bot.maxHp);

    // A last hit pays the side that did not lose the creep.
    const lastHit = theirs[0];
    place(lastHit, 1100, 1);
    w.orderAttack(hero, lastHit);
    until(() => !lastHit.alive);
    check('a last hit pays its xp', hero.experience, 57);
    check('the losing side gets none', bot.experience, 0);
    check('stats carry your xp', w.stats.experience, 57);

    // A death more than 1500 away pays nobody, whoever landed the blow.
    const far = theirs[1];
    place(far, 3000, 1);
    const killer = mine[0];
    place(killer, 2910, killer.maxHp);
    killer.damageMin = units.MELEE_CREEP.damageMin;
    killer.damageMax = units.MELEE_CREEP.damageMax;
    until(() => !far.alive);
    check('a creep can kill a creep', far.alive, false);
    check('out of range pays nothing', hero.experience, 57);

    // A deny pays the other side half, and the denier nothing.
    const denied = mine[1];
    place(denied, 1100, 10);
    bot.pos = { x: 2000, y: 0 };
    w.orderAttack(hero, denied);
    until(() => !denied.alive);
    check('a deny pays the enemy half', bot.experience, Math.floor(57 * 0.5));
    check('a deny pays the denier nothing', hero.experience, 57);

    // Crossing 240 is level 2: more of everything, and health keeps its
    // fraction instead of filling up.
    hero.experience = 200;
    hero.hp = hero.maxHp / 2;
    const levelUp = theirs[2];
    place(levelUp, 1100, 1);
    w.orderAttack(hero, levelUp);
    until(() => !levelUp.alive);
    check('240 xp is level 2', hero.level, 2);
    check('level 2 max hp', hero.maxHp, 560 + 2 * 22, 1e-9);
    check('level 2 damage', hero.damageMin, 54 + 2.8, 1e-9);
    check('a level-up is not a heal', hero.hp / hero.maxHp, 0.5, 0.01);

    // A hero kill pays 100 + 13% of the victim's xp, and the respawn clock
    // follows the victim's level.
    place(bot, 1100, 1);
    const before = hero.experience;
    const worth = Math.floor(100 + 0.13 * bot.experience);
    w.orderAttack(hero, bot);
    until(() => !bot.alive);
    check('a hero kill pays 100 + 13%', hero.experience - before, worth);
    check('level 1 respawn', bot.phaseTimer, 12, 1e-9);
    const executioner = { ...units.spawnUnit(units.MELEE_CREEP, 'dire', { x: 900, y: 0 }, w.rng), id: 9300 };
    w.units.set(executioner.id, executioner);
    hero.hp = 1;
    until(() => !hero.alive);
    check('level 2 respawn', w.playerRespawnTimer, 15, 1e-9);
  }

  // --- Creep targeting and aggro ------------------------------------------
  const settle = (w, seconds) => { for (let i = 0; i < seconds * 120; i++) w.step(STEP); };

  {
    // The rule the whole aggro layer rests on: creeps in a fight keep their
    // targets, and when they pick again an idle hero is the lowest threat, so a
    // hero standing inside an engaged wave takes nothing.
    const w = new World({ ...DEFAULT_CONFIG, seed: 11, enemyHero: false, waves: Infinity });
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
    const w = new World({ ...DEFAULT_CONFIG, seed: 12, enemyHero: true, waves: Infinity });
    settle(w, 2);
    const hero = w.player;
    const enemy = w.enemy;
    hero.pos = { x: enemy.pos.x - 200, y: enemy.pos.y };
    w.orderAttack(hero, enemy);
    const pulled = () =>
      [...w.units.values()].filter((u) => u.team === 'dire' && u.aggroTargetId === hero.id);
    check('attacking their hero pulls their creeps', pulled().length > 0, true);
    check('the pull puts the puller on cooldown', hero.aggroCooldown > 0, true);

    // A pull cannot be handed straight back: the hand-back waits on the same
    // cooldown the pull just started.
    const mine = [...w.units.values()].find((u) => u.team === 'radiant' && u.kind !== 'hero');
    w.orderAttack(hero, mine);
    check('a pull cannot be handed straight back', pulled().length > 0, true);
  }

  {
    // Forced aggro lets go on its own after AGGRO_DURATION.
    const w = new World({ ...DEFAULT_CONFIG, seed: 13, enemyHero: true, waves: Infinity });
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
    const w = new World({ ...DEFAULT_CONFIG, seed: 14, enemyHero: false, waves: Infinity });
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
    // Picking again: unit type, then threat, then distance, over everything in
    // acquisition range. Heroes and creeps share a type; siege creeps rank
    // below both. Staged, with only the picking creep thinking.
    const { runCreepAi } = await import('/src/sim/ai/creepAi.ts');
    const { spawnUnit } = units;
    const w = new World({ ...DEFAULT_CONFIG, heroId: 'swordmaster', seed: 16, enemyHero: false, waves: Infinity });
    const hero = w.player;
    // Explicit ids: after a hot reload the page can hold a second copy of
    // units.ts whose counter would hand out ids the world already uses.
    let nextId = 9100;
    const at = (tpl, team, x) => {
      const u = { ...spawnUnit(tpl, team, { x, y: 0 }, w.rng), id: nextId++ };
      w.units.set(u.id, u);
      return u;
    };
    w.units.clear();
    w.units.set(hero.id, hero);
    const picker = at(units.MELEE_CREEP, 'dire', 2000);
    const ally = at(units.MELEE_CREEP, 'dire', 2600);
    const fighter = at(units.MELEE_CREEP, 'radiant', 2300);
    const pick = () => {
      picker.attackTargetId = null;
      runCreepAi(w, picker);
      return picker.attackTargetId;
    };
    // The hero is inside the picker's attack range and nearer than the creep.
    hero.pos = { x: 2110, y: 0 };
    hero.attackTargetId = null;
    fighter.attackTargetId = ally.id;
    check('an idle hero loses to a creep in the fight', pick(), fighter.id);
    hero.attackTargetId = ally.id;
    check('a hero last hitting is fair game when nearest', pick(), hero.id);
    fighter.attackTargetId = picker.id;
    check('hitting the creep outranks hitting its allies', pick(), fighter.id);
    const siege = at(units.SIEGE_CREEP, 'radiant', 2080);
    siege.attackTargetId = picker.id;
    hero.attackTargetId = null;
    fighter.attackTargetId = null;
    check('siege creeps rank below heroes and creeps', pick(), hero.id);
    // No leash: with nothing else in reach it keeps after its target however
    // far that has run.
    w.units.delete(siege.id);
    w.units.delete(fighter.id);
    hero.pos = { x: 3500, y: 0 };
    picker.attackTargetId = hero.id;
    runCreepAi(w, picker);
    check('no leash: it keeps chasing', picker.attackTargetId, hero.id);
    w.units.set(fighter.id, fighter);
    runCreepAi(w, picker);
    check('until something turns up in range', picker.attackTargetId, fighter.id);
  }

  {
    // Forced aggro reaches 500 from the ordering hero, whatever the creep:
    // not a ranged creep's 600 acquisition range. Past 5:00, so the early-aggro
    // block stays out of it.
    const w = new World({ ...DEFAULT_CONFIG, seed: 17, enemyHero: true, waves: Infinity });
    w.time = constants.AGGRO_BLOCK_UNTIL;
    const hero = w.player;
    const all = [...w.units.values()].filter((u) => u.team === 'dire' && u.kind === 'ranged_creep');
    const near = all[0];
    const far = { ...units.spawnUnit(units.RANGED_CREEP, 'dire', { x: 0, y: 0 }, w.rng), id: 9200 };
    w.units.clear();
    for (const u of [hero, w.enemy, near, far]) w.units.set(u.id, u);
    hero.pos = { x: 2000, y: 0 };
    near.pos = { x: 2450, y: 0 };
    far.pos = { x: 2000, y: 550 };
    w.orderAttack(hero, w.enemy);
    check('aggro reaches a creep 450 away', near.aggroTargetId, hero.id);
    check('aggro stops at 500', far.aggroTargetId, null);
  }

  {
    // Before 5:00 a lane creep with nothing to fight, far from its own tower,
    // ignores a pull (7.27). An enemy creep in its acquisition range lifts
    // that, and so does being within 1550 of its own tier 1.
    const w = new World({ ...DEFAULT_CONFIG, seed: 19, enemyHero: true, waves: Infinity });
    const hero = w.player;
    const all = [...w.units.values()];
    const lone = all.find((u) => u.team === 'dire' && u.kind === 'melee_creep');
    const company = all.find((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    const tower = all.find((u) => u.team === 'dire' && u.kind === 'tower');
    w.units.clear();
    for (const u of [hero, w.enemy, lone, tower]) w.units.set(u.id, u);
    const pullAt = (x) => {
      lone.aggroTargetId = null;
      lone.aggroTimer = 0;
      lone.pos = { x, y: 0 };
      hero.pos = { x: x - 300, y: 0 };
      hero.aggroCooldown = 0;
      w.orderAttack(hero, w.enemy);
      return lone.aggroTargetId;
    };
    check('before 5:00 a lone creep ignores a pull', pullAt(2300), null);
    w.units.set(company.id, company);
    company.pos = { x: 2150, y: 100 };
    check('an enemy creep in range lifts the block', pullAt(2300), hero.id);
    w.units.delete(company.id);
    check('its own tower 1550 away lifts it', pullAt(tower.pos.x - 1300), hero.id);
    w.time = constants.AGGRO_BLOCK_UNTIL;
    check('the block ends at 5:00', pullAt(2300), hero.id);
  }

  {
    // Every swing at a hero draws the creeps near the swinger, auto-attacks
    // included, while the cooldown is ready. It forces no chase and starts no
    // cooldown. Staged still: nothing but the hero's swing can move a target.
    const w = new World({ ...DEFAULT_CONFIG, heroId: 'frost_archer', seed: 18, enemyHero: true, waves: Infinity });
    w.enemyAi = null;
    w.time = constants.AGGRO_BLOCK_UNTIL;
    const hero = w.player;
    const all = [...w.units.values()];
    const theirs = all.find((u) => u.team === 'dire' && u.kind === 'melee_creep');
    const mine = all.find((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    w.units.clear();
    for (const u of [hero, w.enemy, theirs, mine]) {
      u.moveSpeed = 0;
      u.moveTarget = null;
      w.units.set(u.id, u);
    }
    theirs.attackCooldown = mine.attackCooldown = 1e9;
    hero.pos = { x: 2000, y: 0 };
    w.enemy.pos = { x: 2500, y: 0 };
    theirs.pos = { x: 2300, y: 0 };
    mine.pos = { x: 2230, y: 0 };
    const swingAtHero = (cooldown) => {
      theirs.attackTargetId = mine.id;
      hero.aggroCooldown = cooldown;
      hero.phase = 'idle';
      hero.attackCooldown = 0;
      // Picked up on its own rather than ordered, so no pull runs.
      hero.attackTargetId = w.enemy.id;
      for (let i = 0; i < 120 && hero.phase !== 'windup'; i++) w.step(STEP);
    };
    swingAtHero(0);
    check('a swing at a hero draws nearby creeps', theirs.attackTargetId, hero.id);
    check('that draw forces no chase', theirs.aggroTimer, 0);
    check('that draw starts no cooldown', hero.aggroCooldown, 0);
    swingAtHero(2);
    check('it waits while the cooldown runs', theirs.attackTargetId, mine.id);
  }

  {
    // Handing aggro back: an attack order on your own unit makes what is
    // hitting you pick again with you ranked last, once your cooldown is ready,
    // and starts it. A tower answers to its own cooldown, and only for a unit
    // of yours nearer to it than you.
    const { runCreepAi } = await import('/src/sim/ai/creepAi.ts');
    const w = new World({ ...DEFAULT_CONFIG, seed: 23, enemyHero: false, waves: Infinity });
    const hero = w.player;
    const all = [...w.units.values()];
    const hitter = all.find((u) => u.team === 'dire' && u.kind === 'melee_creep');
    const mine = all.filter((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    const tower = all.find((u) => u.team === 'dire' && u.kind === 'tower');
    w.units.clear();
    for (const u of [hero, hitter, tower]) w.units.set(u.id, u);
    hero.pos = { x: 2000, y: 0 };
    hitter.pos = { x: 2100, y: 0 };
    const clickOwn = mine[0];
    clickOwn.pos = { x: 1200, y: 0 };
    w.units.set(clickOwn.id, clickOwn);

    hitter.attackTargetId = hero.id;
    hero.aggroCooldown = 1;
    w.orderAttack(hero, clickOwn);
    check('no hand-back while the cooldown runs', hitter.shunnedId, null);
    hero.aggroCooldown = 0;
    w.orderAttack(hero, clickOwn);
    check('a hand-back marks the hero', hitter.shunnedId, hero.id);
    check('a hand-back starts the cooldown', hero.aggroCooldown, constants.AGGRO_COOLDOWN);
    const other = mine[1];
    other.pos = { x: 2350, y: 0 };
    w.units.set(other.id, other);
    runCreepAi(w, hitter);
    check('handed back, it picks something else', hitter.attackTargetId, other.id);
    hitter.attackTargetId = hero.id;
    hitter.shunnedId = hero.id;
    w.units.delete(other.id);
    runCreepAi(w, hitter);
    check('with nothing else there it keeps you', hitter.attackTargetId, hero.id);

    // The tower, 800 from the hero and shooting him.
    hero.pos = { x: tower.pos.x - 800, y: tower.pos.y };
    tower.attackTargetId = hero.id;
    tower.phase = 'idle';
    hero.aggroCooldown = 0;
    w.orderAttack(hero, clickOwn);
    check('a tower keeps you with no one of yours nearer', tower.shunnedId, null);
    other.pos = { x: tower.pos.x - 500, y: tower.pos.y };
    w.units.set(other.id, other);
    hero.aggroCooldown = 5;
    w.orderAttack(hero, clickOwn);
    check('a tower lets go for a nearer unit of yours', tower.shunnedId, hero.id);
    check('the tower starts its own cooldown', tower.aggroCooldown, constants.TOWER_DEAGGRO_COOLDOWN);
    runCreepAi(w, tower);
    check('the tower switches to it', tower.attackTargetId, other.id);
  }

  {
    // Attack range runs edge to edge: authored range plus both hulls.
    const w = new World({ ...DEFAULT_CONFIG, seed: 20, enemyHero: false, waves: Infinity });
    const hero = w.player;
    const all = [...w.units.values()];
    const creep = all.find((u) => u.team === 'dire' && u.kind === 'melee_creep');
    const tower = all.find((u) => u.team === 'dire' && u.kind === 'tower');
    creep.pos = { x: hero.pos.x + 140, y: hero.pos.y };
    check('a melee creep reaches a hero at 140', w.inAttackRange(creep, hero), true);
    creep.pos.x += 1;
    check('but not at 141', w.inAttackRange(creep, hero), false);
    hero.pos = { x: tower.pos.x - 868, y: tower.pos.y };
    check('a tower reaches a hero at 868', w.inAttackRange(tower, hero), true);
    hero.pos.x -= 1;
    check('but not at 869', w.inAttackRange(tower, hero), false);
  }

  {
    // Siege creeps join every 10th wave from 5:00, which is the 11th to leave.
    const w = new World({ ...DEFAULT_CONFIG, seed: 22, enemyHero: false, waves: Infinity });
    const sieges = () => [...w.units.values()].filter((u) => u.kind === 'siege_creep').length;
    const spawn = (wave) => {
      w.waveCount = wave - 1;
      w.spawnWave(400, 5600);
      return sieges();
    };
    check('no siege creep before 5:00', spawn(10), 0);
    check('a siege creep each side at 5:00', spawn(11), 2);
    check('none on the wave after', spawn(12), 2);
    check('the next at 10:00', spawn(21), 4);
  }

  {
    // Siege creeps are built for buildings and rank a tower above anything else.
    const w = new World({ ...DEFAULT_CONFIG, seed: 15, enemyHero: false, waves: Infinity });
    const tower = [...w.units.values()].find((u) => u.kind === 'tower' && u.team === 'dire');
    const siegeTpl = units.SIEGE_CREEP;
    const { spawnUnit } = units;
    const siege = { ...spawnUnit(siegeTpl, 'radiant', { x: tower.pos.x - 400, y: tower.pos.y }, w.rng), id: 9400 };
    w.units.set(siege.id, siege);
    const foe = { ...spawnUnit(units.MELEE_CREEP, 'dire', { x: siege.pos.x + 80, y: siege.pos.y }, w.rng), id: 9401 };
    w.units.set(foe.id, foe);
    settle(w, 0.2);
    check('siege creeps go for the tower first', siege.attackTargetId, tower.id);
  }

  {
    // Contact behaviour. Nothing shoves anything in Dota: a creep walking into
    // a hero goes around him, and he does not give an inch.
    const w = new World({ ...DEFAULT_CONFIG, heroId: 'swordmaster', seed: 31, enemyHero: false, waves: Infinity });
    const hero = w.player;
    const creep = [...w.units.values()].find((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    w.units.clear();
    w.units.set(hero.id, hero);
    w.units.set(creep.id, creep);
    creep.pos = { x: 2000, y: 0 };
    creep.attackTargetId = null;
    const touching = constants.bodyRadius(creep.kind) + constants.bodyRadius(hero.kind);
    hero.pos = { x: 2000 + touching + 2, y: 0 };
    const heroFrom = { x: hero.pos.x, y: hero.pos.y };
    let deflection = 0;
    let closest = Infinity;
    for (let i = 0; i < 2.5 * 120; i++) {
      w.step(STEP);
      deflection = Math.max(deflection, Math.abs(creep.pos.y));
      closest = Math.min(closest, Math.hypot(hero.pos.x - creep.pos.x, hero.pos.y - creep.pos.y));
    }
    const heroMoved = Math.hypot(hero.pos.x - heroFrom.x, hero.pos.y - heroFrom.y);
    check('a blocked creep is turned aside rather than stalled', deflection > 10, true);
    check('the creep still gets past', creep.pos.x > 2500, true);
    check('a creep cannot shove a hero', heroMoved, 0, 1e-9);
    check('a creep does not walk into a hero', closest >= touching - 1e-6, true);
  }

  {
    // And the other way round: a hero ordered through a creep does not move it,
    // and a line of bodies across the lane stops him dead.
    const w = new World({ ...DEFAULT_CONFIG, heroId: 'swordmaster', seed: 31, enemyHero: false, waves: Infinity });
    const hero = w.player;
    const all = [...w.units.values()];
    const mine = all.find((u) => u.team === 'radiant' && u.kind === 'melee_creep');
    const theirs = all.find((u) => u.team === 'dire' && u.kind === 'melee_creep');
    w.units.clear();
    for (const u of [hero, mine, theirs]) w.units.set(u.id, u);
    // Two creeps trading in melee range stand still, so anything that moves
    // them while the hero walks through was the hero.
    mine.pos = { x: 2200, y: 0 };
    theirs.pos = { x: 2290, y: 0 };
    mine.attackTargetId = theirs.id;
    theirs.attackTargetId = mine.id;
    settle(w, 0.5);
    const before = [{ ...mine.pos }, { ...theirs.pos }];
    hero.pos = { x: 2000, y: 0 };
    hero.moveTarget = { x: 2600, y: 0 };
    for (let i = 0; i < 2 * 120; i++) w.step(STEP);
    const shoved = Math.max(
      Math.hypot(mine.pos.x - before[0].x, mine.pos.y - before[0].y),
      Math.hypot(theirs.pos.x - before[1].x, theirs.pos.y - before[1].y),
    );
    check('a hero cannot shove a creep', shoved, 0, 1e-9);
    check('a hero walks round a creep in his way', hero.pos.x > 2400, true);

    // A wall of bodies from lane edge to lane edge. They stand still because
    // they cannot move, not because anything holds them.
    w.units.clear();
    w.units.set(hero.id, hero);
    const r = constants.bodyRadius('melee_creep');
    for (let y = -constants.LANE_HALF_WIDTH, i = 0; y <= constants.LANE_HALF_WIDTH; y += 2 * r, i++) {
      const c = { ...mine, id: 9000 + i, pos: { x: 2200, y }, moveSpeed: 0, attackTargetId: null, moveTarget: null };
      w.units.set(c.id, c);
    }
    hero.pos = { x: 2000, y: 10 };
    hero.moveTarget = { x: 2600, y: 10 };
    for (let i = 0; i < 2 * 120; i++) w.step(STEP);
    check('a hero is bodyblocked by a line of creeps', hero.pos.x < 2200, true);
  }

  // Stride reversals: steps that point back against the one before. A creep
  // walking round something turns gradually and never reverses, so a count
  // in the hundreds is one shuddering in place.
  const reversals = (w, seconds, only) => {
    const last = new Map();
    let n = 0;
    for (let i = 0; i < seconds * 120; i++) {
      w.step(STEP);
      for (const u of w.units.values()) {
        if (!u.alive || u.kind === 'hero' || u.kind === 'tower' || (only && u !== only)) continue;
        const p = last.get(u.id);
        const m = p ? { x: u.pos.x - p.x, y: u.pos.y - p.y } : null;
        const moved = m && Math.hypot(m.x, m.y) > 1e-6;
        if (moved && p.m && m.x * p.m.x + m.y * p.m.y < 0) n++;
        last.set(u.id, { x: u.pos.x, y: u.pos.y, m: moved ? m : p?.m });
      }
    }
    return n;
  };

  {
    // A creep whose straight way in is walled off by two friends shoulder to
    // shoulder. Sliding off one into the other used to leave a step pointing
    // straight back, taken at full stride and undone the next frame, over
    // and over, and the creep never got there.
    const w = new World({ ...DEFAULT_CONFIG, seed: 31, enemyHero: false, waves: Infinity });
    w.units.clear();
    const put = (team, x, y, still) => {
      const u = units.spawnUnit(units.MELEE_CREEP, team, { x, y }, w.rng);
      if (still) u.moveSpeed = 0;
      w.units.set(u.id, u);
      return u;
    };
    const foe = put('dire', 3000, 0, true);
    put('radiant', 2904, 0, true);
    put('radiant', 2904, 52, true);
    const late = put('radiant', 2800, 20, false);
    check('a creep behind its wave does not shudder', reversals(w, 1.5, late), 0);
    check('it walks round its wave into range', w.inAttackRange(late, foe), true);
  }

  {
    const w = new World({ ...DEFAULT_CONFIG, seed: 99, waves: Infinity });
    // Hundreds to thousands a minute before the fix.
    check('creeps in a busy lane do not shudder', reversals(w, 60) < 20, true);
  }

  {
    // Separation invariant: nothing should end a busy lane inside anything else.
    const w = new World({ ...DEFAULT_CONFIG, seed: 44, waves: Infinity });
    settle(w, 60);
    let worst = 0;
    const alive = w.aliveUnits();
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (a.moveSpeed <= 0 && b.moveSpeed <= 0) continue;
        const min = constants.bodyRadius(a.kind) + constants.bodyRadius(b.kind);
        worst = Math.max(worst, min - Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y));
      }
    }
    // Only a freshly spawned clump may overlap, and only for a frame.
    check('units do not end up stacked', worst < 1, true);
  }

  // --- Drill length: a number of waves, farmed out --------------------------
  {
    const w = new World({ ...DEFAULT_CONFIG, seed: 21, enemyHero: false, waves: 2 });
    let lastCreep = 0;
    for (let i = 0; i < 120 * 300 && !w.finished; i++) {
      w.step(1 / 120);
      if ([...w.units.values()].some((u) => u.alive && u.kind !== 'hero' && u.kind !== 'tower')) lastCreep = w.time;
    }
    check('a two-wave drill ends', w.finished, true);
    check('no third wave spawns', w.waveCount, 2);
    // Not on the clock: the second wave is fought out before the run ends.
    check('the run ends the step the last creep dies', Math.abs(w.time - lastCreep) <= 1 / 120 + 1e-9, true);
  }

  // --- Lane audio: which events become which sounds -----------------------
  // The laning AI plays your side for three minutes against the bot, and a
  // mixer that only counts stands in for Web Audio, so this checks the wiring
  // and not the speakers. Nothing but a person checks the mix.
  {
    const { LaneAudio } = await import('/src/audio/laneAudio.ts');
    const { EnemyHeroAi } = await import('/src/sim/ai/enemyHeroAi.ts');
    const { ENEMY_PROFILES } = await import('/src/sim/config.ts');
    const plays = {};
    const offsets = [];
    const mixer = {
      play: (name, opts = {}) => {
        plays[name] = (plays[name] ?? 0) + 1;
        // With the wind-up it was timed against, which shortens as the archer
        // levels and gains agility.
        if (name === 'bow_draw') {
          const windup = constants.attackPointTime(w.player.attackPoint, w.player.attackSpeedBonus);
          offsets.push({ offset: opts.offset ?? 0, windup });
        }
        return { stop() {} };
      },
      duck() {},
    };
    const w = new World({ ...DEFAULT_CONFIG, heroId: 'frost_archer', enemyHero: true, enemyHeroId: 'swordmaster', seed: 21, waves: Infinity });
    const audio = new LaneAudio(mixer, () => ({ x: 0, onScreen: true }));
    audio.reset(w);
    const me = new EnemyHeroAi(w.player, ENEMY_PROFILES[3]);
    // Two sim steps to a drawn frame, as a 60 Hz display runs it.
    for (let i = 0; i < 180 * 120; i++) {
      if (w.player.alive) me.update(w, STEP);
      w.step(STEP);
      if (i % 2) audio.update(w);
    }
    check('lane audio: a coin for every last hit', plays.last_hit_gold ?? 0, w.stats.lastHits);
    check('lane audio: a deny sound for every deny', plays.deny ?? 0, w.stats.denies);
    check('lane audio: the drill had last hits to count', w.stats.lastHits > 0, true);
    check('lane audio: creep hits play', (plays.melee_creep_hit ?? 0) > 0, true);
    check('lane audio: ranged creeps cast', (plays.ranged_creep_cast ?? 0) > 0, true);
    check('lane audio: the archer draws', (plays.bow_draw ?? 0) > 0, true);
    check('lane audio: the archer releases', (plays.bow_release ?? 0) > 0, true);
    check('lane audio: the bot swings', (plays.sword_swing ?? 0) > 0, true);
    // The archer's windup is 0.403 s at level 1, so the draw starts 0.047 s
    // in (plus up to a frame already gone when it is seen) and ends on the
    // release; a level later the windup is shorter and the offset longer.
    check(
      'lane audio: the draw is offset to end on the release',
      offsets.every(({ offset, windup }) => offset >= 0.45 - windup - 1e-9 && offset <= 0.45 - windup + 2 * STEP + 1e-9),
      true,
    );
    check('lane audio: the archer levelled during it', w.player.level > 1, true);
  }

  // --- Determinism: same seed, same lane ----------------------------------
  {
    const run = () => {
      const w = new World({ ...DEFAULT_CONFIG, seed: 99, waves: 4 });
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
//
// start() needs the renderer, which boot() builds only once every model has
// loaded; the loading screen comes down at that point.
await page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 60000 });
// The menu's backdrop lane is a real World, and it has been running behind the
// menu all this time. It must not have made a sound.
await page.waitForTimeout(1000);
const menuPlays = await page.evaluate(() => window.__lht.audioStats());
results.push({
  name: 'the menu backdrop plays no lane sounds',
  ok: Object.keys(menuPlays).every((n) => n === 'ui_click'),
  actual: JSON.stringify(menuPlays),
  expected: '{}',
});
await page.evaluate(() => {
  window.__lht.start({
    heroId: 'frost_archer',
    waves: 20,
    deniesEnabled: true,
    enemyHero: false,
    enemyHeroId: 'swordmaster',
    enemyDifficulty: 3,
    aggroEnabled: true,
    seed: 4242,
    items: [],
  });
});
// Two seconds on the lane's clock, not the wall's. Under SwiftShader on a slow
// runner a frame can take the best part of a second, and a frame advances the
// sim by at most 0.25 s, so 2.5 s of waiting was once too little time for the
// first melee swing, 0.7 s into the lane, to land.
await page.waitForFunction(() => (window.__lht.world?.time ?? 0) >= 2, null, { timeout: 60000 });

// And a real drill does make them: the seeded lane starts in combat.
const drillPlays = await page.evaluate(() => window.__lht.audioStats());
results.push({
  name: 'a running drill plays creep hits',
  ok: (drillPlays.melee_creep_hit ?? 0) > 0,
  actual: JSON.stringify(drillPlays),
  expected: 'melee_creep_hit > 0',
});
results.push({
  name: 'a run opens with the horn and the ambience',
  ok: drillPlays.horn === 1 && drillPlays.lane_ambience === 1,
  actual: `horn ${drillPlays.horn}, ambience ${drillPlays.lane_ambience}`,
  expected: 'horn 1, ambience 1',
});

const aim = await page.evaluate(() => {
  const w = window.__lht.world;
  const alive = [...w.units.values()].filter((u) => u.alive);
  // Aim at the chest, which is what the cursor looks like it is over and the
  // whole reason picking uses a cylinder instead of the ground point.
  const chest = (u) => window.__lht.toScreen(u.pos, 55);
  // The creep standing clearest of the rest on screen, so the click tests
  // picking rather than which of two overlapping bodies is in front.
  let best = null;
  for (const creep of alive.filter((u) => u.team === 'dire' && u.kind === 'melee_creep')) {
    const at = chest(creep);
    const room = Math.min(
      ...alive.filter((u) => u !== creep).map((u) => Math.hypot(chest(u).x - at.x, chest(u).y - at.y)),
    );
    if (!best || room > best.room) best = { id: creep.id, at, room };
  }
  return best;
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

const endPlays = await page.evaluate(() => {
  window.__lht.finish();
  return window.__lht.audioStats();
});
results.push({ name: 'the results screen plays run_end', ok: endPlays.run_end === 1, actual: endPlays.run_end, expected: 1 });

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
