import * as THREE from 'three';
import type { Unit, Vec2 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { AGGRO_DURATION, DENY_THRESHOLD, attackPointTime } from '../sim/constants.ts';
import { clamp } from '../sim/math.ts';
import { isPlayerTarget } from './targetAids.ts';
import { healthBarHeight } from './appearance.ts';

/**
 * The screen-space layer of the 3D renderer.
 *
 * Health bars, the deny line, the damage preview and the windup arc are read at
 * a glance mid-swing, so they must not shrink or tilt with the stage. They are
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
  killable: '#ffd479',
  deny: '#7fd6a2',
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

    this.drawOrderLine(world);
    // Far units first, so a near health bar wins the overlap.
    const sorted = world.aliveUnits().sort((a, b) => a.pos.y - b.pos.y);
    for (const u of sorted) {
      if (u.phase === 'windup') this.drawWindup(world, u);
      if (u.aggroTimer > 0) this.drawAggro(u);
      if (u.kind !== 'tower') this.drawHealthBar(world, u, hoverId);
    }
    this.drawFloaters(world);

    ctx.restore();
  }

  // ------------------------------------------------------------ health bars

  private drawHealthBar(world: World, u: Unit, hoverId: number | null) {
    const ctx = this.ctx;
    const head = this.project(u.pos, healthBarHeight(u));
    if (this.behind()) return;

    const hero = u.kind === 'hero';
    const { w, h } = hero ? BAR.hero : BAR.creep;
    const x = Math.round(head.x - w / 2);
    const y = Math.round(head.y - h);
    const frac = clamp(u.hp / u.maxHp, 0, 1);

    // A creep you could kill right now gets a gold frame. This is the single
    // most useful thing on screen while last hitting, so it is a property of
    // the bar rather than something to hunt for on the ground.
    const killable =
      world.config.showKillableHighlight &&
      !hero &&
      world.player.alive &&
      isPlayerTarget(world, u) &&
      world.shouldSwingNow(world.player, u);

    ctx.fillStyle = COLORS.shadow;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;
    ctx.fillRect(x, y, Math.round(w * frac), h);

    // Damage already in the air, as a pale chunk at the leading edge: what the
    // bar will read once everything in flight lands.
    if (u.incomingDamage > 0) {
      const after = clamp((u.hp - u.incomingDamage) / u.maxHp, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x + w * after, y, Math.max(1, w * (frac - after)), h);
    }

    if (!hero) {
      // The 50% deny line, on every creep bar. Drawing it always is the point:
      // the threshold has to become something you see rather than compute.
      const dx = Math.round(x + w * DENY_THRESHOLD);
      ctx.fillStyle = frac <= DENY_THRESHOLD ? COLORS.deny : 'rgba(255,255,255,0.5)';
      ctx.fillRect(dx, y - 2, 1, h + 4);
    }

    // Where your next hit would leave it, as a notch on the bar.
    if (world.config.showDamagePreview && !hero && world.player.alive && isPlayerTarget(world, u)) {
      const dmg = world.expectedDamage(world.player, u);
      const after = clamp((world.hpAtLanding(world.player, u) - dmg) / u.maxHp, 0, 1);
      ctx.fillStyle = COLORS.killable;
      ctx.fillRect(Math.round(x + w * after) - 1, y - 3, 2, h + 6);
    }

    if (killable) {
      ctx.strokeStyle = COLORS.killable;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2.5, y - 2.5, w + 5, h + 5);
    }

    if (hoverId === u.id) {
      this.label(`${Math.ceil(u.hp)} / ${Math.round(u.maxHp)}`, head.x, y - 7, COLORS.text, 11);
    }
  }

  // ------------------------------------------------------------------- swing

  /**
   * A shrinking arc showing exactly how much wind-up is left.
   *
   * The player's own swing is drawn bright and thick because it is the thing
   * being trained; everyone else's is faint, so a wave mid-fight does not turn
   * into a screen full of rings.
   */
  private drawWindup(world: World, u: Unit) {
    const ctx = this.ctx;
    const s = this.project(u.pos, 10);
    if (this.behind()) return;
    const mine = u.id === world.player.id;
    const r = Math.max(10, u.radius * this.pxPerUnitAt(u.pos) + (mine ? 16 : 10));
    const total = attackPointTime(u.attackPoint, u.attackSpeedBonus);
    const p = clamp(1 - u.phaseTimer / total, 0, 1);
    ctx.strokeStyle = mine ? COLORS.killable : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = mine ? 3 : 1.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    ctx.stroke();
  }

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

  private drawOrderLine(world: World) {
    const target = world.get(world.player.attackTargetId);
    if (!target || !world.player.alive) return;
    const a = this.project(world.player.pos, 40);
    const b = this.project(target.pos, 40);
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,212,121,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
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
