import type { Team, Unit, UnitKind } from '../sim/types.ts';
import { MODEL_HEIGHT } from './unitView.ts';

/**
 * Everything about how a unit *looks*, in one place.
 *
 * This is render-side data on purpose: `src/sim` has no business knowing that a
 * siege creep is drawn 1.25x or that a health bar hangs 18 units over its head.
 * Keeping it here also stops the two halves of the drawing — the three.js stage
 * and the screen-space overlay — from disagreeing about how tall anything is,
 * which is what produced health bars floating a body-length above their owner.
 */

/** Per-team base colour for the creep rig. */
export const TEAM_TINT: Record<Team, number> = { radiant: 0x4e8f5f, dire: 0xa8564f };

/** Kind nudges the base colour so ranged/siege still read apart at a glance. */
export const KIND_SHIFT: Record<UnitKind, number> = {
  melee_creep: 1,
  ranged_creep: 0.78,
  siege_creep: 0.62,
  hero: 1.35,
  tower: 1,
};

/** Rig scale per kind. A siege creep is a head taller than a melee one. */
export const KIND_SCALE: Record<UnitKind, number> = {
  melee_creep: 1,
  ranged_creep: 0.88,
  siege_creep: 1.25,
  hero: 1.45,
  tower: 1,
};

/** Height of the drawn tower body, mirroring the mesh the renderer builds. */
export const TOWER_HEIGHT = 260;

/** Top of the siege catapult's frame with its arm down, mirroring SiegeView. */
export const SIEGE_HEIGHT = 150;
/** Half the catapult's width across the axle. */
export const SIEGE_RADIUS = 42;

/** Top of a unit's drawn volume, in sim units above the lane. */
export function rigHeight(unit: Unit): number {
  if (unit.kind === 'tower') return TOWER_HEIGHT;
  if (unit.kind === 'siege_creep') return SIEGE_HEIGHT;
  return MODEL_HEIGHT * (KIND_SCALE[unit.kind] ?? 1);
}

/**
 * Where the health bar hangs. Just clear of the head rather than a fixed
 * number per kind, so resizing a rig moves its bar with it.
 */
export function healthBarHeight(unit: Unit): number {
  return rigHeight(unit) + (unit.kind === 'hero' ? 26 : 16);
}

/**
 * Half-width of a unit's drawn body in sim units.
 *
 * Deliberately not the collision hull: a ranged creep's hull is 8 units, which
 * is a third of the body you can see, and clicking on what you can see is the
 * whole point of picking. The rig's widest span is arm to arm, about 24 units
 * before scaling.
 */
export function pickRadius(unit: Unit): number {
  if (unit.kind === 'tower') return TOWER_VISUAL_RADIUS;
  if (unit.kind === 'siege_creep') return SIEGE_RADIUS;
  return Math.max(unit.radius, 24 * (KIND_SCALE[unit.kind] ?? 1));
}

/**
 * How wide the tower is *drawn*. Its collision hull is 144 — that is what keeps
 * units from walking through it — but a tier 1 tower is nothing like 288 units
 * across on screen, so the mesh uses its own number.
 */
export const TOWER_VISUAL_RADIUS = 56;
