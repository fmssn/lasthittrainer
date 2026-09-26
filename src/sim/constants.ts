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

/** Siege creeps join every Nth wave. */
export const SIEGE_EVERY_N_WAVES = 5;

/** A creep can be denied at or below this fraction of max HP. */
export const DENY_THRESHOLD = 0.5;

/**
 * Acquisition range per unit kind, from `AttackAcquisitionRange` in
 * npc_units.txt. This is one range, not two: it is both the distance at which a
 * unit picks up a target on its own and the distance its forced-aggro check
 * runs in. A siege creep therefore notices a pull from much further out than a
 * melee one does, and a tower further still.
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

/** How long forced (hero-triggered) creep aggro lasts. */
export const AGGRO_DURATION = 2.3;

/**
 * Cooldown on the forced-aggro system, per hero. A second attack order inside
 * this window runs no aggro check at all, which is what makes a pull a
 * commitment rather than something you can spam back and forth.
 */
export const AGGRO_COOLDOWN = 3;

/**
 * Melee lane creeps carry `creep_irresolute`, whose only effect is
 * `hero_damage_penalty -25`: they deal 25% less damage to heroes. Ranged and
 * siege creeps have no such ability and hit heroes at full damage.
 *
 * This asymmetry is most of why standing in a melee wave is survivable while
 * pulling a ranged creep onto yourself genuinely hurts, so the aggro layer is
 * not honest without it.
 */
export const MELEE_CREEP_HERO_DAMAGE_PENALTY = 0.25;

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
 * What one point of each attribute is worth. Heroes here are always level 1, so
 * these are applied once when the template is built rather than on level-up —
 * the drill has no experience. Primary attribute additionally gives +1 attack
 * damage per point.
 */
export const PER_STRENGTH_HP = 22;
export const PER_STRENGTH_HP_REGEN = 0.1;
export const PER_AGILITY_ARMOR = 0.167;
export const PER_AGILITY_ATTACK_SPEED = 1;

/** Every hero starts from the same chassis, per `npc_dota_hero_base.txt`. */
export const HERO_BASE_HP = 120;
export const HERO_BASE_HP_REGEN = 0.25;

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
