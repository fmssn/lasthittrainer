import type { Unit } from '../types.ts';
import type { World } from '../world.ts';
import { DIRE_SPAWN, RADIANT_SPAWN } from '../world.ts';
import { acquisitionRange } from '../constants.ts';
import { dist } from '../math.ts';

/**
 * Lane creep behaviour, in Dota's own order.
 *
 * The part that surprises people is that creeps are *sticky*. A creep standing
 * and swinging does not re-check which enemy is nearest; it keeps hitting what
 * it is hitting until that target dies or leaves its attack range, and only
 * switches early for a target of higher unit-type priority that has walked into
 * range. When the target does leave, the creep does not chase it — it takes the
 * next valid thing already inside its attack range instead. That stickiness is
 * what lets a wave hold an equilibrium rather than smearing itself down the
 * lane after whatever moved last.
 *
 * Priority order, highest first:
 *   1. forced aggro from a hero's attack order
 *   2. the current target, while it is alive and in attack range
 *   3. the best unit type already inside attack range
 *   4. the nearest enemy inside acquisition range — walk at it
 *   5. nothing: march down the lane
 */
export function runCreepAi(world: World, creep: Unit) {
  // A swing already under way is never re-aimed. In Dota the attack finishes on
  // the unit it started on, and without this guard the damage would be handed
  // to whatever the creep switched to mid-wind-up.
  if (creep.phase === 'windup') return;

  const forced = world.get(creep.aggroTargetId);
  if (forced) {
    creep.attackTargetId = forced.id;
    creep.moveTarget = null;
    return;
  }

  const current = world.get(creep.attackTargetId);
  if (current && world.inAttackRange(creep, current)) {
    const better = bestInAttackRange(world, creep);
    if (better && priority(creep, better) > priority(creep, current)) {
      creep.attackTargetId = better.id;
    }
    creep.moveTarget = null;
    return;
  }

  // Target dead or walked off: prefer something already in range over chasing.
  const standing = bestInAttackRange(world, creep);
  if (standing) {
    creep.attackTargetId = standing.id;
    creep.moveTarget = null;
    return;
  }

  const acquired = nearestInAcquisition(world, creep);
  if (acquired) {
    creep.attackTargetId = acquired.id;
    creep.moveTarget = null;
    return;
  }

  creep.attackTargetId = null;
  creep.moveTarget =
    creep.moveSpeed > 0 ? { x: creep.team === 'radiant' ? DIRE_SPAWN : RADIANT_SPAWN, y: 0 } : null;
}

/**
 * Unit-type preference. Lane creeps go for other lane creeps first, which is
 * the whole reason you can stand inside an enemy wave all day and take nothing
 * — right up until you give one of them a reason to look at you.
 *
 * Siege creeps are built for buildings and rank them top, with enemy siege
 * second. Towers have no type preference of their own; forced aggro is what
 * moves a tower off the nearest target.
 */
function priority(creep: Unit, target: Unit): number {
  if (creep.kind === 'tower') return 1;
  if (creep.kind === 'siege_creep') {
    if (target.kind === 'tower') return 4;
    if (target.kind === 'siege_creep') return 3;
    return target.kind === 'hero' ? 1 : 2;
  }
  if (target.kind === 'tower') return 1;
  return target.kind === 'hero' ? 2 : 3;
}

/** Highest-priority enemy the creep could hit without moving, nearest to break ties. */
function bestInAttackRange(world: World, creep: Unit): Unit | null {
  let best: Unit | null = null;
  let bestP = -Infinity;
  let bestD = Infinity;
  for (const u of world.units.values()) {
    if (!u.alive || u.team === creep.team) continue;
    if (!world.inAttackRange(creep, u)) continue;
    const p = priority(creep, u);
    const d = dist(creep.pos, u.pos);
    if (p > bestP || (p === bestP && d < bestD)) {
      bestP = p;
      bestD = d;
      best = u;
    }
  }
  return best;
}

/** Nearest enemy worth walking at, within this kind's acquisition range. */
function nearestInAcquisition(world: World, creep: Unit): Unit | null {
  let best: Unit | null = null;
  let bestP = -Infinity;
  let bestD = acquisitionRange(creep.kind);
  for (const u of world.units.values()) {
    if (!u.alive || u.team === creep.team) continue;
    const d = dist(creep.pos, u.pos);
    if (d > acquisitionRange(creep.kind)) continue;
    const p = priority(creep, u);
    if (p > bestP || (p === bestP && d < bestD)) {
      bestP = p;
      bestD = d;
      best = u;
    }
  }
  return best;
}
