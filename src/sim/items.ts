/**
 * Starting items, from Valve's `scripts/npc/items.txt` (7.41f). The ones that
 * change a last hit are here — flat damage, attributes, and Quell — plus the
 * two a real opening buy is padded out with: Tango and Magic Stick. Neither
 * can be used in the drill, but a 600 gold loadout without them is not the one
 * anybody actually walks into lane with.
 *
 * Like heroes, items feed the attribute rules rather than bypassing them: an
 * Iron Branch is +1 to every attribute, so it is +1 damage, +22 HP and +1
 * attack speed on an agility hero, and all of that falls out of `derive()`.
 */

export type ItemId =
  | 'quelling_blade'
  | 'iron_branch'
  | 'faerie_fire'
  | 'tango'
  | 'magic_stick'
  | 'slippers'
  | 'mantle'
  | 'gauntlets'
  | 'circlet';

export interface ItemDef {
  id: ItemId;
  name: string;
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
  /** `ItemStackable`: further purchases join the first slot instead of taking one. */
  stackable: boolean;
  /** `ItemInitialCharges` per purchase, shown on the slot. 0 shows nothing. */
  charges: number;
  /** What it does here, when that is not a stat. */
  note?: string;
}

/** `dota_default_gold 600` — what every hero spawns with. */
export const STARTING_GOLD = 600;

/**
 * Main inventory. Items in the backpack give no stats, so a seventh branch buys
 * nothing — which is the real cap on stacking branches.
 */
export const INVENTORY_SLOTS = 6;

const item = (d: Partial<ItemDef> & Pick<ItemDef, 'id' | 'name' | 'cost'>): ItemDef => ({
  str: 0,
  agi: 0,
  int: 0,
  damage: 0,
  quellMelee: 0,
  quellRanged: 0,
  unique: false,
  stackable: false,
  charges: 0,
  ...d,
});

export const ITEMS: ItemDef[] = [
  // `damage_bonus 8`, `damage_bonus_ranged 4`. Cut from 12/6 in 7.31.
  item({ id: 'quelling_blade', name: 'Quelling Blade', cost: 100, quellMelee: 8, quellRanged: 4, unique: true }),
  // `bonus_all_stats 1`. Cost raised from 50 to 55 in 7.40.
  item({ id: 'iron_branch', name: 'Iron Branch', cost: 55, str: 1, agi: 1, int: 1 }),
  // `bonus_damage 2`, held passively. Its heal is an active and is not modelled.
  // `ItemStackable 0`, so every one takes a slot.
  item({ id: 'faerie_fire', name: 'Faerie Fire', cost: 65, damage: 2 }),
  // `ItemStackable 1`, `ItemInitialCharges 3`: two buys are one slot of six.
  item({
    id: 'tango',
    name: 'Tango',
    cost: 90,
    stackable: true,
    charges: 3,
    note: 'Cannot be eaten here. It takes a slot and 90 gold, the way it does in a real opening.',
  }),
  // Charges come from enemy spell casts, and nothing in this lane casts one.
  item({
    id: 'magic_stick',
    name: 'Magic Stick',
    cost: 200,
    note: 'Never charges here: nothing in this lane casts a spell. It takes a slot and 200 gold.',
  }),
  item({ id: 'slippers', name: 'Slippers of Agility', cost: 140, agi: 3 }),
  item({ id: 'mantle', name: 'Mantle of Intelligence', cost: 140, int: 3 }),
  item({ id: 'gauntlets', name: 'Gauntlets of Strength', cost: 140, str: 3 }),
  item({ id: 'circlet', name: 'Circlet', cost: 155, str: 2, agi: 2, int: 2 }),
];

export function itemById(id: ItemId): ItemDef | undefined {
  return ITEMS.find((i) => i.id === id);
}

export function loadoutCost(items: readonly ItemId[]): number {
  return items.reduce((sum, id) => sum + (itemById(id)?.cost ?? 0), 0);
}

export interface InventorySlot {
  id: ItemId;
  /** Purchases sharing this slot: always 1 unless the item stacks. */
  count: number;
  /** Charges to print on the slot, or 0 for none. */
  charges: number;
}

/**
 * How a loadout sits in the six slots. A loadout is the list of purchases; the
 * two differ only for stackables, which share the slot of the first one
 * bought, so slots come out in purchase order with stacks where they started.
 */
export function inventorySlots(items: readonly ItemId[]): InventorySlot[] {
  const slots: InventorySlot[] = [];
  for (const id of items) {
    const def = itemById(id);
    if (!def) continue;
    const stack = def.stackable ? slots.find((s) => s.id === id) : undefined;
    if (stack) {
      stack.count++;
      stack.charges += def.charges;
    } else {
      slots.push({ id, count: 1, charges: def.charges });
    }
  }
  return slots;
}

/** Whether `id` can go into `items` without breaking a rule a real shop enforces. */
export function canAdd(items: readonly ItemId[], id: ItemId): boolean {
  const def = itemById(id);
  if (!def) return false;
  if (def.unique && items.includes(id)) return false;
  const stacks = def.stackable && items.includes(id);
  if (!stacks && inventorySlots(items).length >= INVENTORY_SLOTS) return false;
  return loadoutCost(items) + def.cost <= STARTING_GOLD;
}

/** `items` with one `id` taken out — the last one bought, so a stack shrinks by one. */
export function sellOne(items: readonly ItemId[], id: ItemId): ItemId[] {
  const i = items.lastIndexOf(id);
  return i < 0 ? [...items] : [...items.slice(0, i), ...items.slice(i + 1)];
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

/** "+3 agility", "+8 vs creeps (melee)" — the shop tooltip, from the numbers themselves. */
export function itemEffect(def: ItemDef): string {
  if (def.note) return def.note;
  const parts: string[] = [];
  if (def.str && def.str === def.agi && def.agi === def.int) parts.push(`+${def.str} all attributes`);
  else {
    if (def.str) parts.push(`+${def.str} strength`);
    if (def.agi) parts.push(`+${def.agi} agility`);
    if (def.int) parts.push(`+${def.int} intelligence`);
  }
  if (def.damage) parts.push(`+${def.damage} damage`);
  if (def.quellMelee) parts.push(`+${def.quellMelee} damage vs enemy creeps (+${def.quellRanged} ranged)`);
  return parts.join(', ');
}
