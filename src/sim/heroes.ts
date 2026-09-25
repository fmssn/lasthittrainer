import type { UnitTemplate } from './units.ts';
import {
  HERO_BASE_HP,
  HERO_BASE_HP_REGEN,
  HULL,
  PER_AGILITY_ARMOR,
  PER_AGILITY_ATTACK_SPEED,
  PER_STRENGTH_HP,
  PER_STRENGTH_HP_REGEN,
} from './constants.ts';

export type Attribute = 'str' | 'agi' | 'int';

/**
 * A hero exactly as Valve authors it in `scripts/npc/heroes/*.txt`: base stats
 * plus attributes. Everything you actually fight with — damage, HP, armor,
 * attack speed — is derived from these by {@link derive}, rather than being a
 * second set of numbers to keep in sync by hand.
 */
interface HeroSource {
  id: string;
  name: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  note: string;
  color: string;

  /** `AttackDamageMin`/`Max`, before the primary attribute is added. */
  baseDamageMin: number;
  baseDamageMax: number;
  /** `ArmorPhysical`, before agility is added. */
  baseArmor: number;
  /**
   * `StatusHealthRegen`, before strength is added. Omitted when the hero does
   * not override the 0.25 every hero inherits from `npc_dota_hero_base.txt`.
   */
  baseHpRegen?: number;

  attackRange: number;
  baseAttackTime: number;
  attackPoint: number;
  /** Not in the scripts — Dota reads it off the attack animation. Measured. */
  attackBackswing: number;
  projectileSpeed: number;
  moveSpeed: number;
  turnRate: number;

  primary: Attribute;
  str: number;
  agi: number;
  int: number;
}

export interface HeroTemplate extends UnitTemplate {
  id: string;
  /** How hard the attack animation is to time, 1 (forgiving) to 5 (brutal). */
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** What this hero teaches. */
  note: string;
  color: string;
  primary: Attribute;
  str: number;
  agi: number;
  int: number;
}

/**
 * Level 1 stats, by Dota's own attribute rules: 22 HP and 0.1 HP regen per
 * strength, 0.167 armor and 1 attack speed per agility, and +1 attack damage
 * per point of the hero's primary attribute.
 *
 * The attack speed matters more than it looks. It divides both the attack
 * interval and the wind-up, so Juggernaut's authored 0.33 s attack point is
 * really 0.25 s in the lane at 32 agility. Treating every hero as if it had no
 * attack speed — which is what a flat `attackSpeedBonus` of 0 does — makes
 * every swing in the drill slower than the same swing in game, which is the
 * one error a last-hit trainer cannot afford.
 */
function derive(h: HeroSource): HeroTemplate {
  const primaryValue = h.primary === 'str' ? h.str : h.primary === 'agi' ? h.agi : h.int;
  return {
    kind: 'hero',
    id: h.id,
    name: h.name,
    difficulty: h.difficulty,
    note: h.note,
    color: h.color,
    primary: h.primary,
    str: h.str,
    agi: h.agi,
    int: h.int,

    radius: HULL.hero,
    maxHp: HERO_BASE_HP + h.str * PER_STRENGTH_HP,
    hpRegen: (h.baseHpRegen ?? HERO_BASE_HP_REGEN) + h.str * PER_STRENGTH_HP_REGEN,
    armor: h.baseArmor + h.agi * PER_AGILITY_ARMOR,
    damageMin: h.baseDamageMin + primaryValue,
    damageMax: h.baseDamageMax + primaryValue,
    attackSpeedBonus: h.agi * PER_AGILITY_ATTACK_SPEED,

    attackRange: h.attackRange,
    baseAttackTime: h.baseAttackTime,
    attackPoint: h.attackPoint,
    attackBackswing: h.attackBackswing,
    projectileSpeed: h.projectileSpeed,
    moveSpeed: h.moveSpeed,
    turnRate: h.turnRate,

    bountyMin: 0,
    bountyMax: 0,
    xp: 0,
  };
}

/** Ordered by how hard the swing is to time, easiest first. */
const SOURCES: HeroSource[] = [
  {
    id: 'sniper',
    name: 'Sniper',
    difficulty: 1,
    note: 'A 0.17s attack point that agility cuts to about 0.13s, and a 3000-speed shot. Start here — the hit lands almost the instant you click.',
    color: '#d9a441',
    baseDamageMin: 13,
    baseDamageMax: 19,
    baseArmor: 0,
    attackRange: 550,
    baseAttackTime: 1.7,
    attackPoint: 0.17,
    attackBackswing: 0.7,
    projectileSpeed: 3000,
    moveSpeed: 285,
    turnRate: 0.7,
    primary: 'agi',
    str: 19,
    agi: 27,
    int: 15,
  },
  {
    id: 'juggernaut',
    name: 'Juggernaut',
    difficulty: 2,
    note: 'Standard melee timing, and 32 agility makes it the fastest swing here after Sniper. You have to walk into 150 range, so position matters as much as the click.',
    color: '#6fc3a8',
    baseDamageMin: 22,
    baseDamageMax: 24,
    baseArmor: 0,
    baseHpRegen: 0.5,
    attackRange: 150,
    baseAttackTime: 1.4,
    attackPoint: 0.33,
    attackBackswing: 0.64,
    projectileSpeed: 0,
    moveSpeed: 305,
    turnRate: 0.6,
    primary: 'agi',
    str: 20,
    agi: 32,
    int: 14,
  },
  {
    id: 'antimage',
    name: 'Anti-Mage',
    difficulty: 2,
    note: 'The highest base damage in this roster and a short 150 range. Overkill damage means you can hit early — but the wave punishes you for standing in it.',
    color: '#8ab4f8',
    baseDamageMin: 29,
    baseDamageMax: 33,
    baseArmor: 2,
    baseHpRegen: 1.5,
    attackRange: 150,
    baseAttackTime: 1.4,
    attackPoint: 0.3,
    attackBackswing: 0.64,
    projectileSpeed: 0,
    moveSpeed: 315,
    turnRate: 0.6,
    primary: 'agi',
    str: 21,
    agi: 25,
    int: 12,
  },
  {
    id: 'crystal_maiden',
    name: 'Crystal Maiden',
    difficulty: 4,
    note: 'Only 16 agility, so the 0.45s attack point barely shrinks, and the shot crawls at 900. Two separate delays to lead.',
    color: '#8fd8f2',
    baseDamageMin: 28,
    baseDamageMax: 34,
    baseArmor: 0,
    attackRange: 600,
    baseAttackTime: 1.7,
    attackPoint: 0.45,
    attackBackswing: 0.55,
    projectileSpeed: 900,
    moveSpeed: 280,
    turnRate: 0.6,
    primary: 'int',
    str: 17,
    agi: 16,
    int: 20,
  },
  {
    id: 'drow',
    name: 'Drow Ranger',
    difficulty: 4,
    note: '625 range keeps you safe, but a 0.5s attack point plus travel time makes the lead long and easy to over-click.',
    color: '#9fd6ff',
    baseDamageMin: 27,
    baseDamageMax: 34,
    baseArmor: 0,
    attackRange: 625,
    baseAttackTime: 1.7,
    attackPoint: 0.5,
    attackBackswing: 0.55,
    projectileSpeed: 1250,
    moveSpeed: 310,
    turnRate: 0.7,
    primary: 'agi',
    str: 16,
    agi: 24,
    int: 15,
  },
  {
    id: 'shadow_fiend',
    name: 'Shadow Fiend',
    difficulty: 5,
    note: 'The classic last-hit test: the lowest base damage in the game, a 0.5s attack point, 525 range, and you need every creep to stay even.',
    color: '#b57bd6',
    baseDamageMin: 16,
    baseDamageMax: 22,
    baseArmor: 0,
    attackRange: 525,
    baseAttackTime: 1.6,
    attackPoint: 0.5,
    attackBackswing: 0.53,
    projectileSpeed: 1200,
    moveSpeed: 305,
    turnRate: 0.9,
    primary: 'agi',
    str: 19,
    agi: 25,
    int: 16,
  },
];

export const HEROES: HeroTemplate[] = SOURCES.map(derive);

export function heroById(id: string): HeroTemplate {
  return HEROES.find((h) => h.id === id) ?? HEROES[0];
}
