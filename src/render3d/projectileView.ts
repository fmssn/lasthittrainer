import * as THREE from 'three';
import type { Projectile, Unit } from '../sim/types.ts';
import { World } from '../sim/world.ts';
import type { Effects } from './effects.ts';

/**
 * Projectiles on the 3D stage.
 *
 * Two things changed from the first pass, both in the direction of the real
 * game. They are no longer spheres: a bolt is drawn as an elongated shape
 * pointed along its own flight, which is what makes a shot read as travelling
 * rather than drifting. And they no longer arc. Dota's attack projectiles fly
 * flat from the attacker to the target, and the tall sine arc that used to be
 * here was inventing airtime on top of the travel time the sim already models
 * — on a 500-unit ranged creep shot that is most of the visual delay you are
 * supposed to be learning to read.
 *
 * Height is still presentational — the sim moves projectiles on the flat plane
 * only — but it is now a straight line from the shooter's shoulder to the
 * target's chest.
 *
 * Reads World, writes nothing.
 */

/** Launch height in sim units — roughly a creep's shoulder. */
const SHOULDER = 78;
/** Impact height: the middle of a body, not its feet. */
const CHEST = 70;

interface Look {
  radius: number;
  length: number;
  color: number;
}

/**
 * Who fired decides how it looks. Hero shots are gold and the largest, tower
 * bolts heavier again, creep shots carry their team colour — so a bolt tells
 * you who is about to take damage before it lands.
 */
function look(p: Projectile, source: Unit | undefined): Look {
  if (source?.kind === 'tower') {
    return { radius: 10, length: 58, color: p.team === 'radiant' ? 0x8affb0 : 0xff9a72 };
  }
  if (p.kind === 'hero') return { radius: 7, length: 46, color: 0xffd479 };
  return { radius: 5, length: 30, color: p.team === 'radiant' ? 0x7fd6a2 : 0xf0a19c };
}

interface Tracked {
  mesh: THREE.Mesh;
  color: number;
  /** Distance to the target when this projectile was first drawn. */
  startDist: number;
  /** Last drawn position, so a vanished bolt can fizzle where it was. */
  last: THREE.Vector3;
  targetId: number;
  /** Seconds since the last trail dot, so the trail is time-based not frame-based. */
  sinceTrail: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export class ProjectileLayer {
  private tracked = new Map<number, Tracked>();
  /** One cone, pointed +Y, stretched per bolt by the mesh scale. */
  private geom = new THREE.ConeGeometry(1, 1, 8);
  private materials = new Map<number, THREE.MeshBasicMaterial>();
  private readonly dir = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();

  constructor(
    private scene: THREE.Scene,
    private effects: Effects,
  ) {}

  private material(color: number) {
    let m = this.materials.get(color);
    if (!m) {
      // Unlit on purpose: a bolt has to stay equally readable whichever side of
      // the lane the sun is on, the same way Dota's do.
      m = new THREE.MeshBasicMaterial({ color });
      this.materials.set(color, m);
    }
    return m;
  }

  sync(world: World, dt: number, rangedHits: Set<number>) {
    const seen = new Set<number>();

    for (const p of world.projectiles) {
      seen.add(p.id);
      const target = world.units.get(p.targetId);
      const dx = target ? target.pos.x - p.pos.x : 0;
      const dz = target ? target.pos.y - p.pos.y : 0;
      const dist = Math.hypot(dx, dz);

      let t = this.tracked.get(p.id);
      if (!t) {
        const l = look(p, world.units.get(p.sourceId));
        const mesh = new THREE.Mesh(this.geom, this.material(l.color));
        mesh.scale.set(l.radius, l.length, l.radius);
        this.scene.add(mesh);
        t = {
          mesh,
          color: l.color,
          startDist: Math.max(dist, 1),
          last: new THREE.Vector3(),
          targetId: p.targetId,
          sinceTrail: 0,
        };
        this.tracked.set(p.id, t);
      }

      const progress = THREE.MathUtils.clamp(1 - dist / t.startDist, 0, 1);
      const y = SHOULDER + (CHEST - SHOULDER) * progress;
      t.mesh.position.set(p.pos.x, y, p.pos.y);
      t.last.copy(t.mesh.position);

      // Point the cone down its own line of travel.
      if (dist > 1e-3) {
        this.dir.set(dx, 0, dz).normalize();
        this.quat.setFromUnitVectors(UP, this.dir);
        t.mesh.quaternion.copy(this.quat);
      }

      t.sinceTrail += dt;
      if (t.sinceTrail >= 0.02) {
        t.sinceTrail = 0;
        this.effects.trail(p.pos.x, y, p.pos.y, t.color);
      }
    }

    for (const [id, t] of this.tracked) {
      if (seen.has(id)) continue;
      // The sim drops a projectile either because it arrived or because its
      // target died first. An arrival logged projectile damage against that
      // target and has already produced its impact; anything else disjointed,
      // and should puff out rather than simply blinking away.
      if (!rangedHits.has(t.targetId)) this.effects.fizzle(t.last.x, t.last.y, t.last.z, t.color);
      t.mesh.removeFromParent();
      this.tracked.delete(id);
    }
  }

  /** Drop every bolt in flight — used when the drill restarts. */
  clear() {
    for (const t of this.tracked.values()) t.mesh.removeFromParent();
    this.tracked.clear();
  }

  dispose() {
    this.clear();
    this.geom.dispose();
    for (const m of this.materials.values()) m.dispose();
  }
}
