import { HEROES, heroById } from '../sim/heroes.ts';
import { DEFAULT_CONFIG, type DrillConfig } from '../sim/config.ts';
import { attackInterval } from '../sim/constants.ts';
import { loadRuns, type RunRecord } from '../stats.ts';

/** Which renderer draws the drill. Kept out of DrillConfig: the sim never sees it. */
export type RenderMode = '2d' | '3d';
const RENDER_KEY = 'lht.render.v1';

const DURATIONS = [60, 120, 180, 300];
const DIFFICULTY_NAMES = ['', 'Sloppy', 'Casual', 'Decent', 'Strong', 'Scripted'];

function pips(n: number): string {
  return Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
}

export class Menu {
  config: DrillConfig;
  renderMode: RenderMode;
  /** Set by main when the 3D assets fail to load, so the menu can say why. */
  renderNote = '';
  private el: HTMLDivElement;

  constructor(
    root: HTMLElement,
    private onStart: (config: DrillConfig) => void,
    private onRenderMode: (mode: RenderMode) => void = () => {},
  ) {
    const saved = localStorage.getItem('lht.config');
    this.config = { ...DEFAULT_CONFIG, ...(saved ? safeParse(saved) : {}) };
    this.renderMode = localStorage.getItem(RENDER_KEY) === '3d' ? '3d' : '2d';
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

  setRenderMode(mode: RenderMode) {
    this.renderMode = mode;
    localStorage.setItem(RENDER_KEY, mode);
    this.render();
    this.onRenderMode(mode);
  }

  private set<K extends keyof DrillConfig>(key: K, value: DrillConfig[K]) {
    this.config[key] = value;
    localStorage.setItem('lht.config', JSON.stringify(this.config));
    this.render();
  }

  private render() {
    const c = this.config;
    const c2d = this.renderMode === '2d' ? 'selected' : '';
    const c3d = this.renderMode === '3d' ? 'selected' : '';
    const runs = loadRuns().slice(-6).reverse();

    this.el.innerHTML = `
      <div class="menu-inner">
        <header class="menu-head">
          <h1>Last Hit Trainer</h1>
          <p>Real 7.3x creep values, real attack animations. Build the timing here, keep it in game.</p>
        </header>

        <section class="block">
          <h2>Hero</h2>
          <div class="hero-grid">
            ${HEROES.map((h) => {
              const interval = attackInterval(h.baseAttackTime, 0).toFixed(2);
              return `
              <button class="hero-card ${h.id === c.heroId ? 'selected' : ''}" data-hero="${h.id}">
                <span class="hero-dot" style="background:${h.color}"></span>
                <span class="hero-name">${h.name}</span>
                <span class="hero-pips" title="timing difficulty">${pips(h.difficulty)}</span>
                <span class="hero-stats">
                  ${h.attackRange} range · ${h.attackPoint}s point · ${interval}s attack
                  ${h.projectileSpeed ? ` · ${h.projectileSpeed} proj` : ' · melee'}
                </span>
                <span class="hero-note">${h.note}</span>
              </button>`;
            }).join('')}
          </div>
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
              <p>A-click your own creeps at or under 50% HP. The deny line is drawn on every health bar.</p>
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
              <p>Right-clicking the enemy hero pulls every enemy creep within 500 range onto you for 2.3s. Harass is not free.</p>
            </label>
          </div>
        </section>

        <section class="block">
          <h2>Training aids</h2>
          <div class="chip-row">
            <button class="chip toggle ${c.showKillableHighlight ? 'selected' : ''}" data-toggle-btn="showKillableHighlight">Killable highlight</button>
            <button class="chip toggle ${c.showDamagePreview ? 'selected' : ''}" data-toggle-btn="showDamagePreview">Damage preview</button>
            <button class="chip toggle ${c.showRangeRings ? 'selected' : ''}" data-toggle-btn="showRangeRings">Range ring</button>
          </div>
          <p class="aside">Turn these off once the timing is in your hands. That is the actual graduation.</p>
        </section>

        <section class="block">
          <h2>Renderer</h2>
          <div class="chip-row">
            <button class="chip ${c2d}" data-render="2d">2D</button>
            <button class="chip ${c3d}" data-render="3d">3D (experimental)</button>
          </div>
          <p class="aside">${this.renderNote || 'Same sim, same timings — the 3D stage swaps the top-down art for animated rigs.'}</p>
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
    this.el.querySelectorAll<HTMLElement>('[data-toggle-btn]').forEach((n) =>
      n.addEventListener('click', () => {
        const key = n.dataset.toggleBtn as 'showKillableHighlight';
        this.set(key, !this.config[key]);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-render]').forEach((n) =>
      n.addEventListener('click', () => this.setRenderMode(n.dataset.render as RenderMode)),
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
    <span class="run-meta">${r.duration / 60}m${r.enemyHero ? ` · vs ${DIFFICULTY_NAMES[r.enemyDifficulty].toLowerCase()}` : ' · solo'}</span>
    <span class="run-when">${when}</span>
  </div>`;
}

function safeParse(s: string): Partial<DrillConfig> {
  try {
    return JSON.parse(s) as Partial<DrillConfig>;
  } catch {
    return {};
  }
}
