/**
 * Dota 2 (7.3x) constants.
 *
 * Every value here is meant to match the real game. Where a number came out of
 * Valve's own `npc_units.txt` / `scripts/npc/heroes/*.txt` it is exact; where it
 * describes behaviour the scripts do not encode (aggro timing, turn rate, the
 * attack-animation model) the source is named in the comment. If a value is a
 * deliberate simplification it says so. Keep tuning knobs out of this file —
 * this is the reference sheet, `config.ts` holds the training modifiers.
 */

import type { UnitKind } from './types.ts';

/** Seconds between creep waves. */
export const WAVE_INTERVAL = 30;

/**
 * Siege creeps join every 10th wave, the first at 5:00 (7.06, down from every
 * 7th). Every drill here ends by 5:00, so none ever reaches the lane.
 */
export const SIEGE_EVERY_N_WAVES = 10;

/** A creep can be denied at or below this fraction of max HP. */
export const DENY_THRESHOLD = 0.5;

/**
 * Acquisition range per unit kind, from `AttackAcquisitionRange` in
 * npc_units.txt: how far away a unit picks up a target on its own, and the
 * pool it chooses from when it picks again. Forced aggro does not use it; see
 * {@link AGGRO_RADIUS}.
 */
const ACQUISITION_RANGE_BY_KIND: Record<UnitKind, number> = {
  melee_creep: 500,
  ranged_creep: 600,
  siege_creep: 800,
  tower: 700,
  // Heroes vary, from 600 to 950; they never auto-acquire in this
  // drill, so one representative value is enough.
  hero: 800,
};

/** Acquisition range for `kind`. */
export function acquisitionRange(kind: UnitKind): number {
  return ACQUISITION_RANGE_BY_KIND[kind] ?? 500;
}

/**
 * How far from the hero giving an attack order the forced-aggro check reaches:
 * one radius for melee, ranged and siege creeps and for towers alike. Valve's
 * glossary names a single `DOTA_UNIT_ANGER_RADIUS`, a 2015 convar dump has
 * `dota_unit_anger_radius 500`, and in lobby tests a ranged creep 550 away does
 * not come while one at 450 does.
 */
export const AGGRO_RADIUS = 500;

/** How long forced (hero-triggered) creep aggro lasts. */
export const AGGRO_DURATION = 2.3;

/**
 * Cooldown on the aggro system, per hero, started by every attack order on an
 * enemy hero whether or not a creep was near. While it runs, attacks on heroes
 * draw nothing and aggro cannot be handed back, which is what makes a pull a
 * commitment: aggro you pulled yourself cannot be shed before it wears off.
 */
export const AGGRO_COOLDOWN = 3;

/**
 * Until 5:00, lane creeps ignore hero aggro unless an enemy creep is inside
 * their acquisition range or they are within 1550 of their own tier 1 tower
 * (`DOTA_Patch_7_27_General_23`; Liquipedia gives 1500). Towers are not lane
 * creeps and always respond.
 */
export const AGGRO_BLOCK_UNTIL = 300;
export const AGGRO_BLOCK_TOWER_RANGE = 1550;

/**
 * A tower drops its target for a closer unit on the same side when that
 * target orders an attack on an ally, at most once per this many seconds
 * (Liquipedia, Tower: `tower aggro cooldown`).
 */
export const TOWER_DEAGGRO_COOLDOWN = 2.5;

/**
 * Attack classes. Since 7.31 the old attack and armor types are passives on
 * the units themselves (`Ability1` in npc_units.txt), valued in
 * npc_abilities.txt:
 *
 *   creep_irresolute  melee creeps     hero_damage_penalty -25
 *   creep_piercing    ranged creeps    creep_damage_bonus 50, hero_damage_penalty -50,
 *                                      heavy_damage_penalty -50
 *   creep_siege       siege creeps     bonus_building_damage 150,
 *                     and towers       incoming_hero_damage_penalty -50,
 *                                      incoming_basic_damage_penalty -30
 *
 * The heavy side's incoming penalties stack with the attacker's own, which is
 * how a ranged creep lands at 35% on a siege creep (0.5 x 0.7). The rows below
 * are the composed factors as Liquipedia's attack class table gives them, and
 * they are the pre-7.31 type chart exactly. Heroes carry no class: full damage,
 * except half against anything heavy.
 *
 * So a ranged creep, the wave's damage dealer against creeps, is the gentlest
 * thing in it to be hit by, and a catapult takes twice the swings its health
 * bar suggests.
 */
const ATTACK_CLASS: Record<UnitKind, readonly [vsHero: number, vsUnit: number, vsHeavy: number]> = {
  hero: [1, 1, 0.5],
  melee_creep: [0.75, 1, 0.7],
  ranged_creep: [0.5, 1.5, 0.35],
  siege_creep: [1, 1, 2.5],
  tower: [1, 1, 2.5],
};

/** Attack damage multiplier for an attack by `source` landing on `target`. */
export function attackClassFactor(source: UnitKind, target: UnitKind): number {
  const against = target === 'hero' ? 0 : target === 'siege_creep' || target === 'tower' ? 2 : 1;
  return ATTACK_CLASS[source][against];
}

/** Half-width of the walkable lane corridor. */
export const LANE_HALF_WIDTH = 420;

/**
 * Collision radii, standardised per `BoundsHullName` rather than authored per
 * unit. DOTA_HULL_SIZE_SMALL 8, REGULAR 16, HERO 24, SIEGE 16, TOWER 144.
 */
export const HULL = {
  small: 8,
  regular: 16,
  hero: 24,
  siege: 16,
  tower: 144,
} as const;

/**
 * How close two bodies may stand, per kind. A deliberate departure from
 * {@link HULL}, which still sets attack range.
 *
 * The hulls are right for Valve's models, not for the ones drawn here: a KayKit
 * melee creep's torso alone is about 16 units across its middle, so at hull
 * contact two creeps stand shield inside shield, and a ranged creep's hull of
 * 8 lets a whole wave fold into one silhouette. These follow the drawn bodies
 * instead, keeping the hero a head wider than a creep as the hulls do.
 */
const BODY_RADIUS: Record<UnitKind, number> = {
  melee_creep: 26,
  ranged_creep: 24,
  siege_creep: 34,
  hero: 34,
  tower: HULL.tower,
};

/** Collision radius for bodies of `kind` meeting each other. */
export function bodyRadius(kind: UnitKind): number {
  return BODY_RADIUS[kind];
}

/**
 * Turn rate is expressed in radians per 0.03 s, so angular speed is
 * `turnRate / 0.03` rad/s and a 180 degree turn takes `0.03 * PI / turnRate`
 * seconds — about 0.157 s at the common hero turn rate of 0.6.
 */
export const TURN_RATE_TICK = 0.03;

/** Angular speed in radians per second for a unit with this turn rate. */
export function turnSpeed(turnRate: number): number {
  return turnRate / TURN_RATE_TICK;
}

/** Fallback facing turn rate, for units that do not state one. */
export const DEFAULT_TURN_RATE = 0.6;

// --------------------------------------------------------------- attributes

/**
 * What one point of each attribute is worth. Primary attribute additionally
 * gives +1 attack damage per point. Armor is exactly a sixth
 * (`DOTA_Patch_7_27_General_30`), which Valve's own computed 5.3333335 for the
 * Swordmaster's 32 agility bears out; the 0.167 the wikis print is that
 * rounded.
 */
export const PER_STRENGTH_HP = 22;
export const PER_STRENGTH_HP_REGEN = 0.1;
export const PER_AGILITY_ARMOR = 1 / 6;
export const PER_AGILITY_ATTACK_SPEED = 1;

/** Every hero starts from the same chassis, per `npc_dota_hero_base.txt`. */
export const HERO_BASE_HP = 120;
export const HERO_BASE_HP_REGEN = 0.25;

// --------------------------------------------------------------- experience
//
// None of this is in the scripts; Dota compiles it into the server. Values
// name the patch note that set them (patchnotes_english.txt) where one exists,
// and all of them agree with Liquipedia as of 7.41f.

/**
 * Total experience needed for each level; index 0 is level 1. The steps are
 * 7.32's (`DOTA_Patch_7_32_General_2_info`): 240, 400, 520, 600, 680, 760, 800,
 * 900, 1000, then 100 more a level up to 2000, 200 more up to 3000, and 1000
 * more up to 8000. One wave, 3 x 57 + 69, is exactly level 2.
 */
export const LEVEL_XP: readonly number[] = [
  0, 240, 640, 1160, 1760, 2440, 3200, 4000, 4900, 5900, 7000, 8200, 9500, 10900, 12400, 14000, 15700, 17500,
  19400, 21400, 23600, 26000, 28600, 31400, 34400, 38400, 43400, 49400, 56400, 64400,
];

export const MAX_LEVEL = LEVEL_XP.length;

/** The level this much total experience buys. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= LEVEL_XP[level]) level++;
  return level;
}

/**
 * A death pays its experience to the living enemy heroes within this range of
 * it, split evenly with each share truncated. Who landed the blow does not
 * matter: a hero near the wave levels whether it last hits or not, and one
 * that is dead or out of range gets nothing. Measured from the victim's centre.
 */
export const XP_RANGE = 1500;

/**
 * A denied creep still pays its enemies half (`DOTA_Patch_7_26b_General_2`,
 * up from 40%). The denier gets nothing for it, so a deny is XP taken from
 * the other side rather than XP earned.
 */
export const DENY_XP_FACTOR = 0.5;

/**
 * A hero kill pays 100 plus 13% of the victim's experience
 * (`DOTA_Patch_7_27_General`, `DOTA_Patch_7_23d_General_3`), growing no further
 * past level 25. Streak bonuses come on top from a third kill in a row, which
 * a few minutes of lane never builds, so they are left out.
 */
export function heroKillXp(victimXp: number): number {
  return 100 + 0.13 * Math.min(victimXp, LEVEL_XP[24]);
}

/**
 * Seconds dead, by level. 7.24 set levels 1-5 (`DOTA_Patch_7_24_General_22`);
 * the rest is Liquipedia's table, which no later note has changed.
 */
const RESPAWN_TIME = [12, 15, 18, 21, 24, 26, 28, 30, 32, 34, 36, 44, 46, 48, 50, 52, 54, 65, 70, 75, 80, 85, 90, 95, 100];

export function respawnTime(level: number): number {
  return RESPAWN_TIME[Math.min(level, RESPAWN_TIME.length) - 1];
}

/**
 * Dota 2 armor formula (7.x). Positive armor reduces, negative amplifies,
 * and it is symmetric around zero.
 */
export function armorMultiplier(armor: number): number {
  return 1 - (0.06 * armor) / (1 + 0.06 * Math.abs(armor));
}

/** Time between attack starts. */
export function attackInterval(baseAttackTime: number, attackSpeedBonus: number): number {
  return baseAttackTime / (1 + attackSpeedBonus / 100);
}

/**
 * Wind-up duration. `AttackAnimationPoint` is authored in seconds, independent
 * of base attack time, and both halves of the animation are divided by the same
 * `1 + IAS/100` the attack interval is — so attack speed shortens the swing
 * itself, not just the gap between swings. That is why a hero with agility in
 * the bank feels snappier to last hit with than its raw attack point suggests.
 */
export function attackPointTime(attackPoint: number, attackSpeedBonus: number): number {
  return attackPoint / (1 + attackSpeedBonus / 100);
}

/** Backswing, scaled by attack speed the same way the wind-up is. */
export function attackBackswingTime(backswing: number, attackSpeedBonus: number): number {
  return backswing / (1 + attackSpeedBonus / 100);
}
