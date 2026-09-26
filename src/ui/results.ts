import { heroById } from '../sim/heroes.ts';
import type { DrillConfig } from '../sim/config.ts';
import { loadoutLabel } from '../sim/items.ts';
import type { Stats } from '../sim/world.ts';
import { buildRecord, loadRuns, personalBest, saveRun } from '../stats.ts';

export class Results {
  private el: HTMLDivElement;

  constructor(
    root: HTMLElement,
    private onRetry: () => void,
    private onMenu: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'screen results';
    this.el.hidden = true;
    root.appendChild(this.el);
  }

  hide() {
    this.el.hidden = true;
  }

  show(config: DrillConfig, stats: Stats) {
    const record = buildRecord(config, stats);
    const before = loadRuns();
    const best = personalBest(before, record);
    saveRun(record);

    const hero = heroById(config.heroId);
    const perMin = (stats.lastHits / config.duration) * 60;
    const improved = best ? record.lastHits - best.lastHits : null;

    this.el.innerHTML = `
      <div class="results-inner">
        <header>
          <span class="results-hero"><i style="background:${hero.color}"></i>${hero.name}${config.items.length ? ` · ${loadoutLabel(config.items)}` : ''}</span>
          <h1>${stats.lastHits} last hits${config.deniesEnabled ? ` · ${stats.denies} denies` : ''}</h1>
          ${
            improved === null
              ? `<p class="verdict">First run with these settings. This is your baseline.</p>`
              : improved > 0
                ? `<p class="verdict good">New best — ${improved} more than your previous ${best!.lastHits}.</p>`
                : improved === 0
                  ? `<p class="verdict">Matched your best of ${best!.lastHits}.</p>`
                  : `<p class="verdict">${Math.abs(improved)} short of your best of ${best!.lastHits}.</p>`
          }
        </header>

        <div class="grid">
          ${card('Accuracy', `${Math.round(record.accuracy * 100)}%`, `${stats.lastHits} of ${stats.lastHits + stats.missed} enemy creeps`)}
          ${
            config.deniesEnabled
              ? card('Deny rate', `${Math.round(record.denyRate * 100)}%`, `${stats.denies} of ${stats.denies + stats.conceded} own creeps`)
              : card('Missed', String(stats.missed), 'enemy creeps you did not get')
          }
          ${card('Gold', String(stats.gold), `${Math.round((stats.gold / config.duration) * 60)} GPM from creeps`)}
          ${card('Last hits / min', perMin.toFixed(1), benchmark(perMin))}
          ${config.enemyHero ? card('Enemy hero', `${stats.enemyLastHits} LH`, `${stats.enemyDenies} denies against you`) : ''}
          ${stats.deaths > 0 ? card('Deaths', String(stats.deaths), 'stop standing in the wave') : ''}
        </div>

        <p class="takeaway">${takeaway(record, stats, config)}</p>

        <div class="actions">
          <button class="start" data-retry>Run it again</button>
          <button class="ghost" data-menu>Change settings</button>
        </div>
      </div>
    `;
    this.el.hidden = false;
    this.el.querySelector('[data-retry]')?.addEventListener('click', () => this.onRetry());
    this.el.querySelector('[data-menu]')?.addEventListener('click', () => this.onMenu());
  }
}

function card(label: string, value: string, sub: string): string {
  return `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div></div>`;
}

/** Rough in-game reference points for creeps per minute in a real lane. */
function benchmark(perMin: number): string {
  if (perMin >= 12) return 'pro lane pace';
  if (perMin >= 9) return 'strong — Divine/Immortal range';
  if (perMin >= 6.5) return 'solid — Ancient range';
  if (perMin >= 4.5) return 'decent — Legend range';
  return 'this is the one to push up';
}

function takeaway(
  record: ReturnType<typeof buildRecord>,
  stats: Stats,
  config: DrillConfig,
): string {
  // A run too short for any enemy creep to die scores 0/0, which is not the
  // same as missing everything and must not be read back as "under half".
  if (stats.lastHits + stats.missed === 0) {
    return 'No creep died on your side of the lane in that run. Give it long enough for a wave to actually fight.';
  }
  if (stats.deaths > 0) {
    return 'You died in a farming drill. Step back between hits — being in creep acquisition range costs more than any single last hit.';
  }
  if (stats.wastedSwings > 3) {
    return `You lost ${stats.wastedSwings} swings to creeps dying mid-animation. You are clicking too early: start the attack when the creep's HP is one hit away, not two.`;
  }
  if (record.accuracy < 0.5) {
    return 'Under half. Stop trying to hit every creep — pick the one that will drop next and commit to that single timing.';
  }
  if (config.deniesEnabled && record.denyRate < 0.15 && record.accuracy > 0.65) {
    return 'Last hits are landing, denies are not. Watch the 50% line on your own creeps and keep the A-key hand ready between your own attacks.';
  }
  if (config.enemyHero && stats.enemyLastHits > stats.lastHits) {
    return 'The enemy hero out-farmed you. Try pulling their creep aggro with a right-click when they step up — their creeps chasing them is your free window.';
  }
  if (record.accuracy > 0.85) {
    return 'That accuracy is real. Turn off the killable highlight and damage preview and run it again — the timing has to live in your hands, not the UI.';
  }
  return 'Solid run. Push the enemy difficulty up one notch, or switch to a hero with a slower attack point.';
}
