/**
 * The player's volume settings, kept in this browser. A convenience only: they
 * act on the mixer's gains and can never change what the sim does.
 */
export interface SoundSettings {
  master: number;
  effects: number;
  ambience: number;
  muted: boolean;
}

const KEY = 'lht.audio.v1';
const DEFAULTS: SoundSettings = { master: 0.8, effects: 1, ambience: 1, muted: false };

/** Storage can throw rather than return null (private window, blocked site data). */
export function loadSoundSettings(): SoundSettings {
  try {
    const saved = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(saved ? (JSON.parse(saved) as Partial<SoundSettings>) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSoundSettings(s: SoundSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage full or blocked. The setting still applies to this session.
  }
}
