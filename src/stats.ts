import type { DrillConfig } from './sim/config.ts';
import type { Stats } from './sim/world.ts';
import type { ItemId } from './sim/items.ts';
import { canonicalHeroId } from './sim/heroes.ts';

const KEY = 'lht.runs.v1';
const MAX_RUNS = 200;

export interface RunRecord {
  at: number;
  heroId: string;
  /** Absent on runs recorded before starting items existed, which had none. */
  items?: ItemId[];
  duration: number;
  enemyHero: boolean;
  enemyDifficulty: number;
  deniesEnabled: boolean;
  aggroEnabled: boolean;
  lastHits: number;
  denies: number;
  missed: number;
  conceded: number;
  gold: number;
  deaths: number;
  /** Last hits divided by enemy creeps that died. */
  accuracy: number;
  /** Denies divided by your creeps that died. */
  denyRate: number;
}

export function buildRecord(config: DrillConfig, stats: Stats): RunRecord {
  const possibleLh = stats.lastHits + stats.missed;
  const possibleDn = stats.denies + stats.conceded;
  return {
    at: Date.now(),
    heroId: config.heroId,
    items: [...config.items],
    duration: config.duration,
    enemyHero: config.enemyHero,
    enemyDifficulty: config.enemyDifficulty,
    deniesEnabled: config.deniesEnabled,
    aggroEnabled: config.aggroEnabled,
    lastHits: stats.lastHits,
    denies: stats.denies,
    missed: stats.missed,
    conceded: stats.conceded,
    gold: stats.gold,
    deaths: stats.deaths,
    accuracy: possibleLh > 0 ? stats.lastHits / possibleLh : 0,
    denyRate: possibleDn > 0 ? stats.denies / possibleDn : 0,
  };
}

export function loadRuns(): RunRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Runs saved under a hero's old id are read back under its new one, so a
    // personal best survives the rename. A retired hero keeps its id.
    return (parsed as RunRecord[]).map((r) => ({ ...r, heroId: canonicalHeroId(r.heroId) ?? r.heroId }));
  } catch {
    return [];
  }
}

export function saveRun(run: RunRecord): RunRecord[] {
  const runs = loadRuns();
  runs.push(run);
  const trimmed = runs.slice(-MAX_RUNS);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full or blocked (private window). The run still shows on screen.
  }
  return trimmed;
}

/** Order-free identity of a loadout: two branches then a blade is a blade and two branches. */
function loadoutKey(items: readonly ItemId[] | undefined): string {
  return [...(items ?? [])].sort().join(',');
}

/**
 * Best previous run under comparable settings, for the "new best" callout. A
 * Quelling Blade changes which hits kill, so a run with one is not a baseline
 * for a run without.
 */
export function personalBest(runs: RunRecord[], run: RunRecord): RunRecord | null {
  const comparable = runs.filter(
    (r) =>
      r !== run &&
      r.heroId === run.heroId &&
      loadoutKey(r.items) === loadoutKey(run.items) &&
      r.duration === run.duration &&
      r.enemyHero === run.enemyHero &&
      r.enemyDifficulty === run.enemyDifficulty,
  );
  if (comparable.length === 0) return null;
  return comparable.reduce((a, b) => (b.lastHits > a.lastHits ? b : a));
}

export function clearRuns() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
