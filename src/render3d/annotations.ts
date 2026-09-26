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
};

/** Bar geometry in screen pixels, per unit class. */
const BAR = {
  creep: { w: 36, h: 5 },
  hero: { w: 62, h: 8 },
};

export class Annotations {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly v = new THREE.Vector3();
  private w = 0;
  private h = 0;

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
    this.w = this.canvas.clientWidth || window.innerWidth;
    this.h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    // Far units first, so a near health bar wins the overlap.
    const sorted = world.aliveUnits().sort((a, b) => a.pos.y - b.pos.y);
    for (const u of sorted) {
      if (u.aggroTimer > 0) this.drawAggro(u);
      if (u.kind !== 'tower') this.drawHealthBar(u, hoverId);
    }
    this.drawFloaters(world);

    ctx.restore();
  }

  // ------------------------------------------------------------ health bars

  private drawHealthBar(u: Unit, hoverId: number | null) {
    const ctx = this.ctx;
    const head = this.project(u.pos, healthBarHeight(u));
    if (this.behind()) return;

    const hero = u.kind === 'hero';
    const { w, h } = hero ? BAR.hero : BAR.creep;
    const x = Math.round(head.x - w / 2);
    const y = Math.round(head.y - h);
    const frac = clamp(u.hp / u.maxHp, 0, 1);

    // Nothing but the bar itself: no deny line, no damage preview, no
    // killable frame. Dota draws none of them, and a drill that leans on them
    // trains you to read the overlay rather than the creep.
    ctx.fillStyle = COLORS.shadow;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;
    ctx.fillRect(x, y, Math.round(w * frac), h);

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
      // The sim drifts floaters along -y, which reads as "up" on a 2D canvas
      // but as "sideways across the lane" here. Undo that drift and spend it on
      // world height instead, so the text climbs off the unit's head in 3D.
      const drift = f.rise * f.age;
      const s = this.project({ x: f.pos.x, y: f.pos.y + drift }, 150 + drift);
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
