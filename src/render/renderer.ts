import type { Unit, Vec2 } from '../sim/types.ts';
import { DENY_THRESHOLD, LANE_HALF_WIDTH, attackPointTime } from '../sim/constants.ts';
import { DIRE_SPAWN, RADIANT_SPAWN, World } from '../sim/world.ts';
import { Camera } from './camera.ts';
import type { GameRenderer } from './gameRenderer.ts';
import { isPlayerTarget } from './targetAids.ts';
import { clamp } from '../sim/math.ts';

const COLORS = {
  radiant: '#5fbf7a',
  dire: '#d8615a',
  radiantDim: '#2f5f43',
  direDim: '#5f3330',
  ground: '#12181d',
  groundEdge: '#0a0e11',
  lane: '#1d272f',
  grid: '#232f37',
  killable: '#ffd479',
  deny: '#7fd6a2',
  text: '#e6edf3',
  muted: '#7d8d9c',
};

export class Renderer implements GameRenderer {
  camera = new Camera();
  private ctx: CanvasRenderingContext2D;
  /** World-space cursor, updated by input. */
  cursor: Vec2 = { x: 0, y: 0 };
  hoverId: number | null = null;

  private readonly onWindowResize = () => this.resize();
  private readonly observer: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available in this browser');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', this.onWindowResize);
    // The window event alone misses layout changes that do not resize the window.
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
  }

  // ------------------------------------------------------------ GameRenderer

  snap(target: Vec2) {
    this.camera.snap(target);
  }

  follow(target: Vec2, dt: number, lead = 0) {
    this.camera.follow(target, dt, lead);
  }

  toWorld(screen: Vec2): Vec2 {
    return this.camera.toWorld(screen);
  }

  /** Flat view: what the cursor is over is what it resolves to on the lane. */
  pickUnit(screen: Vec2, world: World, forUnit: Unit): Unit | null {
    return world.unitAt(this.camera.toWorld(screen), forUnit);
  }

  zoom(delta: number) {
    this.camera.zoom(delta);
  }

  dispose() {
    window.removeEventListener('resize', this.onWindowResize);
    this.observer.disconnect();
    this.ctx.clearRect(0, 0, this.camera.viewW, this.camera.viewH);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.viewW = w;
    this.camera.viewH = h;
  }

  draw(world: World, _dt = 0) {
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, this.camera.viewW, this.camera.viewH);
    this.drawGround();
    this.drawLane();
    this.drawTowerZones(world);

    if (world.config.showRangeRings && world.player.alive) {
      this.drawRangeRing(world.player);
    }

    for (const u of world.units.values()) {
      if (!u.alive) continue;
      this.drawOrderLine(world, u);
    }
    const sorted = world.aliveUnits().sort((a, b) => a.pos.y - b.pos.y);
    for (const u of sorted) this.drawUnit(world, u);
    for (const u of sorted) this.drawHealthBar(world, u);

    this.drawProjectiles(world);
    this.drawFloaters(world);
    this.drawCursor();
    ctx.restore();
  }

  // ----------------------------------------------------------------- ground

  private drawGround() {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.camera.viewH);
    g.addColorStop(0, COLORS.groundEdge);
    g.addColorStop(0.5, COLORS.ground);
    g.addColorStop(1, COLORS.groundEdge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.camera.viewW, this.camera.viewH);
  }

  private drawLane() {
    const ctx = this.ctx;
    const top = this.camera.toScreen({ x: 0, y: -LANE_HALF_WIDTH });
    const bottom = this.camera.toScreen({ x: 0, y: LANE_HALF_WIDTH });
    const left = this.camera.toScreen({ x: RADIANT_SPAWN - 400, y: 0 });
    const right = this.camera.toScreen({ x: DIRE_SPAWN + 400, y: 0 });

    ctx.fillStyle = COLORS.lane;
    ctx.fillRect(left.x, top.y, right.x - left.x, bottom.y - top.y);

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 250;
    for (let x = RADIANT_SPAWN; x <= DIRE_SPAWN; x += step) {
      const s = this.camera.toScreen({ x, y: 0 });
      if (s.x < -50 || s.x > this.camera.viewW + 50) continue;
      ctx.moveTo(s.x, top.y);
      ctx.lineTo(s.x, bottom.y);
    }
    ctx.stroke();

    // Lane edges.
    ctx.strokeStyle = '#27343d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left.x, top.y);
    ctx.lineTo(right.x, top.y);
    ctx.moveTo(left.x, bottom.y);
    ctx.lineTo(right.x, bottom.y);
    ctx.stroke();
  }

  // ------------------------------------------------------------------ units

  /** Tower range, always visible. Walking into it should be a decision. */
  private drawTowerZones(world: World) {
    const ctx = this.ctx;
    for (const u of world.units.values()) {
      if (u.kind !== 'tower') continue;
      const s = this.camera.toScreen(u.pos);
      ctx.strokeStyle = u.team === 'radiant' ? 'rgba(95,191,122,0.16)' : 'rgba(216,97,90,0.16)';
      ctx.fillStyle = u.team === 'radiant' ? 'rgba(95,191,122,0.04)' : 'rgba(216,97,90,0.04)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, u.attackRange * this.camera.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawUnit(world: World, u: Unit) {
    const ctx = this.ctx;
    if (u.kind === 'tower') {
      this.drawTower(u);
      return;
    }
    const s = this.camera.toScreen(u.pos);
    const r = Math.max(4, u.radius * this.camera.scale);
    const isPlayer = u.id === world.player.id;
    const main = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;

    // Shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + r * 0.35, r * 1.05, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    // Killable highlight — the single most useful training aid on screen.
    if (
      world.config.showKillableHighlight &&
      u.kind !== 'hero' &&
      world.player.alive &&
      isPlayerTarget(world, u) &&
      world.shouldSwingNow(world.player, u)
    ) {
      const pulse = 0.55 + 0.45 * Math.sin(world.time * 12);
      ctx.strokeStyle = u.team === 'radiant' ? COLORS.deny : COLORS.killable;
      ctx.globalAlpha = pulse;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = u.kind === 'hero' ? this.heroColor(world, u) : u.team === 'radiant' ? COLORS.radiantDim : COLORS.direDim;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = main;
    ctx.lineWidth = isPlayer ? 3 : u.kind === 'hero' ? 2.5 : 1.5;
    ctx.stroke();

    // Facing notch.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + Math.cos(u.facing) * r * 1.5, s.y + Math.sin(u.facing) * r * 1.5);
    ctx.stroke();

    if (u.kind === 'ranged_creep' || u.kind === 'siege_creep') {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `${Math.round(r)}px Barlow, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(u.kind === 'siege_creep' ? 'S' : 'R', s.x, s.y + 1);
    }

    // Forced aggro marker: these creeps are coming for you.
    if (u.aggroTimer > 0) {
      ctx.strokeStyle = '#ff9f43';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (u.aggroTimer / 2.3));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (u.phase === 'windup') this.drawWindup(u, s, r);
    if (isPlayer) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '600 12px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', s.x, s.y + r + 26);
    }
  }

  private drawTower(u: Unit) {
    const ctx = this.ctx;
    const s = this.camera.toScreen(u.pos);
    const r = Math.max(8, u.radius * this.camera.scale);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(s.x - r, s.y - r + r * 0.3, r * 2, r * 2);
    ctx.fillStyle = u.team === 'radiant' ? '#24463a' : '#452a2a';
    ctx.strokeStyle = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
    ctx.fill();
    ctx.stroke();
    if (u.phase === 'windup') this.drawWindup(u, s, r * 1.3);
  }

  private heroColor(world: World, u: Unit): string {
    if (u.id === world.player.id) return '#2c4a5e';
    return '#4a2b33';
  }

  /** A shrinking arc showing exactly how much wind-up is left. */
  private drawWindup(u: Unit, s: Vec2, r: number) {
    const ctx = this.ctx;
    const total = attackPointTime(u.attackPoint, u.attackSpeedBonus);
    const p = clamp(1 - u.phaseTimer / total, 0, 1);
    ctx.strokeStyle = u.kind === 'hero' ? '#ffd479' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    ctx.stroke();
  }

  // ------------------------------------------------------------ health bars

  private drawHealthBar(world: World, u: Unit) {
    if (u.kind === 'tower') return;
    const ctx = this.ctx;
    const s = this.camera.toScreen(u.pos);
    const r = Math.max(4, u.radius * this.camera.scale);
    const w = (u.kind === 'hero' ? 56 : 36) * clamp(this.camera.scale / 0.85, 0.75, 1.3);
    const h = u.kind === 'hero' ? 7 : 5;
    const x = s.x - w / 2;
    const y = s.y - r - h - 6;
    const frac = clamp(u.hp / u.maxHp, 0, 1);

    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = u.team === 'radiant' ? COLORS.radiant : COLORS.dire;
    ctx.fillRect(x, y, w * frac, h);

    // Incoming projectile damage, shown as a lighter chunk at the end of the bar.
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
    if (world.config.showDamagePreview && u.kind !== 'hero' && world.player.alive && isPlayerTarget(world, u)) {
      const dmg = world.expectedDamage(world.player, u);
      const after = clamp((world.hpAtLanding(world.player, u) - dmg) / u.maxHp, 0, 1);
      ctx.strokeStyle = COLORS.killable;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + w * after, y - 3);
      ctx.lineTo(x + w * after, y + h + 3);
      ctx.stroke();
    }

    if (this.hoverId === u.id && u.kind !== 'hero') {
      ctx.fillStyle = COLORS.text;
      ctx.font = '600 11px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.ceil(u.hp)} / ${u.maxHp}`, s.x, y - 6);
    }
  }

  // ------------------------------------------------------------ misc layers

  private drawRangeRing(u: Unit) {
    const ctx = this.ctx;
    const s = this.camera.toScreen(u.pos);
    ctx.strokeStyle = 'rgba(255,212,121,0.22)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, u.attackRange * this.camera.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawOrderLine(world: World, u: Unit) {
    if (u.id !== world.player.id) return;
    const target = world.get(u.attackTargetId);
    if (!target) return;
    const a = this.camera.toScreen(u.pos);
    const b = this.camera.toScreen(target.pos);
    this.ctx.strokeStyle = 'rgba(255,212,121,0.3)';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 6]);
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
  }

  private drawProjectiles(world: World) {
    const ctx = this.ctx;
    for (const p of world.projectiles) {
      const s = this.camera.toScreen(p.pos);
      const r = p.kind === 'hero' ? 5 : 3.5;
      ctx.fillStyle = p.kind === 'hero' ? '#ffd479' : p.team === 'radiant' ? '#9fe0b3' : '#f0a19c';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawFloaters(world: World) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    for (const f of world.floaters) {
      const s = this.camera.toScreen(f.pos);
      const alpha = clamp(1 - f.age / f.life, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = f.color;
      ctx.font = f.text === 'DENY' ? '700 16px "Barlow Condensed", sans-serif' : '600 13px Barlow, sans-serif';
      ctx.fillText(f.text, s.x, s.y);
    }
    ctx.globalAlpha = 1;
  }

  private drawCursor() {
    const ctx = this.ctx;
    const s = this.camera.toScreen(this.cursor);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x - 7, s.y);
    ctx.lineTo(s.x + 7, s.y);
    ctx.moveTo(s.x, s.y - 7);
    ctx.lineTo(s.x, s.y + 7);
    ctx.stroke();
  }
}
