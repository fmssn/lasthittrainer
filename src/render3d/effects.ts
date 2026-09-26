import * as THREE from 'three';
import type { DamageEvent } from '../sim/types.ts';
import type { World } from '../sim/world.ts';

/**
 * Hit feedback: the flash and sparks that say an attack connected.
 *
 * Every attack in this drill used to land in total silence — the health bar
 * moved and nothing else did, which makes a swing feel like it was scored
 * rather than thrown. The sim now logs landed attacks, and this reads that log
 * and puts something at the point of contact.
 *
 * Everything is a pooled {@link THREE.Sprite} over one shared soft-dot texture,
 * blended additively. Sprites always face the camera, which is what you want
 * for a spark, and additive blending gives the glow without a bloom pass to pay
 * for. The pool is fixed: a lane at full tilt lands a few hits a second and
 * nothing here should ever allocate mid-frame.
 */

const POOL_SIZE = 220;

interface Particle {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  /** Sim units per second, y being up. */
  vel: THREE.Vector3;
  gravity: number;
  size0: number;
  size1: number;
  alpha0: number;
}

/** A soft round dot, built once. Sharp-edged quads read as squares up close. */
function dotTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  private readonly pool: Particle[] = [];
  private readonly free: Particle[] = [];
  private readonly texture = dotTexture();
  /** Highest damage-event seq already turned into an effect. */
  private seen = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.texture,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sprite.visible = false;
      scene.add(sprite);
      const p: Particle = {
        sprite,
        age: 0,
        life: 0,
        vel: new THREE.Vector3(),
        gravity: 0,
        size0: 1,
        size1: 1,
        alpha0: 1,
      };
      this.pool.push(p);
      this.free.push(p);
    }
  }

  /**
   * Take a particle from the pool. Returns null when the pool is dry rather
   * than growing it — dropping a spark in a busy frame is invisible, and a
   * renderer that allocates under load is not.
   */
  private take(): Particle | null {
    return this.free.pop() ?? null;
  }

  private emit(
    x: number,
    y: number,
    z: number,
    color: number,
    size0: number,
    size1: number,
    life: number,
    vel: THREE.Vector3,
    gravity = 0,
    alpha = 1,
  ) {
    const p = this.take();
    if (!p) return;
    p.age = 0;
    p.life = life;
    p.vel.copy(vel);
    p.gravity = gravity;
    p.size0 = size0;
    p.size1 = size1;
    p.alpha0 = alpha;
    p.sprite.position.set(x, y, z);
    p.sprite.scale.setScalar(size0);
    (p.sprite.material as THREE.SpriteMaterial).color.setHex(color);
    (p.sprite.material as THREE.SpriteMaterial).opacity = alpha;
    p.sprite.visible = true;
  }

  /** A short fading dot dropped behind a projectile. */
  trail(x: number, y: number, z: number, color: number) {
    this.emit(x, y, z, color, 16, 3, 0.22, ZERO, 0, 0.5);
  }

  /** A projectile whose target died before it arrived: it fizzles out. */
  fizzle(x: number, y: number, z: number, color: number) {
    this.emit(x, y, z, color, 22, 46, 0.3, ZERO, 0, 0.35);
  }

  /**
   * Read everything the sim has landed since the last frame, and report which
   * units took *projectile* damage in it. The projectile layer needs that to
   * tell a bolt that arrived from one whose target died out from under it:
   * both vanish from `world.projectiles`, but only the second should puff out.
   */
  consume(world: World): Set<number> {
    const rangedHits = new Set<number>();
    for (const e of world.damageLog) {
      if (e.seq <= this.seen) continue;
      this.seen = e.seq;
      if (e.ranged) rangedHits.add(e.targetId);
      this.impact(e);
    }
    // A restarted drill rewinds the log; follow it back rather than going deaf.
    const newest = world.damageLog.length ? world.damageLog[world.damageLog.length - 1].seq : 0;
    if (newest < this.seen) this.seen = newest;
    return rangedHits;
  }

  private impact(e: DamageEvent) {
    const hero = e.sourceKind === 'hero';
    const color = hero ? 0xffd9a0 : e.sourceTeam === 'radiant' ? 0xbdf0c8 : 0xffc0b0;
    // Chest height: a hit registers where the body is, not at the feet.
    const y = 70;

    // The flash scales with the bite the hit took, so a hero's last hit reads
    // heavier than a creep chipping at another creep.
    const weight = Math.min(1.6, 0.6 + e.amount / 60);
    this.emit(e.pos.x, y, e.pos.y, color, 26 * weight, 62 * weight, 0.16, ZERO, 0, 0.85);

    const sparks = e.lethal ? 8 : hero ? 5 : 3;
    for (let i = 0; i < sparks; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 90 + Math.random() * 150;
      this.emit(
        e.pos.x,
        y,
        e.pos.y,
        color,
        9,
        2,
        0.3 + Math.random() * 0.2,
        new THREE.Vector3(Math.cos(a) * speed, 60 + Math.random() * 130, Math.sin(a) * speed),
        -520,
        0.9,
      );
    }
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.sprite.visible) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.sprite.visible = false;
        this.free.push(p);
        continue;
      }
      const t = p.age / p.life;
      if (p.gravity) p.vel.y += p.gravity * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      p.sprite.scale.setScalar(p.size0 + (p.size1 - p.size0) * t);
      (p.sprite.material as THREE.SpriteMaterial).opacity = p.alpha0 * (1 - t);
    }
  }

  /** Drop everything in flight — used when the drill restarts. */
  clear() {
    this.free.length = 0;
    for (const p of this.pool) {
      p.sprite.visible = false;
      this.free.push(p);
    }
    this.seen = 0;
  }

  dispose() {
    for (const p of this.pool) {
      p.sprite.removeFromParent();
      (p.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.texture.dispose();
  }
}

const ZERO = new THREE.Vector3();
