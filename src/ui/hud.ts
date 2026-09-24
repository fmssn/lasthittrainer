import { World } from '../sim/world.ts';
import { heroById } from '../sim/heroes.ts';

function fmtTime(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export class Hud {
  private el: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-top">
        <div class="hud-panel hud-left">
          <div class="stat stat-lh"><span class="stat-value" data-lh>0</span><span class="stat-label">last hits</span></div>
          <div class="stat stat-dn"><span class="stat-value" data-dn>0</span><span class="stat-label">denies</span></div>
          <div class="stat stat-sub"><span class="stat-value" data-gold>0</span><span class="stat-label">gold</span></div>
          <div class="stat stat-sub"><span class="stat-value" data-acc>—</span><span class="stat-label">accuracy</span></div>
        </div>
        <div class="hud-panel hud-center">
          <div class="clock" data-clock>0:00</div>
          <div class="wave" data-wave></div>
        </div>
        <div class="hud-panel hud-right" data-enemy-panel>
          <div class="enemy-name" data-enemy-name></div>
          <div class="enemy-line"><span data-elh>0</span> LH · <span data-edn>0</span> DN</div>
        </div>
      </div>
      <div class="hud-bottom">
        <div class="hints">
          <span><kbd>RMB</kbd> move / attack</span>
          <span class="hint-a" data-hint-a><kbd>A</kbd> attack / deny under cursor</span>
          <span><kbd>S</kbd> stop</span>
          <span><kbd>Space</kbd> pause</span>
        </div>
      </div>
      <div class="dead-overlay" data-dead hidden>
        <div class="dead-title">You died</div>
        <div class="dead-sub">Respawning in <span data-respawn>6</span>s — stop tanking the wave.</div>
      </div>
    `;
    root.appendChild(this.el);
  }

  private q<T extends HTMLElement>(attr: string): T {
    return this.el.querySelector(`[${attr}]`) as T;
  }

  show() {
    this.el.hidden = false;
  }

  hide() {
    this.el.hidden = true;
  }

  update(world: World, attackReady: boolean) {
    const s = world.stats;
    this.q('data-lh').textContent = String(s.lastHits);
    this.q('data-dn').textContent = String(s.denies);
    this.q('data-gold').textContent = String(s.gold);

    const possible = s.lastHits + s.missed;
    this.q('data-acc').textContent = possible > 0 ? `${Math.round((s.lastHits / possible) * 100)}%` : '—';

    this.q('data-clock').textContent = fmtTime(world.config.duration - world.time);
    this.q('data-wave').textContent = `next wave ${fmtTime(world.waveTimer)}`;

    const panel = this.q('data-enemy-panel');
    if (world.enemy) {
      panel.hidden = false;
      this.q('data-enemy-name').textContent = `${heroById(world.config.enemyHeroId).name} · lvl ${world.config.enemyDifficulty}`;
      this.q('data-elh').textContent = String(s.enemyLastHits);
      this.q('data-edn').textContent = String(s.enemyDenies);
    } else {
      panel.hidden = true;
    }

    // Lights up while the cursor is on something A would hit, which is the
    // only cue left now that A no longer arms a visible crosshair.
    this.q('data-hint-a').classList.toggle('active', attackReady);
    const dead = this.q('data-dead');
    dead.hidden = world.player.alive;
    if (!world.player.alive) {
      this.q('data-respawn').textContent = String(Math.ceil(Math.max(0, world.playerRespawnTimer)));
    }
  }
}
