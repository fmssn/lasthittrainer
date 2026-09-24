import type { Team, Unit, UnitKind, Vec2 } from './types.ts';
import { DEFAULT_TURN_RATE } from './constants.ts';

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
  xp: number;
}

/**
 * Lane creeps, 7.3x base values (no per-minute HP/damage scaling — a training
 * drill is always "minute zero", which is also the hardest timing to learn).
 */
export const MELEE_CREEP: UnitTemplate = {
  kind: 'melee_creep',
  name: 'Melee Creep',
  radius: 24,
  maxHp: 550,
  hpRegen: 0.5,
  armor: 2,
  damageMin: 19,
  damageMax: 23,
  attackRange: 100,
  baseAttackTime: 1.0,
  attackPoint: 0.33,
  attackBackswing: 0.3,
  projectileSpeed: 0,
  moveSpeed: 325,
  turnRate: 0.5,
  bountyMin: 36,
  bountyMax: 46,
  xp: 62,
};

export const RANGED_CREEP: UnitTemplate = {
  kind: 'ranged_creep',
  name: 'Ranged Creep',
  radius: 20,
  maxHp: 300,
  hpRegen: 0.3,
  armor: 1,
  damageMin: 23,
  damageMax: 27,
  attackRange: 500,
  baseAttackTime: 1.0,
  attackPoint: 0.33,
  attackBackswing: 0.3,
  projectileSpeed: 900,
  moveSpeed: 325,
  turnRate: 0.5,
  bountyMin: 41,
  bountyMax: 51,
  xp: 41,
};

export const SIEGE_CREEP: UnitTemplate = {
  kind: 'siege_creep',
  name: 'Siege Creep',
  radius: 28,
  maxHp: 875,
  hpRegen: 0,
  armor: 0,
  damageMin: 40,
  damageMax: 52,
  attackRange: 690,
  baseAttackTime: 3.0,
  attackPoint: 0.5,
  attackBackswing: 0.5,
  projectileSpeed: 1100,
  moveSpeed: 325,
  turnRate: 0.5,
  bountyMin: 62,
  bountyMax: 72,
  xp: 88,
};

/**
 * Tier 1 tower. It is invulnerable here on purpose: the drill is about the
 * creep wave, and a tower that can fall turns every run into a different game.
 * It still shoots, which is what anchors the lane and punishes tower dives.
 */
export const TOWER: UnitTemplate = {
  kind: 'tower',
  name: 'Tower',
  radius: 44,
  maxHp: 1800,
  hpRegen: 0,
  armor: 16,
  damageMin: 104,
  damageMax: 116,
  attackRange: 700,
  baseAttackTime: 1.0,
  attackPoint: 0.3,
  attackBackswing: 0.3,
  projectileSpeed: 750,
  moveSpeed: 0,
  turnRate: 100,
  bountyMin: 0,
  bountyMax: 0,
  xp: 0,
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
    attackSpeedBonus: 0,
    bounty: Math.round(tpl.bountyMin + rng() * (tpl.bountyMax - tpl.bountyMin)),
    xp: tpl.xp,
    alive: true,
    orderTargetId: null,
    attackTargetId: null,
    moveTarget: null,
    attackMove: false,
    phase: 'idle',
    phaseTimer: 0,
    attackCooldown: 0,
    aggroTargetId: null,
    aggroTimer: 0,
    incomingDamage: 0,
  };
}
