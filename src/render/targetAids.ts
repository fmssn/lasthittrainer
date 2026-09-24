import { DENY_THRESHOLD } from '../sim/constants.ts';
import type { Unit } from '../sim/types.ts';
import type { World } from '../sim/world.ts';

/**
 * Whether the player is allowed to swing at this unit, which is what every
 * training aid keys off. Enemy creeps are always fair game; your own only once
 * they cross the deny line, and only when denies are switched on.
 */
export function isPlayerTarget(world: World, u: Unit): boolean {
  if (u.team === 'dire') return true;
  return world.config.deniesEnabled && u.hp <= u.maxHp * DENY_THRESHOLD;
}
