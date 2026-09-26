import { DUCK, GROUP_DB, JITTER, SOUNDS, type Group, type SoundDef, type SoundName } from './sounds.ts';

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** A steal or a stop fades out over this long, so cutting a sound never clicks. */
const FADE = 0.005;

export interface PlayOptions {
  /** -1 (left) .. 1 (right); only positional sounds take it. */
  pan?: number;
  /** Added to the manifest level: position, merge, whose hero. */
  gainDb?: number;
  /** Seconds into the file to start from. */
  offset?: number;
}

export interface Voice {
  stop(fade?: number): void;
}

interface Playing {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * Web Audio playback for the drill. Knows the manifest and nothing about the
 * World: laneAudio decides what to play, this decides how it sounds.
 *
 * Audio is not a startup dependency. A file that fails to load or decode
 * warns once and that sound stays silent; the drill still starts. The
 * context is created up front, suspended as browsers keep it until a user
 * gesture, and `resume()` is called from the first click that has one.
 */
export class Mixer {
  readonly ctx: AudioContext | null;
  private master: GainNode | null = null;
  private groups = new Map<Group, GainNode>();
  private ducker: GainNode | null = null;
  private buffers = new Map<SoundName, AudioBuffer[]>();
  private playing = new Map<SoundName, Playing[]>();
  private lastPick = new Map<SoundName, number>();
  private volume = { master: 1, effects: 1, ambience: 1 };
  private muted = false;
  /** Plays requested per sound, whether or not anything was audible. */
  readonly counts: Partial<Record<SoundName, number>> = {};

  constructor(private urlOf: (path: string) => string) {
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
    } catch (err) {
      console.warn('No Web Audio here; the drill runs silent.', err);
    }
    this.ctx = ctx;
    if (!ctx) return;

    // A limiter at the end of the chain: a wave collision can stack a dozen
    // transients, and it is better squashed than clipped.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.connect(limiter);
    for (const g of Object.keys(GROUP_DB) as Group[]) {
      const node = ctx.createGain();
      if (g === 'ambience') {
        // The ambience has a second gain of its own for ducking, so a dip never
        // fights the volume slider for the same parameter.
        this.ducker = ctx.createGain();
        node.connect(this.ducker).connect(this.master);
      } else {
        node.connect(this.master);
      }
      this.groups.set(g, node);
    }
    this.applyVolume();
  }

  /** Fetch and decode every file in the manifest. Never rejects. */
  async load(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    await Promise.all(
      (Object.keys(SOUNDS) as SoundName[]).map(async (name) => {
        const bufs: AudioBuffer[] = [];
        for (const file of SOUNDS[name].files) {
          try {
            bufs.push(await ctx.decodeAudioData(await bytes(this.urlOf(`audio/${file}`))));
          } catch (err) {
            console.warn(`Sound ${file} did not load; ${name} stays silent.`, err);
          }
        }
        if (bufs.length) this.buffers.set(name, bufs);
      }),
    );
  }

  resume() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  suspend() {
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  play(name: SoundName, opts: PlayOptions = {}): Voice | null {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    const ctx = this.ctx;
    const bufs = this.buffers.get(name);
    if (!ctx || !bufs) return null;
    const def: SoundDef = SOUNDS[name];

    // A different variation from last time whenever there is more than one.
    let pick = Math.floor(Math.random() * bufs.length);
    if (bufs.length > 1 && pick === this.lastPick.get(name)) pick = (pick + 1) % bufs.length;
    this.lastPick.set(name, pick);
    const buffer = bufs[pick];

    const list = this.playing.get(name) ?? [];
    this.playing.set(name, list);
    while (list.length >= def.voices) {
      const oldest = list.shift()!;
      fadeOut(ctx, oldest, FADE);
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!def.loop;
    const jitter = def.loop ? 0 : 1;
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * JITTER.rate * jitter;
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(def.gainDb + (opts.gainDb ?? 0) + (Math.random() * 2 - 1) * JITTER.db * jitter);

    let tail: AudioNode = gain;
    if (def.positional && opts.pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = opts.pan;
      gain.connect(panner);
      tail = panner;
    }
    src.connect(gain);
    tail.connect(this.groups.get(def.group)!);

    const entry: Playing = { src, gain };
    list.push(entry);
    src.onended = () => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
    src.start(ctx.currentTime, Math.min(opts.offset ?? 0, Math.max(0, buffer.duration - 0.01)));
    return {
      stop: (fade = FADE) => {
        const i = list.indexOf(entry);
        if (i < 0) return;
        list.splice(i, 1);
        fadeOut(ctx, entry, fade);
      },
    };
  }

  /** Fade every copy of one sound out, or of everything with no name. */
  stop(name?: SoundName, fade = FADE) {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [n, list] of this.playing) {
      if (name && n !== name) continue;
      for (const p of list.splice(0)) fadeOut(ctx, p, fade);
    }
  }

  /** Dip the ambience, as a last hit does. */
  duck() {
    const ctx = this.ctx;
    if (!ctx || !this.ducker) return;
    const g = this.ducker.gain;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(dbToGain(DUCK.db), t + 0.02);
    g.setValueAtTime(dbToGain(DUCK.db), t + DUCK.seconds);
    g.linearRampToValueAtTime(1, t + DUCK.seconds + 0.2);
  }

  /** Slider values, 0..1 each. They act on gains only and never reach the sim. */
  setVolume(v: Partial<Mixer['volume']>) {
    Object.assign(this.volume, v);
    this.applyVolume();
  }

  getVolume() {
    return { ...this.volume };
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyVolume();
  }

  isMuted() {
    return this.muted;
  }

  private applyVolume() {
    if (!this.ctx || !this.master) return;
    // Sliders run on a squared curve: linear gain makes the bottom half of a
    // slider do nothing you can hear.
    const curve = (x: number) => x * x;
    this.master.gain.value = this.muted ? 0 : curve(this.volume.master);
    for (const [g, node] of this.groups) {
      const slider = g === 'effects' ? this.volume.effects : g === 'ambience' ? this.volume.ambience : 1;
      node.gain.value = dbToGain(GROUP_DB[g]) * curve(slider);
    }
  }
}

function fadeOut(ctx: AudioContext, p: Playing, fade: number) {
  const t = ctx.currentTime;
  p.gain.gain.cancelScheduledValues(t);
  p.gain.gain.setValueAtTime(p.gain.gain.value, t);
  p.gain.gain.linearRampToValueAtTime(0, t + fade);
  try {
    p.src.stop(t + fade + 0.001);
  } catch {
    // Already stopped.
  }
}

/**
 * A file's bytes. The single-file build carries every file as a data: URL, and
 * the strict policy it is published under may refuse a fetch even of that, so
 * those are decoded here rather than fetched.
 */
async function bytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) {
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}
