import * as THREE from 'three';
import type { Unit, Vec2 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { Scene3D } from './scene.ts';
import type { Assets } from './assets.ts';
import { SpriteView } from './spriteView.ts';
import { HEROES } from '../sim/heroes.ts';
import { pickRadius, rigHeight, sheetId, spriteFit } from './appearance.ts';
import { Annotations } from './annotations.ts';
import { ProjectileLayer } from './projectileView.ts';
import { Effects } from './effects.ts';
import { HoverOutline, OCCLUDER_LAYER } from './outline.ts';

/**
 * The renderer: a three.js stage plus a screen-space overlay.
 *
 * The drawing splits in two. Anything that lives on the ground plane (the
 * selection ring, tower zones) is real geometry, and anything that has to stay
 * screen-sized and legible mid-swing (health bars, floaters) is drawn on a 2D
 * canvas over the stage in {@link Annotations}. The outline round the unit
 * under the cursor is a screen-space pass of its own, {@link HoverOutline}.
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
  view: SpriteView;
  /** Last seen sim state, kept so a unit removed mid-death still falls over. */
  last: Unit;
  /** Seconds since the unit vanished from the sim. */
  ghost: number;
}

/** Units hide the hover outline where they stand in front of it; the lane and scenery do not. */
function occludes(root: THREE.Object3D) {
  root.traverse((o) => o.layers.enable(OCCLUDER_LAYER));
}

export class Renderer3D {
  cursor: Vec2 = { x: 0, y: 0 };
  /** The cursor in canvas pixels, or null while it is off the canvas. */
  pointer: Vec2 | null = null;
  /** The unit under the cursor, picked afresh every frame in {@link draw}. */
  hoverId: number | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly stage: Scene3D;
  private readonly annotations: Annotations;

  private readonly views = new Map<number, Rec>();
  private readonly rings: THREE.Mesh[] = [];
  private ringsUsed = 0;
  private readonly bolts: ProjectileLayer;
  private readonly effects: Effects;
  private readonly outline: HoverOutline;

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
    private readonly assets: Assets,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage3d';
    // Under #game, which stays on top as the pointer surface.
    container.insertBefore(this.canvas, before);

    this.stage = new Scene3D(this.canvas, assets);
    this.annotations = new Annotations(container, before, this.stage.camera);
    this.effects = new Effects(this.stage.scene);
    this.bolts = new ProjectileLayer(this.stage.scene, this.effects);

    this.outline = new HoverOutline(this.stage.renderer);

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
    // feet — a click just short of a rig should grab it.
    return best ?? this.unitAtFeet(this.toWorld(screen), world, forUnit);
  }

  /** Nearest unit whose hull, with a little slack, covers a lane point. */
  private unitAtFeet(point: Vec2, world: World, forUnit: Unit): Unit | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of world.units.values()) {
      if (!u.alive || u.id === forUnit.id) continue;
      const d = Math.hypot(point.x - u.pos.x, point.y - u.pos.y);
      if (d > u.radius + 16) continue;
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Zoom by mouse-wheel notches, positive out. The drill's camera is fixed; this is for the debug page. */
  zoom(notches: number) {
    this.stage.zoom(notches);
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
    this.drawSelection(world);
    for (let i = this.ringsUsed; i < this.rings.length; i++) this.rings[i].visible = false;

    this.bolts.sync(world, dt, this.effects.consume(world));
    this.effects.update(dt);

    // Picked here rather than on mousemove: a still cursor sees creeps walk
    // under it and away, and the camera follows the hero underneath it too.
    this.hoverId = this.pointer ? (this.pickUnit(this.pointer, world, world.player)?.id ?? null) : null;

    this.stage.render();
    this.outline.render(this.stage.scene, this.stage.camera, this.hoverObject());
    this.annotations.draw(world, this.hoverId);
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    this.observer.disconnect();
    this.clearScene();
    this.annotations.dispose();
    this.outline.dispose();
    this.effects.dispose();
    this.bolts.dispose();
    this.stage.dispose();
    this.stage.renderer.dispose();
    this.canvas.remove();
  }

  // ------------------------------------------------------------------- units

  private syncUnit(unit: Unit, dt: number) {
    let rec = this.views.get(unit.id);
    if (!rec) {
      rec = { view: this.makeView(unit), last: unit, ghost: 0 };
      occludes(rec.view.root);
      this.stage.scene.add(rec.view.root);
      this.views.set(unit.id, rec);
    }
    rec.last = unit;
    rec.ghost = 0;
    rec.view.sync(unit, dt);
  }

  /**
   * Every unit is a sprite: a hero's sheet goes by its hero id, everything
   * else's by kind and team, and appearance.ts says how big each is drawn.
   */
  private makeView(unit: Unit): SpriteView {
    const sheet = unit.kind === 'hero' ? this.heroSprites(unit) : this.assets.units[sheetId(unit)];
    if (!sheet) throw new Error(`no sprites loaded for ${sheetId(unit)}`);
    return new SpriteView(sheet, unit.team, this.stage.camera, spriteFit(unit.kind));
  }

  /**
   * A unit carries its hero's display name but not its id, and the sim has no
   * reason to grow a render-only field, so the id is looked up by name. Every
   * hero's sprites are loaded before the renderer exists, so a miss is a bug.
   */
  private heroSprites(unit: Unit) {
    const id = HEROES.find((h) => h.name === unit.name)?.id;
    const sheet = id ? this.assets.units[id] : undefined;
    if (!sheet) throw new Error(`no sprites loaded for hero "${unit.name}"`);
    return sheet;
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
  }

  private hoverObject(): THREE.Object3D | null {
    if (this.hoverId === null) return null;
    return this.views.get(this.hoverId)?.view.root ?? null;
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
   * one. Drawn flat they are circles that cross the whole screen and read as
   * leftover debug geometry; what you actually want to know is when the edge
   * is near enough to matter. The ring is the tower's reach against your
   * hero's centre: its 700 plus both hulls, 868 in all.
   */
  private drawTowerZones(world: World) {
    for (const u of world.units.values()) {
      if (u.kind !== 'tower' || !u.alive) continue;
      const reach = u.attackRange + u.radius + world.player.radius;
      const d = Math.hypot(world.player.pos.x - u.pos.x, world.player.pos.y - u.pos.y);
      // Off entirely until the edge is within walking distance. A circle this
      // size spans the whole screen at this zoom, so one that is always on is
      // just a line through the middle of the lane.
      if (d > reach + 600) continue;
      this.ring(u.pos, reach, u.team === 'radiant' ? 0x5fbf7a : 0xd8615a, 0.2);
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
    for (const r of this.rings) r.visible = false;
    this.bolts.clear();
    this.effects.clear();
  }

  /**
   * Where a sim point lands on screen, in CSS pixels. The inverse of
   * {@link toWorld}, and the only way anything outside the renderer can aim at
   * a unit — which is what lets the harness click on one.
   */
  toScreen(p: Vec2, up = 0): Vec2 {
    const v = new THREE.Vector3(p.x, up, p.y).project(this.stage.camera);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }

  /**
   * Debug only: what the last frame cost. Triangle and draw-call counts are the
   * only performance numbers worth trusting from this project's own harness —
   * it renders through SwiftShader, so frame times here say nothing about a
   * real GPU.
   */
  stats() {
    const info = this.stage.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      rigs: this.views.size,
    };
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
