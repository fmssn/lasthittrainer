import * as THREE from 'three';
import type { Projectile } from '../sim/types.ts';
import { World } from '../sim/world.ts';

/**
 * Projectiles on the 3D stage.
 *
 * The sim moves projectiles on the flat plane only (`p.pos`), so the height is
 * purely presentational: a shallow arc that launches at shoulder height and
 * lands on the target. Progress comes from how far the bolt has left to go
 * against the distance it had when first seen, so nothing needs to be stored
 * in the sim.
 *
 * Reads World, writes nothing.
 */

/** Launch/impact height in sim units — roughly a creep's shoulder. */
const SHOULDER = 78;
/** Peak lift above the straight line, at mid-flight. */
const ARC = 90;

/**
 * Same split the 2D renderer uses: hero shots are gold, creep shots carry their
 * team colour, so a bolt tells you who is about to take damage before it lands.
 */
function look(p: Projectile): { radius: number; color: number } {
  if (p.kind === 'hero') return { radius: 17, color: 0xffd479 };
  return { radius: 12, color: p.team === 'radiant' ? 0x7fd6a2 : 0xf0a19c };
}

interface Tracked {
  mesh: THREE.Mesh;
  /** Distance to the target when this projectile was first drawn. */
  startDist: number;
}

export class ProjectileLayer {
  private tracked = new Map<number, Tracked>();
  private geom = new THREE.SphereGeometry(1, 10, 8);
  private materials = new Map<number, THREE.MeshStandardMaterial>();

  constructor(private scene: THREE.Scene) {}

  private material(color: number) {
    let m = this.materials.get(color);
    if (!m) {
      // Emissive so the bolt stays readable against the dark ground even when
      // the sun is on the far side of the lane — but kept low, because at full
      // strength every bolt clips to white and the team colour is lost.
      m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.4 });
      this.materials.set(color, m);
    }
    return m;
  }

  sync(world: World) {
    const seen = new Set<number>();

    for (const p of world.projectiles) {
      seen.add(p.id);
      const target = world.units.get(p.targetId);
      const dx = target ? target.pos.x - p.pos.x : 0;
      const dz = target ? target.pos.y - p.pos.y : 0;
      const dist = Math.hypot(dx, dz);

      let t = this.tracked.get(p.id);
      if (!t) {
        const { radius, color } = look(p);
        const mesh = new THREE.Mesh(this.geom, this.material(color));
        mesh.scale.setScalar(radius);
        mesh.castShadow = true;
        this.scene.add(mesh);
        t = { mesh, startDist: Math.max(dist, 1) };
        this.tracked.set(p.id, t);
      }

      const progress = THREE.MathUtils.clamp(1 - dist / t.startDist, 0, 1);
      // sin() peaks at mid-flight and is zero at both ends, so the bolt leaves
      // and arrives at shoulder height however long the shot is.
      t.mesh.position.set(p.pos.x, SHOULDER + Math.sin(Math.PI * progress) * ARC, p.pos.y);
    }

    for (const [id, t] of this.tracked) {
      if (seen.has(id)) continue;
      t.mesh.removeFromParent();
      this.tracked.delete(id);
    }
  }

  dispose() {
    for (const t of this.tracked.values()) t.mesh.removeFromParent();
    this.tracked.clear();
    this.geom.dispose();
    for (const m of this.materials.values()) m.dispose();
  }
}
