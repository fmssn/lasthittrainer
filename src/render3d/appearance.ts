import type { Team, Unit, UnitKind } from '../sim/types.ts';
import type { SpriteFit } from './spriteView.ts';

/**
 * Everything about how a unit *looks*, in one place.
 *
 * This is render-side data on purpose: `src/sim` has no business knowing that a
 * hero is drawn 1.45x or that a health bar hangs 18 units over its head.
 * Keeping it here also stops the two halves of the drawing — the three.js stage
 * and the screen-space overlay — from disagreeing about how tall anything is,
 * which is what produced health bars floating a body-length above their owner.
 */

/**
 * Sim units per metre of the models the sprites are rendered from. The first
 * rig, a 1.85 m box creep, read right at about 100 units, and every unit has
 * been drawn to that since. build_props.py bakes the catapults, towers and
 * scenery into these metres, so they need no scale of their own.
 */
export const UNITS_PER_METRE = 54;

/** Head height of an unscaled character, in sim units; the per-kind scale multiplies it. */
export const MODEL_HEIGHT = 1.85 * UNITS_PER_METRE;

/** Per-team colour a hero's key ramp takes. */
export const TEAM_TINT: Record<Team, number> = { radiant: 0x4e8f5f, dire: 0xa8564f };

/** Heroes wear the team colour a shade brighter than the base. */
export const HERO_TINT_SHIFT = 1.35;

/**
 * Character scale per kind. The catapult and tower are built to size in
 * build_props.py, so theirs is 1.
 */
export const KIND_SCALE: Record<UnitKind, number> = {
  melee_creep: 1,
  ranged_creep: 0.88,
  siege_creep: 1,
  hero: 1.45,
  tower: 1,
};

/** Height of the drawn tower, as build_props.py builds it (4.8 m). */
export const TOWER_HEIGHT = 260;

/** Top of the siege catapult with its arm down, as build_props.py builds it. */
export const SIEGE_HEIGHT = 140;
/** Half the catapult's width across the axle. */
export const SIEGE_RADIUS = 48;

/**
 * How a unit's sprite stands in the scene. The depth lift clears the body's
 * own footprint, and the shadow capsule is about the size of what is drawn.
 */
export function spriteFit(kind: UnitKind): SpriteFit {
  const scale = KIND_SCALE[kind] ?? 1;
  const unitsPerMetre = UNITS_PER_METRE * scale;
  if (kind === 'tower') return { unitsPerMetre, lift: 70, shadowRadius: TOWER_VISUAL_RADIUS, shadowHeight: TOWER_HEIGHT };
  if (kind === 'siege_creep') return { unitsPerMetre, lift: 60, shadowRadius: SIEGE_RADIUS, shadowHeight: SIEGE_HEIGHT * 0.8 };
  return { unitsPerMetre, lift: 28 * scale, shadowRadius: 15 * scale, shadowHeight: MODEL_HEIGHT * scale * 0.88 };
}

/** The sprite sheet a unit is drawn from; a hero's goes by its hero id instead. */
export function sheetId(unit: Unit): string {
  if (unit.kind === 'tower') return `tower_${unit.team}`;
  return `${unit.kind}_${unit.team}`;
}

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
 * whole point of picking. A character's widest span is arm to arm, about 24
 * units before scaling.
 */
export function pickRadius(unit: Unit): number {
  if (unit.kind === 'tower') return TOWER_VISUAL_RADIUS;
  if (unit.kind === 'siege_creep') return SIEGE_RADIUS;
  return Math.max(unit.radius, 24 * (KIND_SCALE[unit.kind] ?? 1));
}

/**
 * How wide the tower is *drawn*. Its collision hull is 144 — that is what keeps
 * units from walking through it — but a tier 1 tower is nothing like 288 units
 * across on screen, so the sprite uses its own number.
 */
export const TOWER_VISUAL_RADIUS = 56;
