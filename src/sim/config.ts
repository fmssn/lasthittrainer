import type { ItemId } from './items.ts';

/** Everything the menu can change about a drill. */
export interface DrillConfig {
  heroId: string;
  /** Your starting items. The bot always starts empty-handed. */
  items: ItemId[];
  /**
   * Drill length in creep waves, counting the first one, which leaves the
   * bases once {@link START_COUNTDOWN} runs out. The drill ends once every
   * creep of the last wave has died, so the last wave is farmed as fully as
   * the first.
   */
  waves: number;

  /** Layer 2: allow denying your own creeps. */
  deniesEnabled: boolean;
  /** Layer 3: an enemy hero contests the lane. */
  enemyHero: boolean;
  enemyHeroId: string;
  /** 1 = sloppy laner, 5 = scripted. */
  enemyDifficulty: 1 | 2 | 3 | 4 | 5;
  /** Layer 4: right-clicking the enemy hero pulls creep aggro onto you. */
  aggroEnabled: boolean;

  seed: number;
}

/**
 * Seconds between the start of a drill and the first wave leaving the bases,
 * with both heroes standing behind their tier 1 towers. The world clock runs
 * from minus this, so the first wave leaves at 0:00 as it does in Dota and
 * every timing that follows the game clock (the 5:00 end of the early-aggro
 * block, the siege wave) keeps its real time. Dota's own wait is 90 seconds of
 * pregame; five is enough to take the mouse and walk up.
 */
export const START_COUNTDOWN = 5;

export const DEFAULT_CONFIG: DrillConfig = {
  heroId: 'frost_archer',
  items: [],
  waves: 6,
  deniesEnabled: true,
  enemyHero: true,
  enemyHeroId: 'swordmaster',
  enemyDifficulty: 3,
  aggroEnabled: true,
  seed: Date.now() & 0xffff,
};

export interface EnemyProfile {
  /** Seconds between the bot noticing a killable creep and acting. */
  reaction: number;
  /** Random error added to its damage estimate, as a fraction. */
  estimateError: number;
  /** Chance per opportunity that it simply does not go for the creep. */
  missChance: number;
  /** Whether it bothers denying. */
  denies: boolean;
  /** Chance it right-clicks you when you step up, pulling creep aggro onto you. */
  harass: number;
}

/** What the menu and HUD call each profile. Not "level": heroes have levels. */
export const DIFFICULTY_NAMES = ['', 'Sloppy', 'Casual', 'Decent', 'Strong', 'Scripted'];

export const ENEMY_PROFILES: Record<number, EnemyProfile> = {
  1: { reaction: 0.45, estimateError: 0.35, missChance: 0.55, denies: false, harass: 0.0 },
  2: { reaction: 0.3, estimateError: 0.22, missChance: 0.35, denies: false, harass: 0.1 },
  3: { reaction: 0.2, estimateError: 0.14, missChance: 0.2, denies: true, harass: 0.25 },
  4: { reaction: 0.12, estimateError: 0.07, missChance: 0.08, denies: true, harass: 0.4 },
  5: { reaction: 0.04, estimateError: 0.0, missChance: 0.0, denies: true, harass: 0.6 },
};
