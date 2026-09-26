import { INVENTORY_SLOTS, inventorySlots, itemById, type ItemId } from '../sim/items.ts';
import { itemIconUrl } from './itemIcons.ts';

function slotInner(id: ItemId, charges: number): string {
  return `<img class="item-icon" src="${itemIconUrl(id)}" alt="" />${charges ? `<span class="charges">${charges}</span>` : ''}`;
}

/**
 * The six inventory slots, as the menu and the HUD both show them. With
 * `sellable`, each filled slot is a button that sells one of what is in it, so
 * a stack of Tangos goes down a purchase at a time rather than all at once.
 */
export function inventoryHtml(items: readonly ItemId[], opts: { sellable?: boolean } = {}): string {
  const slots = inventorySlots(items);
  const cells = Array.from({ length: INVENTORY_SLOTS }, (_, i) => {
    const slot = slots[i];
    const def = slot && itemById(slot.id);
    if (!slot || !def) return `<span class="slot"></span>`;
    return opts.sellable
      ? `<button class="slot filled" data-sell-item="${slot.id}" title="${def.name}: click to sell${slot.count > 1 ? ' one' : ''}">${slotInner(slot.id, slot.charges)}</button>`
      : `<span class="slot filled" title="${def.name}">${slotInner(slot.id, slot.charges)}</span>`;
  });
  return `<div class="inventory">${cells.join('')}</div>`;
}

/** Just the filled slots, small, for a line of text such as the results header. */
export function itemStripHtml(items: readonly ItemId[]): string {
  return inventorySlots(items)
    .map((s) => `<span class="slot filled" title="${itemById(s.id)?.name ?? s.id}">${slotInner(s.id, s.charges)}</span>`)
    .join('');
}
