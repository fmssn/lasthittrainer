import * as THREE from 'three';
import type { Unit, Vec2 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { Scene3D } from './scene.ts';
import { UnitView, type CreepAsset } from './unitView.ts';
import {
  KIND_SCALE,
  KIND_SHIFT,
  TEAM_TINT,
  TOWER_VISUAL_RADIUS,
  pickRadius,
  rigHeight,
} from './appearance.ts';
import { Annotations } from './annotations.ts';
import { ProjectileLayer } from './projectileView.ts';
import { Effects } from './effects.ts';
import { isPlayerTarget } from './targetAids.ts';

/**
 * The renderer: a three.js stage plus a screen-space overlay.
 *
 * The drawing splits in two. Anything that lives on the ground plane (range
 * rings, tower zones, the killable pulse) is real geometry, and anything that
 * has to stay screen-sized and legible mid-swing (health bars, floaters, the
 * windup arc) is drawn on a 2D canvas over the stage in {@link Annotations}.
 *
 * Screen points are CSS pixels relative to the canvas; world points are sim
 * units. `#game` stays transparent on top as the pointer surface, with the
 * stage canvases inserted underneath it, so input never changes hands.
 * The sim is untouched by all of it.
 */

/** Ring line thickness in sim units — constant, so far rings stay visible. */
const RING_WIDTH = 7;

/** Slack added to a unit's drawn half-width when picking. */
const PICK_PAD = 8;

/**
 * Distance along `ray` at which it enters an upright cylinder standing on the
 * lane, or null if it misses. Slab method: the side wall gives one t-interval
 * and the y range another, and a hit is where the two overlap.
 */
function rayCylinder(ray: THREE.Ray, cx: number, cz: number, r: number, h: number): number | null {
  const ox = ray.origin.x - cx;
  const oz = ray.origin.z - cz;
  const dx = ray.direction.x;
  const dz = ray.direction.z;

  let tSide0 = -Infinity;
  let tSide1 = Infinity;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    tSide0 = (-b - root) / (2 * a);
    tSide1 = (-b + root) / (2 * a);
  } else if (ox * ox + oz * oz > r * r) {
    // Ray runs straight down the cylinder's axis and starts outside it.
    return null;
  }

  let tY0 = -Infinity;
  let tY1 = Infinity;
  const dy = ray.direction.y;
  const oy = ray.origin.y;
  if (Math.abs(dy) > 1e-9) {
    tY0 = -oy / dy;
    tY1 = (h - oy) / dy;
    if (tY0 > tY1) [tY0, tY1] = [tY1, tY0];
  } else if (oy < 0 || oy > h) {
    return null;
  }

  const enter = Math.max(tSide0, tY0);
  const exit = Math.min(tSide1, tY1);
  if (enter > exit || exit < 0) return null;
  return Math.max(enter, 0);
}

interface Rec {
  view: UnitView;
  /** Last seen sim state, kept so a unit removed mid-death still falls over. */
  last: Unit;
  /** Seconds since the unit vanished from the sim. */
  ghost: number;
}

function tintFor(unit: Unit): number {
  const base = new THREE.Color(TEAM_TINT[unit.team]);
  const k = KIND_SHIFT[unit.kind] ?? 1;
  return base.multiplyScalar(k).getHex();
}

export class Renderer3D {
  cursor: Vec2 = { x: 0, y: 0 };
  hoverId: number | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly stage: Scene3D;
  private readonly annotations: Annotations;

  private readonly views = new Map<number, Rec>();
  private readonly towers = new Map<number, THREE.Object3D>();
  private readonly rings: THREE.Mesh[] = [];
  private ringsUsed = 0;
  private readonly bolts: ProjectileLayer;
  private readonly effects: Effects;
  private readonly cursorRing: THREE.Mesh;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();

  /** The world drawn last frame, so a restarted drill clears stale rigs. */
  private drawn: World | null = null;

  private readonly onResize = () => this.resize();
  private readonly observer: ResizeObserver;

  constructor(
    container: HTMLElement,
    before: HTMLElement,
    private readonly asset: CreepAsset,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage3d';
    // Under the 2D canvas, which stays on top as the pointer surface.
    container.insertBefore(this.canvas, before);

    this.stage = new Scene3D(this.canvas);
    this.annotations = new Annotations(container, before, this.stage.camera);
    this.effects = new Effects(this.stage.scene);
    this.bolts = new ProjectileLayer(this.stage.scene, this.effects);

    this.cursorRing = this.makeRing(26, 0xffffff, 0.35);
    this.stage.scene.add(this.cursorRing);

    window.addEventListener('resize', this.onResize);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas);
    this.resize();
  }

  // ------------------------------------------------------------------ camera

  snap(target: Vec2) {
    this.stage.snap(target.x, target.y);
  }

  follow(target: Vec2, dt: number, lead = 0) {
    // The lane runs along sim x, so the lead is a straight offset on that axis.
    this.stage.follow(target.x + lead, target.y, dt);
  }

  toWorld(screen: Vec2): Vec2 {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.raycaster.setFromCamera(
      new THREE.Vector2((screen.x / w) * 2 - 1, -(screen.y / h) * 2 + 1),
      this.stage.camera,
    );
    // The lane is the y=0 plane, so every click resolves to exactly one point.
    const p = this.raycaster.ray.intersectPlane(this.ground, this.hit);
    return p ? { x: p.x, y: p.z } : { ...this.cursor };
  }

  /**
   * Nearest unit whose drawn volume the cursor ray crosses.
   *
   * The ground-plane answer from {@link toWorld} is no use on its own here: a
   * rig stands ~100 sim units tall, so aiming at its chest resolves to a lane
   * point tens of units behind its feet — past the pick radius, and the click
   * reads as a move order. Testing an upright cylinder per unit makes the whole
   * visible body clickable, which is what the cursor looks like it is over.
   */
  pickUnit(screen: Vec2, world: World, forUnit: Unit): Unit | null {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.raycaster.setFromCamera(
      new THREE.Vector2((screen.x / w) * 2 - 1, -(screen.y / h) * 2 + 1),
      this.stage.camera,
    );

    let best: Unit | null = null;
    let bestT = Infinity;
    for (const unit of world.units.values()) {
      if (!unit.alive || unit.id === forUnit.id) continue;
      const t = rayCylinder(
        this.raycaster.ray,
        unit.pos.x,
        unit.pos.y,
        pickRadius(unit) + PICK_PAD,
        rigHeight(unit),
      );
      if (t !== null && t < bestT) {
        bestT = t;
        best = unit;
      }
    }
    // Nothing under the cursor still means the lane point may sit on a unit's
    // feet — a click just short of a rig should grab it, as in the 2D view.
    return best ?? world.unitAt(this.toWorld(screen), forUnit);
  }

  zoom(delta: number) {
    // The 2D camera's positive delta means "closer"; the ortho frustum shrinks.
    this.stage.zoom(-delta);
  }

  draw(world: World, dt: number) {
    if (world !== this.drawn) {
      this.clearScene();
      this.drawn = world;
    }

    const seen = new Set<number>();
    for (const unit of world.units.values()) {
      seen.add(unit.id);
      this.syncUnit(unit, dt);
    }
    this.reapGhosts(seen, dt);

    this.ringsUsed = 0;
    this.drawTowerZones(world);
    if (world.config.showRangeRings && world.player.alive) {
      this.ring(world.player.pos, world.player.attackRange, 0xffd479, 0.14);
    }
    this.drawSelection(world);
    this.drawKillable(world);
    for (let i = this.ringsUsed; i < this.rings.length; i++) this.rings[i].visible = false;

    this.cursorRing.position.set(this.cursor.x, 2, this.cursor.y);
    this.bolts.sync(world, dt, this.effects.consume(world));
    this.effects.update(dt);

    this.stage.render();
    this.annotations.draw(world, this.hoverId);
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    this.observer.disconnect();
    this.clearScene();
    this.annotations.dispose();
    this.effects.dispose();
    this.bolts.dispose();
    this.stage.renderer.dispose();
    this.canvas.remove();
  }

  // ------------------------------------------------------------------- units

  private syncUnit(unit: Unit, dt: number) {
    if (unit.kind === 'tower') {
      let mesh = this.towers.get(unit.id);
      if (!mesh) {
        mesh = towerMesh(unit);
        this.towers.set(unit.id, mesh);
        this.stage.scene.add(mesh);
      }
      mesh.position.set(unit.pos.x, 0, unit.pos.y);
      mesh.visible = unit.alive;
      return;
    }

    let rec = this.views.get(unit.id);
    if (!rec) {
      const view = new UnitView(unit, this.asset, tintFor(unit));
      view.root.scale.multiplyScalar(KIND_SCALE[unit.kind] ?? 1);
      this.stage.scene.add(view.root);
      rec = { view, last: unit, ghost: 0 };
      this.views.set(unit.id, rec);
    }
    rec.last = unit;
    rec.ghost = 0;
    rec.view.sync(unit, dt);
  }

  /** Units the sim has forgotten: hold the corpse long enough to read the fall. */
  private reapGhosts(seen: Set<number>, dt: number) {
    for (const [id, rec] of this.views) {
      if (seen.has(id)) continue;
      rec.ghost += dt;
      rec.view.sync({ ...rec.last, alive: false }, dt);
      if (rec.ghost > 4) {
        rec.view.dispose();
        this.views.delete(id);
      }
    }
    for (const [id, mesh] of this.towers) {
      if (seen.has(id)) continue;
      mesh.removeFromParent();
      this.towers.delete(id);
    }
  }

  // ------------------------------------------------------------ ground rings

  private makeRing(radius: number, color: number, opacity: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(1, radius - RING_WIDTH), radius, 72),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 2; // just clear of the lane decal
    mesh.userData.radius = radius;
    return mesh;
  }

  /** Borrow a ring from the pool. Geometry is only rebuilt when a radius changes. */
  private ring(pos: Vec2, radius: number, color: number, opacity: number) {
    let mesh = this.rings[this.ringsUsed];
    if (!mesh) {
      mesh = this.makeRing(radius, color, opacity);
      this.rings.push(mesh);
      this.stage.scene.add(mesh);
    }
    if (mesh.userData.radius !== radius) {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.RingGeometry(Math.max(1, radius - RING_WIDTH), radius, 72);
      mesh.userData.radius = radius;
    }
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.color.setHex(color);
    mat.opacity = opacity;
    mesh.position.set(pos.x, 2, pos.y);
    mesh.visible = true;
    this.ringsUsed++;
  }

  /**
   * Tower threat rings, faded in by how close the player is to walking into
   * one. Drawn flat they are 700-unit circles that cross the whole screen and
   * read as leftover debug geometry; what you actually want to know is when
   * the edge is near enough to matter.
   */
  private drawTowerZones(world: World) {
    for (const u of world.units.values()) {
      if (u.kind !== 'tower' || !u.alive) continue;
      const d = Math.hypot(world.player.pos.x - u.pos.x, world.player.pos.y - u.pos.y);
      // Off entirely until the edge is within walking distance. A 700-unit
      // circle spans the whole screen at this zoom, so one that is always on is
      // just a line through the middle of the lane.
      if (d > u.attackRange + 600) continue;
      this.ring(u.pos, u.attackRange, u.team === 'radiant' ? 0x5fbf7a : 0xd8615a, 0.2);
    }
  }

  /**
   * A pulse at the feet of anything you could kill with a swing started now.
   * The gold frame {@link Annotations} puts on the health bar is the primary
   * cue; this is the peripheral one, for creeps you are not looking straight at.
   */
  private drawKillable(world: World) {
    if (!world.config.showKillableHighlight || !world.player.alive) return;
    const pulse = 0.45 + 0.35 * Math.sin(world.time * 12);
    for (const u of world.aliveUnits()) {
      if (u.kind === 'hero' || u.kind === 'tower') continue;
      if (!isPlayerTarget(world, u)) continue;
      if (!world.shouldSwingNow(world.player, u)) continue;
      this.ring(u.pos, pickRadius(u) + 10, u.team === 'radiant' ? 0x7fd6a2 : 0xffd479, pulse);
    }
  }

  /** The ring under your own hero, so you never lose it in a wave. */
  private drawSelection(world: World) {
    if (!world.player.alive) return;
    this.ring(world.player.pos, pickRadius(world.player) + 8, 0xdfe9f2, 0.75);
  }

  // ------------------------------------------------------------------- misc

  private clearScene() {
    for (const rec of this.views.values()) rec.view.dispose();
    this.views.clear();
    for (const mesh of this.towers.values()) mesh.removeFromParent();
    this.towers.clear();
    for (const r of this.rings) r.visible = false;
    this.bolts.clear();
    this.effects.clear();
  }

  /** Debug only: how many rigs are playing each clip. Drives the slice readout. */
  clipHistogram(): Record<string, number> {
    const hist: Record<string, number> = {};
    for (const rec of this.views.values()) hist[rec.view.clip] = (hist[rec.view.clip] ?? 0) + 1;
    return hist;
  }

  /** Debug only: free-look camera, for inspecting the rigs from any angle. */
  toggleOrbit(on: boolean) {
    this.stage.toggleOrbit(on);
  }

  get rigCount(): number {
    return this.views.size;
  }

  private resize() {
    this.stage.resize();
    this.annotations.resize();
  }
}

/**
 * A tier 1 tower: tapered stone shaft, a wider crown, and a lit brazier on top.
 * Built from the drawn radius rather than the collision hull, which at 144 is
 * more than twice as wide as a tower looks.
 */
function towerMesh(unit: Unit): THREE.Object3D {
  const g = new THREE.Group();
  const radiant = unit.team === 'radiant';
  const stone = new THREE.MeshStandardMaterial({
    color: radiant ? 0x6d7360 : 0x6b585a,
    roughness: 0.95,
  });
  const r = TOWER_VISUAL_RADIUS;

  const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 1.25, 60, 8), stone);
  base.position.y = 30;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.92, 170, 8), stone);
  shaft.position.y = 145;
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.66, 34, 8), stone);
  crown.position.y = 245;
  for (const m of [base, shaft, crown]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }

  // The brazier reads the team colour from much further away than the stone
  // does, and gives the tower a silhouette that is not just a cylinder.
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.34, 12, 10),
    new THREE.MeshStandardMaterial({
      color: radiant ? 0x9ff0b4 : 0xff9a7a,
      emissive: radiant ? 0x3fbf6a : 0xd8492f,
      emissiveIntensity: 1.4,
      roughness: 0.4,
    }),
  );
  glow.position.y = 272;
  g.add(glow);
  return g;
}
