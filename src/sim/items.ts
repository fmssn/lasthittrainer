/**
 * Starting items, from Valve's `scripts/npc/items.txt` (7.41f). Only the ones
 * that change a last hit are here: flat damage, attributes, and Quell. Tango,
 * Healing Salve and the rest of a real starting buy are left out because
 * nothing in this drill reads what they do.
 *
 * Like heroes, items feed the attribute rules rather than bypassing them: an
 * Iron Branch is +1 to every attribute, so it is +1 damage, +22 HP and +1
 * attack speed on an agility hero, and all of that falls out of `derive()`.
 */

export type ItemId =
  | 'quelling_blade'
  | 'iron_branch'
  | 'faerie_fire'
  | 'slippers'
  | 'mantle'
  | 'gauntlets'
  | 'circlet';

export interface ItemDef {
  id: ItemId;
  name: string;
  /** Two or three letters for the inventory slot. */
  short: string;
  cost: number;
  str: number;
  agi: number;
  int: number;
  /** Flat attack damage against everything. */
  damage: number;
  /** Quell: bonus attack damage against enemy creeps, melee / ranged heroes. */
  quellMelee: number;
  quellRanged: number;
  /** "Effects of multiple quelling blades do not stack", per its tooltip. */
  unique: boolean;
}

/** `dota_default_gold 600` — what every hero spawns with. */
export const STARTING_GOLD = 600;

/**
 * Main inventory. Items in the backpack give no stats, so a seventh branch buys
 * nothing — which is the real cap on stacking branches.
 */
export const INVENTORY_SLOTS = 6;

const item = (d: Partial<ItemDef> & Pick<ItemDef, 'id' | 'name' | 'short' | 'cost'>): ItemDef => ({
  str: 0,
  agi: 0,
  int: 0,
  damage: 0,
  quellMelee: 0,
  quellRanged: 0,
  unique: false,
  ...d,
});

export const ITEMS: ItemDef[] = [
  // `damage_bonus 8`, `damage_bonus_ranged 4`. Cut from 12/6 in 7.31.
  item({ id: 'quelling_blade', name: 'Quelling Blade', short: 'QB', cost: 100, quellMelee: 8, quellRanged: 4, unique: true }),
  // `bonus_all_stats 1`. Cost raised from 50 to 55 in 7.40.
  item({ id: 'iron_branch', name: 'Iron Branch', short: 'IB', cost: 55, str: 1, agi: 1, int: 1 }),
  // `bonus_damage 2`, held passively. Its heal is an active and is not modelled.
  item({ id: 'faerie_fire', name: 'Faerie Fire', short: 'FF', cost: 65, damage: 2 }),
  item({ id: 'slippers', name: 'Slippers of Agility', short: 'SA', cost: 140, agi: 3 }),
  item({ id: 'mantle', name: 'Mantle of Intelligence', short: 'MI', cost: 140, int: 3 }),
  item({ id: 'gauntlets', name: 'Gauntlets of Strength', short: 'GS', cost: 140, str: 3 }),
  item({ id: 'circlet', name: 'Circlet', short: 'CI', cost: 155, str: 2, agi: 2, int: 2 }),
];

export function itemById(id: ItemId): ItemDef | undefined {
  return ITEMS.find((i) => i.id === id);
}

export function loadoutCost(items: readonly ItemId[]): number {
  return items.reduce((sum, id) => sum + (itemById(id)?.cost ?? 0), 0);
}

/** Whether `id` can go into `items` without breaking a rule a real shop enforces. */
export function canAdd(items: readonly ItemId[], id: ItemId): boolean {
  const def = itemById(id);
  if (!def) return false;
  if (items.length >= INVENTORY_SLOTS) return false;
  if (def.unique && items.includes(id)) return false;
  return loadoutCost(items) + def.cost <= STARTING_GOLD;
}

/**
 * A loadout that could have been bought at 0:00. Config comes back out of
 * localStorage, so this cannot assume it was written by the current menu.
 */
export function legalLoadout(raw: unknown): ItemId[] {
  const out: ItemId[] = [];
  if (!Array.isArray(raw)) return out;
  for (const id of raw) {
    if (typeof id === 'string' && canAdd(out, id as ItemId)) out.push(id as ItemId);
  }
  return out;
}

/** "Quelling Blade, 2× Iron Branch" — for run history and the results screen. */
export function loadoutLabel(items: readonly ItemId[]): string {
  const counts = new Map<ItemId, number>();
  for (const id of items) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .map(([id, n]) => `${n > 1 ? `${n}× ` : ''}${itemById(id)?.name ?? id}`)
    .join(', ');
}
