import type { AttackPhase, DamageEvent, Team, Unit, UnitKind, Vec2 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { dist } from '../sim/math.ts';
import type { Mixer, Voice } from './mixer.ts';
import { BOW_DRAW_SECONDS, MERGE_DB, OTHER_HERO_DB, POSITION, type SoundName } from './sounds.ts';

/** Where a lane point is on screen: -1 at the left edge, 1 at the right. */
export type Locate = (p: Vec2) => { x: number; onScreen: boolean };

interface Known {
  kind: UnitKind;
  team: Team;
}

interface Cue {
  name: SoundName;
  pos: Vec2 | null;
  gainDb: number;
  /** Same-frame copies of this merge into one. */
  merge: boolean;
}

/**
 * Turns what the World did since the last frame into sounds. Reads the World
 * and never writes it; everything here is presentation, the same standing as
 * the impact sprites in effects.ts, and it follows `damageLog` by `seq` the
 * same way.
 *
 * It is only called while a drill is playing. The menu's backdrop lane is a
 * real World too, and it stays silent.
 */
export class LaneAudio {
  private seen = 0;
  private projectiles = new Set<number>();
  /**
   * Last frame's units. A creep killed this frame is already reaped by the
   * time this runs, so the lethal event is matched against what it was.
   */
  private known = new Map<number, Known>();
  private phases = new Map<number, { phase: AttackPhase; timer: number }>();
  /** A windup sound in progress, per hero, so a cancelled swing can cut it. */
  private windups = new Map<number, Voice | null>();

  constructor(
    private mixer: Mixer,
    private locate: Locate,
  ) {}

  /** Forget the previous drill, and play nothing for the lane it starts in. */
  reset(world: World) {
    this.seen = world.damageLog.length ? world.damageLog[world.damageLog.length - 1].seq : 0;
    this.projectiles = new Set(world.projectiles.map((p) => p.id));
    for (const v of this.windups.values()) v?.stop();
    this.windups.clear();
    this.phases.clear();
    this.remember(world);
  }

  update(world: World) {
    const cues: Cue[] = [];
    const player = world.player;

    for (const e of world.damageLog) {
      if (e.seq <= this.seen) continue;
      this.seen = e.seq;
      this.damage(e, world, cues);
    }

    for (const p of world.projectiles) {
      if (this.projectiles.has(p.id)) continue;
      this.projectiles.add(p.id);
      const src = world.units.get(p.sourceId);
      if (!src) continue;
      const name: SoundName | null =
        src.kind === 'hero'
          ? 'bow_release'
          : src.kind === 'ranged_creep'
            ? 'ranged_creep_cast'
            : src.kind === 'siege_creep'
              ? 'siege_launch'
              : src.kind === 'tower'
                ? 'tower_attack'
                : null;
      if (name) cues.push(this.attackCue(name, src.id, player, { x: p.pos.x, y: p.pos.y }, src.kind !== 'hero'));
    }
    // Keep only ids still in flight, so the set never grows past a volley.
    const live = new Set(world.projectiles.map((p) => p.id));
    for (const id of this.projectiles) if (!live.has(id)) this.projectiles.delete(id);

    for (const hero of [world.player, world.enemy]) if (hero) this.windup(hero, player);

    this.play(cues, player);
    this.remember(world);
  }

  private damage(e: DamageEvent, world: World, cues: Cue[]) {
    const player = world.player;
    const target = world.units.get(e.targetId) ?? null;
    const was = this.known.get(e.targetId) ?? (target ? knownOf(target) : null);

    const hit: SoundName | null =
      e.sourceKind === 'hero'
        ? e.ranged
          ? 'frost_arrow_hit'
          : 'sword_hit'
        : e.sourceKind === 'melee_creep'
          ? 'melee_creep_hit'
          : e.sourceKind === 'ranged_creep'
            ? 'ranged_creep_hit'
            : e.sourceKind === 'siege_creep'
              ? 'siege_hit'
              : e.sourceKind === 'tower'
                ? 'tower_hit'
                : null;
    if (hit) {
      cues.push(this.attackCue(hit, e.sourceId, player, e.pos, e.sourceKind !== 'hero'));
    }

    if (!e.lethal || !was) return;
    if (was.kind === 'hero') {
      cues.push({ name: 'hero_death', pos: e.pos, gainDb: 0, merge: false });
      return;
    }
    if (was.kind === 'tower') return;
    cues.push({ name: 'creep_death', pos: e.pos, gainDb: 0, merge: true });
    if (e.sourceId === player.id) {
      // The rewards are yours alone and always centred: Dota plays no coin for
      // the bot's last hits, and neither does this.
      const denied = was.team === player.team;
      cues.push({ name: denied ? 'deny' : 'last_hit_gold', pos: null, gainDb: 0, merge: false });
      if (!denied) this.mixer.duck();
    }
  }

  /**
   * One attack's launch or hit. Your own hero's play centred at their own
   * level, the bot's where they happen and lower; creep and tower sounds are
   * lane noise, and merge.
   */
  private attackCue(name: SoundName, sourceId: number, player: Unit, pos: Vec2, lane: boolean): Cue {
    if (lane) return { name, pos, gainDb: 0, merge: true };
    const mine = sourceId === player.id;
    return { name, pos: mine ? null : pos, gainDb: mine ? 0 : OTHER_HERO_DB, merge: false };
  }

  /**
   * The sounds that start with a swing rather than end it. A windup that ends
   * any way but in its release, a stop, a move or a new target, cuts its sound:
   * a swish for a swing that never landed would teach the wrong rhythm.
   */
  private windup(hero: Unit, player: Unit) {
    const prev = this.phases.get(hero.id);
    const now = { phase: hero.phase, timer: hero.phaseTimer };
    this.phases.set(hero.id, now);
    if (!hero.alive) {
      // Killed mid-swing: the sim leaves the phase as it was, the sound goes.
      this.windups.get(hero.id)?.stop(0.03);
      this.windups.delete(hero.id);
      return;
    }
    if (!prev) return;

    const restarted = prev.phase === 'windup' && now.phase === 'windup' && now.timer > prev.timer;
    const ended = prev.phase === 'windup' && (now.phase !== 'windup' || restarted);
    if (ended) {
      const voice = this.windups.get(hero.id);
      this.windups.delete(hero.id);
      // Released: the swish plays out, and the draw ends on the release by
      // construction. Anything else was called off.
      if (now.phase !== 'backswing' || restarted) voice?.stop(0.03);
    }
    if (now.phase !== 'windup' || (prev.phase === 'windup' && !restarted)) return;

    const ranged = hero.projectileSpeed > 0;
    const mine = hero.id === player.id;
    const pos = this.place(hero.pos, player, mine);
    // The draw is cut to peak at full draw, so it starts late enough to end on
    // the release however fast the attack is: this frame's remaining windup is
    // exactly how long until then.
    const offset = ranged ? Math.max(0, BOW_DRAW_SECONDS - hero.phaseTimer) : 0;
    const voice = this.mixer.play(ranged ? 'bow_draw' : 'sword_swing', {
      pan: pos.pan,
      gainDb: pos.gainDb + (mine ? 0 : OTHER_HERO_DB),
      offset,
    });
    this.windups.set(hero.id, voice);
  }

  private play(cues: Cue[], player: Unit) {
    // In a wave collision several creeps land in the same frame. Three identical
    // transients in one millisecond only phase against each other, so they play
    // as one copy, a little louder.
    const merged = new Map<SoundName, { cue: Cue; n: number }>();
    for (const cue of cues) {
      if (!cue.merge) {
        this.fire(cue, player, 0);
        continue;
      }
      const m = merged.get(cue.name);
      if (m) m.n++;
      else merged.set(cue.name, { cue, n: 1 });
    }
    for (const { cue, n } of merged.values()) this.fire(cue, player, n > 1 ? MERGE_DB : 0);
  }

  private fire(cue: Cue, player: Unit, extraDb: number) {
    const at = cue.pos ? this.place(cue.pos, player, false) : { pan: 0, gainDb: 0 };
    this.mixer.play(cue.name, { pan: at.pan, gainDb: cue.gainDb + at.gainDb + extraDb });
  }

  /** Pan by screen x, quieter with distance from your hero and off screen. */
  private place(p: Vec2, player: Unit, centred: boolean): { pan: number; gainDb: number } {
    if (centred) return { pan: 0, gainDb: 0 };
    const { x, onScreen } = this.locate(p);
    const pan = Math.max(-POSITION.maxPan, Math.min(POSITION.maxPan, x * POSITION.maxPan));
    const d = dist(p, player.pos);
    const t = Math.max(0, Math.min(1, (d - POSITION.nearUnits) / (POSITION.farUnits - POSITION.nearUnits)));
    return { pan, gainDb: t * POSITION.farDb + (onScreen ? 0 : POSITION.offscreenDb) };
  }

  private remember(world: World) {
    this.known.clear();
    for (const u of world.units.values()) if (u.alive) this.known.set(u.id, knownOf(u));
  }
}

function knownOf(u: Unit): Known {
  return { kind: u.kind, team: u.team };
}
