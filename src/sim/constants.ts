/**
 * Dota 2 (7.3x) constants.
 *
 * Every value here is meant to match the real game. If a number is a deliberate
 * simplification it says so. Keep tuning knobs out of this file — this is the
 * reference sheet, `difficulty.ts` holds the training modifiers.
 */

/** Seconds between creep waves. */
export const WAVE_INTERVAL = 30;

/** Siege creeps join every Nth wave. */
export const SIEGE_EVERY_N_WAVES = 5;

/** A creep can be denied at or below this fraction of max HP. */
export const DENY_THRESHOLD = 0.5;

/** Radius in which an idle unit will acquire a new target. */
export const ACQUISITION_RANGE = 500;

/**
 * Creeps leash to the target they are already hitting until it leaves this
 * radius — this is what makes a wave clump and hold equilibrium.
 */
export const LEASH_RANGE = 700;

/** How long forced (hero-triggered) creep aggro lasts. */
export const AGGRO_DURATION = 2.3;

/** Range within which right-clicking an enemy hero pulls nearby creep aggro. */
export const AGGRO_TRIGGER_RANGE = 500;

/** Units of lane between the two spawn points. */
export const LANE_LENGTH = 6000;

/** Half-width of the walkable lane corridor. */
export const LANE_HALF_WIDTH = 420;

/** Hero respawn/idle facing turn rate, radians per second (Dota turn rate 0.6-0.9). */
export const DEFAULT_TURN_RATE = 0.6;

/**
 * Dota 2 armor formula (7.x). Positive armor reduces, negative amplifies,
 * and it is symmetric around zero.
 */
export function armorMultiplier(armor: number): number {
  return 1 - (0.06 * armor) / (1 + 0.06 * Math.abs(armor));
}

/** Effective HP against physical damage, i.e. how much raw damage it takes to kill. */
export function effectiveHp(hp: number, armor: number): number {
  return hp / armorMultiplier(armor);
}

/** Time between attack starts. */
export function attackInterval(baseAttackTime: number, attackSpeedBonus: number): number {
  return baseAttackTime / (1 + attackSpeedBonus / 100);
}

/**
 * Wind-up duration. Attack point is authored in seconds (independent of BAT)
 * and, like the attack interval, scales with attack speed.
 */
export function attackPointTime(attackPoint: number, attackSpeedBonus: number): number {
  return attackPoint / (1 + attackSpeedBonus / 100);
}
