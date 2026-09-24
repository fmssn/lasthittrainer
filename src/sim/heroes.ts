import type { UnitTemplate } from './units.ts';

export interface HeroTemplate extends UnitTemplate {
  id: string;
  /** How hard the attack animation is to time, 1 (forgiving) to 5 (brutal). */
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** What this hero teaches. */
  note: string;
  color: string;
}

/**
 * Level 1 hero stats, 7.3x. Damage is base damage plus the primary-attribute
 * contribution at level 1, which is what you actually hit creeps with at 0:00.
 */
const base = {
  kind: 'hero' as const,
  hpRegen: 1.5,
  bountyMin: 0,
  bountyMax: 0,
  xp: 0,
  radius: 28,
};

export const HEROES: HeroTemplate[] = [
  {
    ...base,
    id: 'sniper',
    name: 'Sniper',
    difficulty: 1,
    note: 'Fastest attack point in the game and a 3000-speed projectile. Start here — the hit lands almost the instant you click.',
    color: '#d9a441',
    maxHp: 560,
    armor: 0.6,
    damageMin: 34,
    damageMax: 40,
    attackRange: 550,
    baseAttackTime: 1.7,
    attackPoint: 0.17,
    attackBackswing: 0.7,
    projectileSpeed: 3000,
    moveSpeed: 285,
    turnRate: 0.6,
  },
  {
    ...base,
    id: 'juggernaut',
    name: 'Juggernaut',
    difficulty: 2,
    note: 'Standard melee timing. You have to walk into range, so positioning matters as much as the click.',
    color: '#6fc3a8',
    maxHp: 620,
    armor: 3.1,
    damageMin: 41,
    damageMax: 43,
    attackRange: 150,
    baseAttackTime: 1.4,
    attackPoint: 0.33,
    attackBackswing: 0.64,
    projectileSpeed: 0,
    moveSpeed: 305,
    turnRate: 0.6,
  },
  {
    ...base,
    id: 'antimage',
    name: 'Anti-Mage',
    difficulty: 2,
    note: 'High base damage, short 150 range. Overkill damage means you can hit early — but the wave punishes you for standing in it.',
    color: '#8ab4f8',
    maxHp: 560,
    armor: 3.5,
    damageMin: 48,
    damageMax: 52,
    attackRange: 150,
    baseAttackTime: 1.4,
    attackPoint: 0.3,
    attackBackswing: 0.64,
    projectileSpeed: 0,
    moveSpeed: 310,
    turnRate: 0.9,
  },
  {
    ...base,
    id: 'crystal_maiden',
    name: 'Crystal Maiden',
    difficulty: 4,
    note: 'Slow 0.55 attack point and a lazy 900-speed projectile. Two separate delays you have to lead.',
    color: '#8fd8f2',
    maxHp: 500,
    armor: 0.8,
    damageMin: 39,
    damageMax: 45,
    attackRange: 600,
    baseAttackTime: 1.7,
    attackPoint: 0.55,
    attackBackswing: 0.55,
    projectileSpeed: 900,
    moveSpeed: 280,
    turnRate: 0.6,
  },
  {
    ...base,
    id: 'shadow_fiend',
    name: 'Shadow Fiend',
    difficulty: 5,
    note: 'The classic last-hit test: low base damage, 0.47 attack point, and you need every creep to stay even.',
    color: '#b57bd6',
    maxHp: 520,
    armor: 0.5,
    damageMin: 34,
    damageMax: 40,
    attackRange: 500,
    baseAttackTime: 1.7,
    attackPoint: 0.47,
    attackBackswing: 0.53,
    projectileSpeed: 1500,
    moveSpeed: 305,
    turnRate: 0.6,
  },
  {
    ...base,
    id: 'drow',
    name: 'Drow Ranger',
    difficulty: 4,
    note: '625 range keeps you safe, but 0.55 attack point plus travel time makes the lead long and easy to over-click.',
    color: '#9fd6ff',
    maxHp: 520,
    armor: 1.0,
    damageMin: 44,
    damageMax: 53,
    attackRange: 625,
    baseAttackTime: 1.7,
    attackPoint: 0.55,
    attackBackswing: 0.55,
    projectileSpeed: 1250,
    moveSpeed: 300,
    turnRate: 0.6,
  },
];

export function heroById(id: string): HeroTemplate {
  return HEROES.find((h) => h.id === id) ?? HEROES[0];
}
