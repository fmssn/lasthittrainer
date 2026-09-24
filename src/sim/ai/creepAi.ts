import type { Unit } from '../types.ts';
import type { World } from '../world.ts';
import { DIRE_SPAWN, RADIANT_SPAWN } from '../world.ts';
import { ACQUISITION_RANGE } from '../constants.ts';
import { dist } from '../math.ts';

/**
 * Lane creep behaviour, in Dota's own priority order (simplified):
 *   1. forced aggro from a hero right-click
 *   2. stay on the current target while it is alive and inside leash range
 *   3. acquire the nearest enemy in acquisition range
 *   4. otherwise march down the lane
 */
export function runCreepAi(world: World, creep: Unit) {
  const forced = world.get(creep.aggroTargetId);
  if (forced) {
    creep.attackTargetId = forced.id;
    creep.moveTarget = null;
    return;
  }

  const current = world.get(creep.attackTargetId);
  if (current && world.withinLeash(creep, current)) {
    creep.moveTarget = null;
    return;
  }

  const acquired = pickTarget(world, creep);
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
 * Creeps prefer other creeps over heroes when nothing forced them, which is
 * why you can stand next to a wave all day and take no damage.
 */
function pickTarget(world: World, creep: Unit): Unit | null {
  // Towers reach further than creeps do; everything else uses acquisition range.
  const range = creep.kind === 'tower' ? creep.attackRange : ACQUISITION_RANGE;
  let bestCreep: Unit | null = null;
  let bestCreepD = range;
  let bestHero: Unit | null = null;
  let bestHeroD = range;
  let bestTower: Unit | null = null;
  let bestTowerD = range;

  for (const u of world.units.values()) {
    if (!u.alive || u.team === creep.team) continue;
    const d = dist(creep.pos, u.pos);
    if (u.kind === 'hero') {
      if (d < bestHeroD) {
        bestHeroD = d;
        bestHero = u;
      }
    } else if (u.kind === 'tower') {
      if (d < bestTowerD) {
        bestTowerD = d;
        bestTower = u;
      }
    } else if (d < bestCreepD) {
      bestCreepD = d;
      bestCreep = u;
    }
  }
  return bestCreep ?? bestHero ?? bestTower;
}
