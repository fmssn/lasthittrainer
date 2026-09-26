/**
 * Whether the player muted the drill (M), kept in this browser. A convenience
 * only: it acts on the mixer's master gain and can never change what the sim
 * does.
 */
const KEY = 'lht.audio.v1';

/** Storage can throw rather than return null (private window, blocked site data). */
export function loadMuted(): boolean {
  try {
    const saved = localStorage.getItem(KEY);
    return saved ? !!(JSON.parse(saved) as { muted?: boolean }).muted : false;
  } catch {
    return false;
  }
}

export function saveMuted(muted: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ muted }));
  } catch {
    // Storage full or blocked. The setting still applies to this session.
  }
}
