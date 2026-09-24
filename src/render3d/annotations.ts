import * as THREE from 'three';
import type { Unit, Vec2 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { DENY_THRESHOLD, attackPointTime } from '../sim/constants.ts';
import { clamp } from '../sim/math.ts';
import { isPlayerTarget } from '../render/targetAids.ts';

/**
 * The screen-space layer of the 3D renderer.
 *
 * Health bars, the deny line, the damage preview and the windup arc are read
 * at a glance mid-swing, so they must not shrink or tilt with the stage. They
 * are drawn on a 2D canvas over the WebGL one, at positions projected through
 * the same camera — the 3D stage stays the world, this stays the instrument.
 */

const COLORS = {
  radiant: '#5fbf7a',
  dire: '#d8615a',
  killable: '#ffd479',
  deny: '#7fd6a2',
  text: '#e6edf3',
};

/** Where the health bar hangs, in sim units above the feet. */
const HEAD_HEIGHT: Record<string, number> = {
  melee_creep: 112,
  ranged_creep: 100,
  siege_creep: 140,
  hero: 165,
  tower: 300,
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
    private readonly camera: THREE.OrthographicCamera,
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

  /** Pixels per sim unit. Constant across the frame because the camera is orthographic. */
  private get pxPerUnit(): number {
    return this.h / (this.camera.top - this.camera.bottom);
  }

  draw(world: World, hoverId: number | null) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();

    this.drawOrderLine(world);
    // Far units first, so a near health bar wins the overlap.
    const sorted = world.aliveUnits().sort((a, b) => a.pos.y - b.pos.y);
    for (const u of sorted) {
      if (u.phase === 'windup') this.drawWindup(u);
      if (u.kind !== 'tower') this.drawHealthBar(world, u, hoverId);
      if (u.aggroTimer > 0) this.drawAggro(u);
    }
    this.drawPlayerLabel(world);
    this.drawFloaters(world);

    ctx.restore();
  }

  // ------------------------------------------------------------ health bars

  private drawHealthBar(world: World, u: Unit, hoverId: number | null) {
    const ctx = this.ctx;
    const head = this.project(u.pos, HEAD_HEIGHT[u.kind] ?? 110);
    const w = u.kind === 'hero' ? 58 : 38;
    const h = u.kind === 'hero' ? 7 : 5;
    const x = head.x - w / 2;
    const y = head.y - h - 4;
    const frac = clamp(u.hp / u.maxHp, 0, 1);

    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;
    ctx.fillRect(x, y, w * frac, h);

    // Incoming projectile damage, as a lighter chunk at the end of the bar.
    if (u.incomingDamage > 0) {
      const after = clamp((u.hp - u.incomingDamage) / u.maxHp, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x + w * after, y, w * (frac - after), h);
    }

    // The 50% deny line. Drawing it on every bar is the whole point.
    if (u.kind !== 'hero') {
      ctx.fillStyle = frac <= DENY_THRESHOLD ? COLORS.deny : 'rgba(255,255,255,0.45)';
      ctx.fillRect(x + w * DENY_THRESHOLD - 1, y - 2, 2, h + 4);
    }

    // What your next hit would leave it on.
    if (
      world.config.showDamagePreview &&
      u.kind !== 'hero' &&
      world.player.alive &&
      isPlayerTarget(world, u)
    ) {
      const dmg = world.expectedDamage(world.player, u);
      const after = clamp((world.hpAtLanding(world.player, u) - dmg) / u.maxHp, 0, 1);
      ctx.strokeStyle = COLORS.killable;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + w * after, y - 3);
      ctx.lineTo(x + w * after, y + h + 3);
      ctx.stroke();
    }

    if (hoverId === u.id && u.kind !== 'hero') {
      ctx.fillStyle = COLORS.text;
      ctx.font = '600 11px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.ceil(u.hp)} / ${u.maxHp}`, head.x, y - 6);
    }
  }

  // ------------------------------------------------------------------- swing

  /** A shrinking arc showing exactly how much wind-up is left. */
  private drawWindup(u: Unit) {
    const ctx = this.ctx;
    const s = this.project(u.pos);
    const r = Math.max(10, u.radius * this.pxPerUnit + 6);
    const total = attackPointTime(u.attackPoint, u.attackSpeedBonus);
    const p = clamp(1 - u.phaseTimer / total, 0, 1);
    ctx.strokeStyle = u.kind === 'hero' ? COLORS.killable : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    ctx.stroke();
  }

  /** Forced aggro: these creeps are coming for you. */
  private drawAggro(u: Unit) {
    const ctx = this.ctx;
    const s = this.project(u.pos);
    const r = Math.max(8, u.radius * this.pxPerUnit + 2);
    ctx.strokeStyle = '#ff9f43';
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (u.aggroTimer / 2.3));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawPlayerLabel(world: World) {
    if (!world.player.alive) return;
    const s = this.project(world.player.pos, HEAD_HEIGHT.hero + 26);
    this.ctx.fillStyle = COLORS.text;
    this.ctx.font = '600 12px Barlow, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('YOU', s.x, s.y);
  }

  private drawOrderLine(world: World) {
    const target = world.get(world.player.attackTargetId);
    if (!target || !world.player.alive) return;
    const a = this.project(world.player.pos, 40);
    const b = this.project(target.pos, 40);
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,212,121,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawFloaters(world: World) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    for (const f of world.floaters) {
      const s = this.project(f.pos, 150);
      ctx.globalAlpha = clamp(1 - f.age / f.life, 0, 1);
      ctx.fillStyle = f.color;
      ctx.font =
        f.text === 'DENY' ? '700 16px "Barlow Condensed", sans-serif' : '600 13px Barlow, sans-serif';
      ctx.fillText(f.text, s.x, s.y);
    }
    ctx.globalAlpha = 1;
  }
}
