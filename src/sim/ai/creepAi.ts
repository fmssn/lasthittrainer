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
 * range. That stickiness is what lets a wave hold an equilibrium rather than
 * smearing itself down the lane after whatever moved last.
 *
 * When it does pick again, threat comes before distance: something hitting the
 * creep beats something hitting its allies, which beats something doing
 * neither. So a hero standing idle beside a fighting wave is left alone, and a
 * hero last hitting in it is fair game whenever it is the nearest of the
 * threats. That is Liquipedia's account of the re-pick, and it is what lobby
 * tests show: creeps passing over a closer idle hero for a farther one hitting
 * them.
 *
 * There is no leash. With nothing better inside its acquisition range, a creep
 * keeps chasing what it was after for as long as it lives; with no fog here,
 * it never loses sight of it.
 *
 * A hero that hands its aggro back (an attack order on its own unit) is
 * dropped and ranked below everything else until the creep has settled on a
 * new target, which it keeps only if nothing else is there to take.
 *
 * Priority order, highest first:
 *   1. forced aggro from a hero's attack order
 *   2. the current target, while it is alive and in attack range
 *   3. the best enemy inside acquisition range, by unit type, then threat, then
 *      distance, where distance alone never takes it off what it is already
 *      walking at — walk at it
 *   4. the current target, wherever it has gone
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

  const shunned = world.get(creep.shunnedId);
  if (!shunned) creep.shunnedId = null;

  let current = world.get(creep.attackTargetId);
  if (current === shunned) current = null;
  if (current && world.inAttackRange(creep, current)) {
    creep.shunnedId = null;
    const better = bestInAttackRange(world, creep);
    if (better && priority(creep, better) > priority(creep, current)) {
      creep.attackTargetId = better.id;
    }
    creep.moveTarget = null;
    return;
  }

  // Walking at something is sticky too. Re-picking every frame flipped between
  // two enemies at about the same distance, since each step towards one left
  // the other the closer, and the creep swayed on the spot. So distance alone
  // never takes it off what it is walking at; type and threat still do.
  const best = bestInAcquisition(world, creep, shunned);
  const keep = !!current && !!best && candidate(world, creep, current) && !outranks(world, creep, best, current);
  const picked = keep ? current : (best ?? (creep.moveSpeed > 0 ? current : null));
  if (picked) {
    if (picked === shunned) creep.shunnedId = null;
    creep.attackTargetId = picked.id;
    creep.moveTarget = null;
    return;
  }

  creep.shunnedId = null;
  creep.attackTargetId = null;
  creep.moveTarget =
    creep.moveSpeed > 0 ? { x: creep.team === 'radiant' ? DIRE_SPAWN : RADIANT_SPAWN, y: 0 } : null;
}

/**
 * Unit-type preference. Valve's glossary gives lane creeps one tier for heroes
 * and creeps alike, then siege creeps, then structures
 * (`DOTA_Glossary_Advanced_AttackPriority_Desc`). Being a hero is no cover:
 * what keeps you out of a fight is stickiness and threat. Towers pick by the
 * same tiers.
 *
 * Siege creeps are built for buildings and rank them top, with enemy siege
 * second.
 */
function priority(attacker: Unit, target: Unit): number {
  if (attacker.kind === 'siege_creep') {
    if (target.kind === 'tower') return 4;
    if (target.kind === 'siege_creep') return 3;
    return target.kind === 'hero' ? 1 : 2;
  }
  if (target.kind === 'tower') return 1;
  return target.kind === 'siege_creep' ? 2 : 3;
}

/**
 * How pressing `u` is to `creep` when it picks a new target: attacking the
 * creep itself, then attacking one of its allies, then doing neither. A hero
 * attacking its own side — a deny, or the order that hands aggro back — ranks
 * below all of them.
 */
function threat(world: World, creep: Unit, u: Unit): number {
  const target = world.get(u.attackTargetId);
  if (!target) return 1;
  if (target === creep) return 3;
  return target.team === creep.team ? 2 : 0;
}

/** Whether `u` is one a creep picks from: inside its acquisition range, or already in reach. */
function candidate(world: World, creep: Unit, u: Unit): boolean {
  return dist(creep.pos, u.pos) <= acquisitionRange(creep.kind) || world.inAttackRange(creep, u);
}

/** Whether `a` beats `b` on unit type or threat: everything in a pick but distance. */
function outranks(world: World, creep: Unit, a: Unit, b: Unit): boolean {
  const pa = priority(creep, a);
  const pb = priority(creep, b);
  return pa > pb || (pa === pb && threat(world, creep, a) > threat(world, creep, b));
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

/**
 * The enemy a creep picks when it has no target it can keep: best unit type,
 * then biggest threat, then nearest, out of everything inside its acquisition
 * range or already within reach. Being in attack range earns nothing more than
 * that. `shunned` ranks below everything and is only picked when nothing else
 * qualifies.
 */
function bestInAcquisition(world: World, creep: Unit, shunned: Unit | null = null): Unit | null {
  let best: Unit | null = null;
  let fallback: Unit | null = null;
  let bestP = -Infinity;
  let bestT = -Infinity;
  let bestD = Infinity;
  for (const u of world.units.values()) {
    if (!u.alive || u.team === creep.team || !candidate(world, creep, u)) continue;
    if (u === shunned) {
      fallback = u;
      continue;
    }
    const p = priority(creep, u);
    const t = threat(world, creep, u);
    const d = dist(creep.pos, u.pos);
    if (p > bestP || (p === bestP && (t > bestT || (t === bestT && d < bestD)))) {
      bestP = p;
      bestT = t;
      bestD = d;
      best = u;
    }
  }
  return best ?? fallback;
}
