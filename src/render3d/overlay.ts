import * as THREE from 'three';
import type { Unit } from '../sim/types.ts';
import { DENY_THRESHOLD } from '../sim/constants.ts';
import { World } from '../sim/world.ts';
import { clamp } from '../sim/math.ts';

/**
 * Screen-space overlay for the 3D slice: health bars and floating text.
 *
 * These are drawn on a 2D canvas stacked over the WebGL canvas rather than as
 * billboarded sprites in the scene. Dota's own bars are screen-space too — they
 * keep a constant pixel size regardless of camera distance, which is exactly
 * what you want when the bar is the thing you are reading for the last hit.
 * A sprite would shrink with the ortho zoom and blur under the tilt.
 *
 * Reads World, writes nothing.
 */

const COLORS = {
  radiant: '#5fbf7a',
  dire: '#d8615a',
  killable: '#ffd479',
  deny: '#7fd6a2',
};

/** Height above the ground, in sim units, that floating text anchors to. */
const FLOATER_HEIGHT = 150;

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private ndc = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable for the overlay canvas');
    this.ctx = ctx;
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Sim (x, y) at world height `h` -> CSS pixels, or null if behind the camera. */
  private project(x: number, h: number, y: number, camera: THREE.Camera) {
    this.ndc.set(x, h, y).project(camera);
    if (this.ndc.z > 1) return null;
    const w = this.canvas.clientWidth || innerWidth;
    const ht = this.canvas.clientHeight || innerHeight;
    return { x: (this.ndc.x * 0.5 + 0.5) * w, y: (-this.ndc.y * 0.5 + 0.5) * ht };
  }

  /**
   * @param topOf world-space height of each unit's head, so the bar clears the
   *              model. The slice scales one rig per kind, so only it knows.
   */
  render(world: World, camera: THREE.Camera, topOf: (u: Unit) => number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.clientWidth || innerWidth, this.canvas.clientHeight || innerHeight);

    for (const u of world.units.values()) {
      if (!u.alive || u.kind === 'tower') continue;
      const s = this.project(u.pos.x, topOf(u), u.pos.y, camera);
      if (s) this.drawHealthBar(world, u, s.x, s.y);
    }

    this.drawFloaters(world, camera);
  }

  private drawHealthBar(world: World, u: Unit, cx: number, cy: number) {
    const ctx = this.ctx;
    const w = u.kind === 'hero' ? 56 : 36;
    const h = u.kind === 'hero' ? 7 : 5;
    const x = cx - w / 2;
    const y = cy - h - 8;
    const frac = clamp(u.hp / u.maxHp, 0, 1);

    // Frame lights up when swinging *now* would land the killing blow — the
    // timing the trainer is teaching, and the reason the bar is here at all.
    const swingNow = u.kind !== 'hero' && world.player.alive && world.shouldSwingNow(world.player, u);
    ctx.fillStyle = swingNow ? COLORS.killable : 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);

    ctx.fillStyle = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;
    ctx.fillRect(x, y, w * frac, h);

    // Damage already in the air, as a lighter chunk at the end of the bar.
    if (u.incomingDamage > 0) {
      const after = clamp((u.hp - u.incomingDamage) / u.maxHp, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x + w * after, y, w * (frac - after), h);
    }

    // The 50% deny line. Drawing it on every creep bar is the whole point.
    if (u.kind !== 'hero') {
      ctx.fillStyle = frac <= DENY_THRESHOLD ? COLORS.deny : 'rgba(255,255,255,0.45)';
      ctx.fillRect(x + w * DENY_THRESHOLD - 1, y - 2, 2, h + 4);
    }

    // What the player's next hit would leave this creep on. The 2D game gates
    // this on the hovered unit; the slice has no cursor, so use the live target.
    if (
      world.config.showDamagePreview &&
      u.kind !== 'hero' &&
      world.player.alive &&
      world.player.attackTargetId === u.id
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
  }

  private drawFloaters(world: World, camera: THREE.Camera) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    for (const f of world.floaters) {
      // The sim drifts floaters along -y, which reads as "up" on the 2D canvas
      // but as "sideways across the lane" here. Undo that drift and spend it on
      // world height instead, so the text climbs off the unit's head in 3D.
      const drift = f.rise * f.age;
      const s = this.project(f.pos.x, FLOATER_HEIGHT + drift, f.pos.y + drift, camera);
      if (!s) continue;
      ctx.globalAlpha = clamp(1 - f.age / f.life, 0, 1);
      ctx.fillStyle = f.color;
      ctx.font = f.text === 'DENY' ? '700 17px system-ui, sans-serif' : '600 14px system-ui, sans-serif';
      ctx.fillText(f.text, s.x, s.y);
    }
    ctx.globalAlpha = 1;
  }
}
