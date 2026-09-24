/** Everything the menu can change about a drill. */
export interface DrillConfig {
  heroId: string;
  /** Drill length in seconds. */
  duration: number;

  /** Layer 2: allow denying your own creeps. */
  deniesEnabled: boolean;
  /** Layer 3: an enemy hero contests the lane. */
  enemyHero: boolean;
  enemyHeroId: string;
  /** 1 = sloppy laner, 5 = scripted. */
  enemyDifficulty: 1 | 2 | 3 | 4 | 5;
  /** Layer 4: right-clicking the enemy hero pulls creep aggro onto you. */
  aggroEnabled: boolean;

  /** Training aids. */
  showKillableHighlight: boolean;
  showRangeRings: boolean;
  showDamagePreview: boolean;

  seed: number;
}

export const DEFAULT_CONFIG: DrillConfig = {
  heroId: 'shadow_fiend',
  duration: 180,
  deniesEnabled: true,
  enemyHero: true,
  enemyHeroId: 'crystal_maiden',
  enemyDifficulty: 3,
  aggroEnabled: true,
  showKillableHighlight: true,
  showRangeRings: true,
  showDamagePreview: true,
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

export const ENEMY_PROFILES: Record<number, EnemyProfile> = {
  1: { reaction: 0.45, estimateError: 0.35, missChance: 0.55, denies: false, harass: 0.0 },
  2: { reaction: 0.3, estimateError: 0.22, missChance: 0.35, denies: false, harass: 0.1 },
  3: { reaction: 0.2, estimateError: 0.14, missChance: 0.2, denies: true, harass: 0.25 },
  4: { reaction: 0.12, estimateError: 0.07, missChance: 0.08, denies: true, harass: 0.4 },
  5: { reaction: 0.04, estimateError: 0.0, missChance: 0.0, denies: true, harass: 0.6 },
};
