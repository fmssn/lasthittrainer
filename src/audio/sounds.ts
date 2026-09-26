/**
 * The sound manifest, and the whole mix. Levels are set against the coin at
 * 0 dB; every file is normalised to the same peak (docs/sounds.md), so these
 * numbers are the balance and nothing else is. Tune here and nowhere else: if
 * the lane is muddy, turn the lane down, never the rewards up.
 */

/**
 * Mix groups. Each has a gain node the volume sliders act on. The own-hero,
 * lane and reward levels of the plan are per-sound levels below, not groups,
 * because the same file plays at two levels depending on whose hero swung.
 */
export type Group = 'effects' | 'ambience' | 'ui';

export interface SoundDef {
  files: string[];
  group: Group;
  gainDb: number;
  /** Copies allowed at once; a new one steals the oldest. */
  voices: number;
  /** Panned and attenuated by where it happens, rather than played centred. */
  positional: boolean;
  loop?: boolean;
}

const lane = (file: string, gainDb: number, voices = 4): SoundDef => ({
  files: [file],
  group: 'effects',
  gainDb,
  voices,
  positional: true,
});

/** Your own hero's attack sounds. The bot's play the same files, lower. */
const ownHero = (file: string): SoundDef => ({
  files: [file],
  group: 'effects',
  gainDb: -4,
  voices: Infinity,
  positional: true,
});

/**
 * The level every creep sound is set from. It started at -10 and was too loud
 * by ear twice, at -10 and -16: a wave collision is a dozen of them at once,
 * and they are background to your own swing. Turn this, not the individual
 * lines, while the lane is still too busy.
 */
const CREEP_DB = -22;

export const SOUNDS = {
  last_hit_gold: { files: ['last_hit_gold_1.wav'], group: 'effects', gainDb: 0, voices: Infinity, positional: false },
  deny: { files: ['deny_1.wav'], group: 'effects', gainDb: 0, voices: Infinity, positional: false },

  sword_swing: ownHero('sword_swing_1.wav'),
  sword_hit: ownHero('sword_hit_1.wav'),
  bow_draw: ownHero('bow_draw_1.wav'),
  bow_release: ownHero('bow_release_1.wav'),
  frost_arrow_hit: ownHero('frost_arrow_hit_1.wav'),

  melee_creep_hit: lane('melee_creep_hit_1.wav', CREEP_DB),
  ranged_creep_cast: lane('ranged_creep_cast_1.wav', CREEP_DB),
  ranged_creep_hit: lane('ranged_creep_hit_1.wav', CREEP_DB),
  creep_death: lane('creep_death_1.wav', CREEP_DB - 2),
  siege_launch: lane('siege_launch_1.wav', CREEP_DB + 2),
  siege_hit: lane('siege_hit_1.wav', CREEP_DB + 2),
  tower_attack: lane('tower_attack_1.wav', -8),
  tower_hit: lane('tower_hit_1.wav', -8),
  hero_death: lane('hero_death_1.wav', -6, 2),

  horn: { files: ['horn_1.wav'], group: 'ui', gainDb: 0, voices: 1, positional: false },
  run_end: { files: ['run_end_1.wav'], group: 'ui', gainDb: 0, voices: 1, positional: false },
  ui_click: { files: ['ui_click_1.wav'], group: 'ui', gainDb: 0, voices: 2, positional: false },
  lane_ambience: { files: ['lane_ambience_1.wav'], group: 'ambience', gainDb: 0, voices: 1, positional: false, loop: true },
} satisfies Record<string, SoundDef>;

export type SoundName = keyof typeof SOUNDS;

/** The bot hero's attack sounds sit here relative to your own: -8 against -4. */
export const OTHER_HERO_DB = -4;

/**
 * Group levels. `ui` covers the horn and the results sting as well as clicks,
 * all at -8. The ambience sits far under everything, at -24, and dips 3 dB
 * for 400 ms on a last hit; nothing else ducks, since Dota does not.
 */
export const GROUP_DB: Record<Group, number> = { effects: 0, ambience: -24, ui: -8 };
export const DUCK = { db: -3, seconds: 0.4 };

/** Several copies of one lane sound in one frame play as one, this much louder. */
export const MERGE_DB = 2;

/** Every play shifts pitch by up to this fraction and level by up to this many dB. */
export const JITTER = { rate: 0.04, db: 1.5 };

/**
 * Where a positional sound sits: panned by its screen x, never harder than
 * this, and quieter with distance from your hero and when off screen.
 */
export const POSITION = {
  maxPan: 0.6,
  nearUnits: 300,
  farUnits: 1500,
  farDb: -6,
  offscreenDb: -6,
};

/** The draw file is cut to end at full draw; it is started this far from its end. */
export const BOW_DRAW_SECONDS = 0.45;
