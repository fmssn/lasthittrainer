import type { Team, Unit, UnitKind, Vec2 } from './types.ts';
import { DEFAULT_TURN_RATE, HULL } from './constants.ts';

let nextId = 1;
export function resetIds() {
  nextId = 1;
}

/** Stat block for a spawnable unit. Bounty/damage are rolled per instance. */
export interface UnitTemplate {
  kind: UnitKind;
  name: string;
  radius: number;
  maxHp: number;
  hpRegen: number;
  armor: number;
  damageMin: number;
  damageMax: number;
  attackRange: number;
  baseAttackTime: number;
  attackPoint: number;
  attackBackswing: number;
  projectileSpeed: number;
  moveSpeed: number;
  turnRate: number;
  bountyMin: number;
  bountyMax: number;
  bountyXp: number;
  /** Heroes carry attack speed from agility; creeps and towers have none. */
  attackSpeedBonus?: number;
  /** Only heroes carrying a Quelling Blade have this. */
  creepDamageBonus?: number;
}

/**
 * Lane creeps, straight out of Valve's `npc_units.txt` (no per-minute HP/damage
 * scaling — a training drill is always "minute zero", which is also the hardest
 * timing to learn).
 *
 * `attackBackswing` is the one number here that is not in the scripts: Dota
 * takes it from the unit's attack animation rather than from data. These are
 * community-measured values, and they only govern how long a unit is committed
 * after the damage lands, so an error costs feel rather than last-hit maths.
 */
export const MELEE_CREEP: UnitTemplate = {
  kind: 'melee_creep',
  name: 'Melee Creep',
  radius: HULL.regular,
  maxHp: 550,
  hpRegen: 0.5,
  armor: 2,
  damageMin: 19,
  damageMax: 23,
  attackRange: 100,
  baseAttackTime: 1.0,
  attackPoint: 0.467,
  attackBackswing: 0.3,
  projectileSpeed: 0,
  moveSpeed: 325,
  turnRate: 0.5,
  bountyMin: 34,
  bountyMax: 39,
  bountyXp: 57,
};

export const RANGED_CREEP: UnitTemplate = {
  kind: 'ranged_creep',
  name: 'Ranged Creep',
  radius: HULL.small,
  maxHp: 300,
  // Ranged creeps regen four times as fast as melee ones, which is why a
  // harassed ranged creep is back to full before the next wave arrives.
  hpRegen: 2,
  armor: 0,
  damageMin: 21,
  damageMax: 26,
  attackRange: 500,
  baseAttackTime: 1.0,
  attackPoint: 0.5,
  attackBackswing: 0.3,
  projectileSpeed: 900,
  moveSpeed: 325,
  turnRate: 0.5,
  bountyMin: 43,
  bountyMax: 52,
  bountyXp: 69,
};

export const SIEGE_CREEP: UnitTemplate = {
  kind: 'siege_creep',
  name: 'Siege Creep',
  radius: HULL.siege,
  maxHp: 935,
  hpRegen: 0,
  armor: 0,
  damageMin: 35,
  damageMax: 46,
  attackRange: 690,
  baseAttackTime: 3.0,
  attackPoint: 0.7,
  attackBackswing: 0.5,
  projectileSpeed: 1100,
  moveSpeed: 325,
  turnRate: 0.5,
  bountyMin: 59,
  bountyMax: 72,
  bountyXp: 88,
};

/**
 * Tier 1 tower. It is invulnerable here on purpose: the drill is about the
 * creep wave, and a tower that can fall turns every run into a different game.
 * It still shoots, which is what anchors the lane and punishes tower dives.
 */
export const TOWER: UnitTemplate = {
  kind: 'tower',
  name: 'Tower',
  radius: HULL.tower,
  maxHp: 1800,
  hpRegen: 0,
  armor: 12,
  damageMin: 88,
  damageMax: 92,
  attackRange: 700,
  baseAttackTime: 0.9,
  attackPoint: 0.6,
  attackBackswing: 0.3,
  projectileSpeed: 750,
  moveSpeed: 0,
  turnRate: 100,
  bountyMin: 0,
  bountyMax: 0,
  bountyXp: 0,
};

export function rollDamage(unit: Unit, rng: () => number): number {
  return unit.damageMin + rng() * (unit.damageMax - unit.damageMin);
}

export function spawnUnit(tpl: UnitTemplate, team: Team, pos: Vec2, rng: () => number): Unit {
  return {
    id: nextId++,
    kind: tpl.kind,
    team,
    name: tpl.name,
    pos: { x: pos.x, y: pos.y },
    facing: team === 'radiant' ? 0 : Math.PI,
    radius: tpl.radius,
    moveSpeed: tpl.moveSpeed,
    turnRate: tpl.turnRate || DEFAULT_TURN_RATE,
    hp: tpl.maxHp,
    maxHp: tpl.maxHp,
    hpRegen: tpl.hpRegen,
    armor: tpl.armor,
    damageMin: tpl.damageMin,
    damageMax: tpl.damageMax,
    attackRange: tpl.attackRange,
    baseAttackTime: tpl.baseAttackTime,
    attackPoint: tpl.attackPoint,
    attackBackswing: tpl.attackBackswing,
    projectileSpeed: tpl.projectileSpeed,
    attackSpeedBonus: tpl.attackSpeedBonus ?? 0,
    creepDamageBonus: tpl.creepDamageBonus ?? 0,
    bounty: Math.round(tpl.bountyMin + rng() * (tpl.bountyMax - tpl.bountyMin)),
    bountyXp: tpl.bountyXp,
    level: 1,
    experience: 0,
    alive: true,
    attackTargetId: null,
    moveTarget: null,
    attackMove: false,
    phase: 'idle',
    phaseTimer: 0,
    attackCooldown: 0,
    aggroTargetId: null,
    aggroTimer: 0,
    aggroCooldown: 0,
    shunnedId: null,
  };
}
