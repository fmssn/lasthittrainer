import { HEROES, canonicalHeroId, heroById } from '../sim/heroes.ts';
import { DEFAULT_CONFIG, DIFFICULTY_NAMES, type DrillConfig } from '../sim/config.ts';
import { attackInterval, attackPointTime } from '../sim/constants.ts';
import {
  ITEMS,
  STARTING_GOLD,
  canAdd,
  itemEffect,
  legalLoadout,
  loadoutCost,
  loadoutLabel,
  sellOne,
  type ItemId,
} from '../sim/items.ts';
import { loadRuns, type RunRecord } from '../stats.ts';
import { inventoryHtml } from './inventory.ts';
import { itemIconUrl } from './itemIcons.ts';

const DURATIONS = [60, 120, 180, 300];

function pips(n: number): string {
  return Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
}

export class Menu {
  config: DrillConfig;
  private el: HTMLDivElement;

  constructor(
    root: HTMLElement,
    private onStart: (config: DrillConfig) => void,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...loadConfig() };
    this.config.items = legalLoadout(this.config.items);
    // A saved config can name a hero that has since been renamed or retired.
    this.config.heroId = canonicalHeroId(this.config.heroId) ?? DEFAULT_CONFIG.heroId;
    this.config.enemyHeroId = canonicalHeroId(this.config.enemyHeroId) ?? DEFAULT_CONFIG.enemyHeroId;
    this.el = document.createElement('div');
    this.el.className = 'screen menu';
    root.appendChild(this.el);
    this.render();
  }

  show() {
    this.el.hidden = false;
    this.render();
  }

  hide() {
    this.el.hidden = true;
  }

  private set<K extends keyof DrillConfig>(key: K, value: DrillConfig[K]) {
    this.config[key] = value;
    saveConfig(this.config);
    this.render();
  }

  private render() {
    const c = this.config;
    // Runs on a retired hero stay in storage but have nothing to show under.
    const runs = loadRuns()
      .filter((r) => canonicalHeroId(r.heroId))
      .slice(-6)
      .reverse();
    const gold = loadoutCost(c.items);
    const equipped = heroById(c.heroId, c.items);

    this.el.innerHTML = `
      <div class="menu-inner">
        <header class="menu-head">
          <h1>Last Hit Trainer</h1>
          <p>Real 7.3x creep values, real attack animations. Build the timing here, keep it in game.</p>
        </header>

        <section class="block">
          <h2>Hero</h2>
          <div class="hero-grid">
            ${HEROES.map((base) => {
              // Effective, not authored. Agility divides both the interval and
              // the wind-up, so quoting the raw numbers off the hero file tells
              // you a swing is slower than the one you are about to make. The
              // same goes for items: Slippers make the swing you are timing
              // shorter, so the card quotes the hero as you would spawn.
              const h = heroById(base.id, c.items);
              const interval = attackInterval(h.baseAttackTime, h.attackSpeedBonus).toFixed(2);
              const point = attackPointTime(h.attackPoint, h.attackSpeedBonus).toFixed(2);
              return `
              <button class="hero-card ${h.id === c.heroId ? 'selected' : ''}" data-hero="${h.id}">
                <span class="hero-dot" style="background:${h.color}"></span>
                <span class="hero-name">${h.name}</span>
                <span class="hero-pips" title="timing difficulty">${pips(h.difficulty)}</span>
                <span class="hero-stats">
                  ${h.damageMin}–${h.damageMax} dmg${h.creepDamageBonus ? ` (+${h.creepDamageBonus} vs creeps)` : ''}
                  · ${h.attackRange} range · ${point}s point · ${interval}s attack
                  ${h.projectileSpeed ? ` · ${h.projectileSpeed} proj` : ' · melee'}
                </span>
                <span class="hero-note">${h.note}</span>
              </button>`;
            }).join('')}
          </div>
        </section>

        <section class="block">
          <h2>Starting items</h2>
          <div class="inventory-row">
            ${inventoryHtml(c.items, { sellable: true })}
            <span class="gold ${gold > 0 ? 'spent' : ''}">${gold} / ${STARTING_GOLD} gold</span>
            ${c.items.length ? `<button class="chip" data-clear-items>Clear</button>` : ''}
          </div>
          <div class="shop">
            ${ITEMS.map(
              (it) =>
                `<button class="shop-item" data-add-item="${it.id}" title="${it.name}: ${itemEffect(it)}" ${canAdd(c.items, it.id) ? '' : 'disabled'}>
                  <img class="item-icon" src="${itemIconUrl(it.id)}" alt="" />
                  <span class="shop-name">${it.name}</span>
                  <span class="cost">${it.cost}</span>
                </button>`,
            ).join('')}
          </div>
          <p class="aside">
            ${
              c.items.length
                ? `${equipped.name} spawns with ${loadoutLabel(c.items)}: ${equipped.damageMin}–${equipped.damageMax} damage${
                    equipped.creepDamageBonus ? `, ${equipped.damageMin + equipped.creepDamageBonus}–${equipped.damageMax + equipped.creepDamageBonus} against enemy creeps` : ''
                  }.`
                : 'Nothing bought: bare level 1 stats.'
            }
            Quelling Blade is +8 for melee and +4 for ranged, against enemy creeps only — it does not help a deny. Tango and Magic Stick cannot be used here; they are in the shop so a real opening buy fits the 600 gold. Your hero only; the bot starts empty-handed.
          </p>
        </section>

        <section class="block">
          <h2>Drill length</h2>
          <div class="chip-row">
            ${DURATIONS.map(
              (d) => `<button class="chip ${c.duration === d ? 'selected' : ''}" data-duration="${d}">${d / 60} min</button>`,
            ).join('')}
          </div>
        </section>

        <section class="block">
          <h2>Layers</h2>
          <div class="layers">
            <div class="layer locked">
              <div class="layer-head"><span class="layer-num">1</span><span>Last hits</span><span class="layer-state">always on</span></div>
              <p>Land the killing blow on enemy creeps. Lead your attack point and projectile travel.</p>
            </div>

            <label class="layer ${c.deniesEnabled ? 'on' : ''}">
              <div class="layer-head">
                <span class="layer-num">2</span><span>Denies</span>
                <input type="checkbox" data-toggle="deniesEnabled" ${c.deniesEnabled ? 'checked' : ''} />
              </div>
              <p>A-click your own creeps at or under 50% HP.</p>
            </label>

            <label class="layer ${c.enemyHero ? 'on' : ''}">
              <div class="layer-head">
                <span class="layer-num">3</span><span>Contested lane</span>
                <input type="checkbox" data-toggle="enemyHero" ${c.enemyHero ? 'checked' : ''} />
              </div>
              <p>An enemy hero goes for the same creeps. It estimates HP with a reaction delay and an error band — no cheating.</p>
              <div class="sub ${c.enemyHero ? '' : 'disabled'}">
                <div class="chip-row small">
                  ${[1, 2, 3, 4, 5]
                    .map(
                      (d) =>
                        `<button class="chip ${c.enemyDifficulty === d ? 'selected' : ''}" data-difficulty="${d}">${DIFFICULTY_NAMES[d]}</button>`,
                    )
                    .join('')}
                </div>
                <div class="chip-row small">
                  ${HEROES.map(
                    (h) =>
                      `<button class="chip ${c.enemyHeroId === h.id ? 'selected' : ''}" data-enemy-hero="${h.id}">${h.name}</button>`,
                  ).join('')}
                </div>
              </div>
            </label>

            <label class="layer ${c.aggroEnabled ? 'on' : ''}">
              <div class="layer-head">
                <span class="layer-num">4</span><span>Creep aggro</span>
                <input type="checkbox" data-toggle="aggroEnabled" ${c.aggroEnabled ? 'checked' : ''} />
              </div>
              <p>Right-clicking the enemy hero pulls enemy creeps within 500 onto you for 2.3s, and once the 3s cooldown is up every swing at a hero draws them again. Clicking your own creep hands them back, cooldown permitting. Harass is not free.</p>
            </label>
          </div>
        </section>

        ${runs.length ? `<section class="block"><h2>Recent runs</h2><div class="runs">${runs.map(runRow).join('')}</div></section>` : ''}

        <button class="start" data-start>Start drill</button>
      </div>
    `;

    this.bind();
  }

  private bind() {
    this.el.querySelectorAll<HTMLElement>('[data-hero]').forEach((n) =>
      n.addEventListener('click', () => this.set('heroId', n.dataset.hero!)),
    );
    this.el.querySelectorAll<HTMLElement>('[data-enemy-hero]').forEach((n) =>
      n.addEventListener('click', (e) => {
        e.preventDefault();
        this.set('enemyHeroId', n.dataset.enemyHero!);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-add-item]').forEach((n) =>
      n.addEventListener('click', () => {
        const id = n.dataset.addItem as ItemId;
        if (canAdd(this.config.items, id)) this.set('items', [...this.config.items, id]);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-sell-item]').forEach((n) =>
      n.addEventListener('click', () => this.set('items', sellOne(this.config.items, n.dataset.sellItem as ItemId))),
    );
    this.el.querySelector('[data-clear-items]')?.addEventListener('click', () => this.set('items', []));
    this.el.querySelectorAll<HTMLElement>('[data-duration]').forEach((n) =>
      n.addEventListener('click', () => this.set('duration', Number(n.dataset.duration))),
    );
    this.el.querySelectorAll<HTMLElement>('[data-difficulty]').forEach((n) =>
      n.addEventListener('click', (e) => {
        e.preventDefault();
        this.set('enemyDifficulty', Number(n.dataset.difficulty) as DrillConfig['enemyDifficulty']);
      }),
    );
    this.el.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach((n) =>
      n.addEventListener('change', () => this.set(n.dataset.toggle as 'deniesEnabled', n.checked)),
    );
    this.el.querySelector('[data-start]')?.addEventListener('click', () => {
      this.onStart({ ...this.config, seed: (Math.random() * 0xffff) | 0 });
    });
  }
}

function runRow(r: RunRecord): string {
  const hero = heroById(r.heroId);
  const when = new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<div class="run-row">
    <span class="run-hero"><i style="background:${hero.color}"></i>${hero.name}</span>
    <span class="run-score"><b>${r.lastHits}</b> LH${r.deniesEnabled ? ` · <b>${r.denies}</b> DN` : ''}</span>
    <span class="run-acc">${Math.round(r.accuracy * 100)}%</span>
    <span class="run-meta">${r.duration / 60}m${r.enemyHero ? ` · vs ${DIFFICULTY_NAMES[r.enemyDifficulty].toLowerCase()}` : ' · solo'}${
      r.items?.length ? ` · ${loadoutCost(r.items)}g items` : ''
    }</span>
    <span class="run-when">${when}</span>
  </div>`;
}

/**
 * Reading localStorage does not merely return null when it is unavailable — in
 * a private window, or with site data blocked, the accessor itself throws. The
 * menu has to come up on defaults in that case rather than take the whole app
 * down before the renderer is even built.
 */
function loadConfig(): Partial<DrillConfig> {
  try {
    const saved = localStorage.getItem('lht.config');
    return saved ? (JSON.parse(saved) as Partial<DrillConfig>) : {};
  } catch {
    return {};
  }
}

function saveConfig(config: DrillConfig) {
  try {
    localStorage.setItem('lht.config', JSON.stringify(config));
  } catch {
    // Storage full or blocked. The setting still applies to this session.
  }
}
