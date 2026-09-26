import * as THREE from 'three';
import type { Unit, Vec2 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { AGGRO_DURATION } from '../sim/constants.ts';
import { clamp } from '../sim/math.ts';
import { healthBarHeight } from './appearance.ts';

/**
 * The screen-space layer of the 3D renderer.
 *
 * Health bars are read at a glance mid-swing, so they must not shrink or tilt
 * with the stage. They are
 * drawn on a 2D canvas over the WebGL one, at positions projected through the
 * same camera — the 3D stage stays the world, this stays the instrument.
 *
 * Everything here is sized in screen pixels and anchored to
 * {@link healthBarHeight}, so a bar sits on its owner's head at any zoom and
 * stays legible at any distance. That is Dota's own choice: health bars are the
 * one part of the scene that must never get smaller when you zoom out, because
 * they are what you are actually reading when you decide to swing.
 */

const COLORS = {
  radiant: '#5fbf7a',
  dire: '#d8615a',
  text: '#e6edf3',
  shadow: 'rgba(0,0,0,0.85)',
  /** Dota's hurt chunk is white; kept below full opacity so it never reads as health. */
  hurt: 'rgba(255,255,255,0.7)',
  sheen: 'rgba(255,255,255,0.22)',
  /** Dota outlines the bar under the cursor too (`dota_hud_healthbar_hoveroutline_alpha`). */
  hover: 'rgba(255,255,255,0.78)',
};

/** Bar geometry in screen pixels, per unit class. */
const BAR = {
  creep: { w: 36, h: 5 },
  hero: { w: 62, h: 8 },
};

/**
 * Hero bars carry a thin line per 250 HP and a thick one per 1000, which is
 * Dota's default (`dota_health_per_vertical_marker 250`). Dota's creep bars
 * carry none, and neither do these.
 */
const HP_PER_MARKER = 250;
const MARKERS_PER_MAJOR = 4;

/**
 * The hurt chunk: when a unit takes damage, what it just lost stays on the bar
 * in white, holds, then drains into the new edge. Dota does the same (the
 * `dota_health_hurt_*` convars), and without it a creep hit is a one-pixel jump
 * the eye never catches — a bar under fire from three creeps seems to stand
 * still, then is suddenly low. Every fresh hit restarts the hold, so under
 * sustained fire the chunk shows how fast the unit is dropping, which is the
 * thing you are judging when you time a last hit.
 *
 * Kept short, because the complaint players who zero those convars have is a
 * white bar that lingers long enough to be misread as health. This one sits
 * past the live edge, never over it, and is gone half a second after the last
 * hit.
 */
const HURT_HOLD = 0.2;
/** Drain time constant, in seconds: the chunk is under 5% of itself 0.36s into the drain. */
const HURT_TAU = 0.12;

interface Hurt {
  /** The bar's trailing edge, in HP. Equal to `hp` when there is nothing to show. */
  hp: number;
  /** HP last frame, so a fresh hit can be told from one still draining. */
  last: number;
  /** Seconds of hold left before the chunk starts to drain. */
  hold: number;
}

export class Annotations {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly v = new THREE.Vector3();
  private w = 0;
  private h = 0;
  private dpr = 1;

  /**
   * Hurt chunks by unit id. This is presentational state and so lives here, not
   * on the unit. Timed by the sim's own clock rather than the frame's, so a
   * paused drill holds a chunk still instead of draining it behind the menu.
   */
  private readonly hurt = new Map<number, Hurt>();
  private hurtWorld: World | null = null;
  private hurtClock = 0;

  constructor(
    container: HTMLElement,
    before: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage3d-hud';
    container.insertBefore(this.canvas, before);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available in this browser');
    this.ctx = ctx;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = this.canvas.clientWidth || window.innerWidth;
    this.h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Snap to the device-pixel grid. Rounding to whole CSS pixels only lands on
   * it at 100% display scaling: at 125% or 150% a 5px bar is 6.25 or 7.5
   * device pixels, and every edge smears across two rows.
   */
  private px(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  /**
   * Fill the span between two edges, both snapped. Taking edges rather than a
   * width is what lets adjacent segments — fill, hurt, hero ticks — share a
   * boundary exactly instead of leaving a hairline or overlapping by one.
   */
  private span(x0: number, y0: number, x1: number, y1: number) {
    const a = this.px(x0);
    const b = this.px(x1);
    if (b > a) this.ctx.fillRect(a, this.px(y0), b - a, this.px(y1) - this.px(y0));
  }

  /**
   * A frame `t` thick inside the given box, as four spans. Not strokeRect: a
   * stroke straddles its path, so a 2px line on whole-pixel edges smears over
   * three rows, and a translucent one double-paints its corners.
   */
  private ring(x0: number, y0: number, x1: number, y1: number, t: number) {
    this.span(x0, y0, x1, y0 + t);
    this.span(x0, y1 - t, x1, y1);
    this.span(x0, y0 + t, x0 + t, y1 - t);
    this.span(x1 - t, y0 + t, x1, y1 - t);
  }

  dispose() {
    this.canvas.remove();
  }

  /** Sim point at height `up` to CSS pixels on this canvas. */
  private project(p: Vec2, up = 0): Vec2 {
    this.v.set(p.x, up, p.y).project(this.camera);
    return { x: (this.v.x * 0.5 + 0.5) * this.w, y: (-this.v.y * 0.5 + 0.5) * this.h };
  }

  /** True when the point is behind the camera, where projection folds over. */
  private behind(): boolean {
    return this.v.z > 1;
  }

  /**
   * Pixels per sim unit near `p`. Not one number for the frame: under a
   * perspective camera a unit at the far end of the lane is smaller than one
   * at the near end, so it is measured by projecting a known span there.
   */
  private pxPerUnitAt(p: Vec2): number {
    const a = this.project(p);
    const b = this.project({ x: p.x + 100, y: p.y });
    return Math.hypot(b.x - a.x, b.y - a.y) / 100;
  }

  draw(world: World, hoverId: number | null) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();

    const dt = this.tickHurt(world);
    // Far units first, so a near health bar wins the overlap. Sorted on screen
    // rather than on sim y: the camera is yawed, so a unit further along the
    // lane at the same y is further away, and its bar belongs underneath.
    const alive = world.aliveUnits();
    const depth = new Map(alive.map((u) => [u.id, this.project(u.pos).y]));
    alive.sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
    for (const u of alive) {
      if (u.aggroTimer > 0) this.drawAggro(u);
      if (u.kind !== 'tower') this.drawHealthBar(u, hoverId, this.hurtEdge(u, dt));
    }
    this.drawFloaters(world);

    ctx.restore();
  }

  // ------------------------------------------------------------ health bars

  /** Sim seconds since the last frame, and hurt chunks dropped for the dead. */
  private tickHurt(world: World): number {
    if (world !== this.hurtWorld) {
      // A new run reuses unit ids, so nothing carries over.
      this.hurt.clear();
      this.hurtWorld = world;
      this.hurtClock = world.time;
    }
    const dt = Math.max(0, world.time - this.hurtClock);
    this.hurtClock = world.time;
    for (const id of this.hurt.keys()) {
      if (!world.get(id)?.alive) this.hurt.delete(id);
    }
    return dt;
  }

  /** Where the hurt chunk ends this frame, in HP. */
  private hurtEdge(u: Unit, dt: number): number {
    let s = this.hurt.get(u.id);
    if (!s) {
      s = { hp: u.hp, last: u.hp, hold: 0 };
      this.hurt.set(u.id, s);
    }
    if (u.hp < s.last) s.hold = HURT_HOLD;
    s.last = u.hp;
    if (u.hp >= s.hp) {
      // Healed or regenerated past it: nothing lost is left to show.
      s.hp = u.hp;
    } else if (s.hold > 0) {
      s.hold -= dt;
    } else {
      s.hp = u.hp + (s.hp - u.hp) * Math.exp(-dt / HURT_TAU);
      // An exponential never arrives; under a tenth of a pixel it has.
      if ((s.hp - u.hp) / u.maxHp < 0.003) s.hp = u.hp;
    }
    return s.hp;
  }

  private drawHealthBar(u: Unit, hoverId: number | null, hurtHp: number) {
    const ctx = this.ctx;
    const head = this.project(u.pos, healthBarHeight(u));
    if (this.behind()) return;

    const hero = u.kind === 'hero';
    const { w, h } = hero ? BAR.hero : BAR.creep;
    // Only the anchor is snapped here; every edge below goes through span(),
    // which snaps it to device pixels on its own.
    const x = this.px(head.x - w / 2);
    const y = this.px(head.y - h);
    const edge = (hp: number) => x + w * clamp(hp / u.maxHp, 0, 1);

    // Nothing but the bar itself: no deny line, no damage preview, no
    // killable frame, no damage in flight. Dota draws none of them, and a
    // drill that leans on them trains you to read the overlay rather than the
    // creep. The frame is also the empty well: what is missing reads as dark,
    // the way Dota's does, and the bar keeps its full length at any health.
    ctx.fillStyle = COLORS.shadow;
    this.span(x - 1, y - 1, x + w + 1, y + h + 1);
    if (hoverId === u.id) {
      ctx.fillStyle = COLORS.hover;
      this.ring(x - 1, y - 1, x + w + 1, y + h + 1, 1);
    }

    const live = edge(u.hp);
    ctx.fillStyle = COLORS.hurt;
    this.span(live, y, edge(hurtHp), y + h);
    ctx.fillStyle = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;
    this.span(x, y, live, y + h);
    // A lit top row, so the fill reads as a bar and not a flat swatch.
    ctx.fillStyle = COLORS.sheen;
    this.span(x, y, live, y + Math.round(h / 4));

    if (hero) {
      for (let i = 1, hp = HP_PER_MARKER; hp < u.maxHp; i++, hp += HP_PER_MARKER) {
        const major = i % MARKERS_PER_MAJOR === 0;
        ctx.fillStyle = major ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.5)';
        const mx = edge(hp);
        this.span(mx - (major ? 1 : 0), y, mx + 1, y + h);
      }
    }

    if (hoverId === u.id) {
      this.label(`${Math.ceil(u.hp)} / ${Math.round(u.maxHp)}`, head.x, y - 7, COLORS.text, 11);
    }
  }

  // ------------------------------------------------------------------- aggro

  /** Forced aggro: these creeps are coming for you. */
  private drawAggro(u: Unit) {
    const ctx = this.ctx;
    const s = this.project(u.pos, 10);
    if (this.behind()) return;
    const r = Math.max(9, u.radius * this.pxPerUnitAt(u.pos) + 7);
    ctx.strokeStyle = '#ff9f43';
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (u.aggroTimer / AGGRO_DURATION));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawFloaters(world: World) {
    for (const f of world.floaters) {
      // Creeps trading blows produce a number per hit per creep. Dota shows
      // none of them, and neither does this: what is worth reading is your own
      // damage, what is landing on you, and gold.
      if (f.kind === 'creep_damage') continue;
      // Climbs in world height, not across the lane, so the text rises off
      // the unit's head.
      const s = this.project(f.pos, 150 + f.rise * f.age);
      if (this.behind()) continue;
      const big = f.kind === 'gold' || f.kind === 'deny';
      this.ctx.globalAlpha = clamp(1 - f.age / f.life, 0, 1);
      this.label(f.text, s.x, s.y, f.color, big ? 16 : 12, big);
    }
    this.ctx.globalAlpha = 1;
  }

  /**
   * Text with a dark outline. Everything here is drawn over a lane that is
   * sometimes pale grass and sometimes a creep, so plain fill text disappears
   * about half the time.
   */
  private label(text: string, x: number, y: number, color: string, size: number, bold = false) {
    const ctx = this.ctx;
    ctx.font = `${bold ? 700 : 600} ${size}px ${bold ? '"Barlow Condensed", ' : ''}Barlow, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.shadow;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}
