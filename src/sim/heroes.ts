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
import { itemById, type ItemId } from './items.ts';

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
  /**
   * `BaseAttackSpeed`, before agility is added. Omitted when the hero keeps the
   * 100 from `npc_dota_hero_base.txt`; the Swordmaster's 110 is the one
   * exception in this roster.
   */
  baseAttackSpeed?: number;
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
  /**
   * Attack speed above the 100 baseline: agility plus whatever the hero file
   * adds to `BaseAttackSpeed`. Optional only on creep templates.
   */
  attackSpeedBonus: number;
  /** Quell from a Quelling Blade, or 0. Enemy creeps only. */
  creepDamageBonus: number;
  /** The starting items these stats include. */
  items: readonly ItemId[];
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
 * interval and the wind-up, so the Swordmaster's authored 0.33 s attack point
 * is really 0.23 s in the lane: 110 base attack speed plus 32 agility. Treating
 * every hero as if it had no attack speed — which is what a flat
 * `attackSpeedBonus` of 0 does — makes every swing in the drill slower than
 * the same swing in game, which is the one error a last-hit trainer cannot
 * afford.
 *
 * Starting items go in as attributes, before any of that, so a Slippers of
 * Agility speeds the swing up and a Mantle on an intelligence hero is damage.
 */
function derive(h: HeroSource, items: readonly ItemId[] = []): HeroTemplate {
  let str = h.str;
  let agi = h.agi;
  let int = h.int;
  let flatDamage = 0;
  let quell = 0;
  const melee = h.projectileSpeed <= 0;
  for (const id of items) {
    const it = itemById(id);
    if (!it) continue;
    str += it.str;
    agi += it.agi;
    int += it.int;
    flatDamage += it.damage;
    // Quell does not stack, so the largest one wins rather than the sum.
    quell = Math.max(quell, melee ? it.quellMelee : it.quellRanged);
  }
  const primaryValue = h.primary === 'str' ? str : h.primary === 'agi' ? agi : int;
  return {
    kind: 'hero',
    id: h.id,
    name: h.name,
    difficulty: h.difficulty,
    note: h.note,
    color: h.color,
    primary: h.primary,
    str,
    agi,
    int,
    items: [...items],

    radius: HULL.hero,
    maxHp: HERO_BASE_HP + str * PER_STRENGTH_HP,
    hpRegen: (h.baseHpRegen ?? HERO_BASE_HP_REGEN) + str * PER_STRENGTH_HP_REGEN,
    armor: h.baseArmor + agi * PER_AGILITY_ARMOR,
    damageMin: h.baseDamageMin + primaryValue + flatDamage,
    damageMax: h.baseDamageMax + primaryValue + flatDamage,
    attackSpeedBonus: (h.baseAttackSpeed ?? 100) - 100 + agi * PER_AGILITY_ATTACK_SPEED,
    creepDamageBonus: quell,

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

/**
 * Ordered by how hard the swing is to time, easiest first.
 *
 * Two heroes, one melee and one ranged, because the feel of each has to be
 * right before a third is worth having. The numbers are Valve's, from the
 * script file named on each; the display names are our own, so nothing the
 * player sees borrows a hero's name.
 */
const SOURCES: HeroSource[] = [
  {
    // npc_dota_hero_juggernaut.txt
    id: 'swordmaster',
    name: 'Swordmaster',
    difficulty: 2,
    note: 'Standard melee timing, but 110 base attack speed plus 32 agility cuts the 0.33s attack point to 0.23s, the quicker swing of the two. You have to walk into 150 range, so position matters as much as the click.',
    color: '#6fc3a8',
    baseDamageMin: 22,
    baseDamageMax: 24,
    baseArmor: 0,
    baseHpRegen: 0.5,
    attackRange: 150,
    baseAttackTime: 1.4,
    baseAttackSpeed: 110,
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
    // npc_dota_hero_drow_ranger.txt
    id: 'frost_archer',
    name: 'Frost Archer',
    difficulty: 4,
    note: '625 range keeps you out of the wave, but a 0.40s attack point and a 1250-speed arrow on top make the lead long and easy to over-click.',
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
];

/**
 * The ids these two had before they were renamed. Saved configs and run
 * history still carry them, and a run is worth more read back under the hero
 * it was played on than dropped.
 */
const RENAMED: Record<string, string> = {
  juggernaut: 'swordmaster',
  drow: 'frost_archer',
};

/** Every hero as it spawns with nothing bought. */
export const HEROES: HeroTemplate[] = SOURCES.map((s) => derive(s));

/** `id` as the current roster knows it, or undefined for a hero that is gone. */
export function canonicalHeroId(id: string): string | undefined {
  const current = RENAMED[id] ?? id;
  return SOURCES.some((s) => s.id === current) ? current : undefined;
}

/** A hero's level 1 stats, carrying `items` if any are given. */
export function heroById(id: string, items: readonly ItemId[] = []): HeroTemplate {
  const canonical = canonicalHeroId(id);
  const source = SOURCES.find((s) => s.id === canonical) ?? SOURCES[0];
  return items.length ? derive(source, items) : (HEROES.find((h) => h.id === source.id) ?? HEROES[0]);
}
