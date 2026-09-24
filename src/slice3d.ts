import * as THREE from 'three';
import { World } from './sim/world.ts';
import { DEFAULT_CONFIG } from './sim/config.ts';
import type { Unit } from './sim/types.ts';
import { Scene3D } from './render3d/scene.ts';
import { loadCreep, MODEL_HEIGHT, UnitView, type CreepAsset } from './render3d/unitView.ts';
import { ProjectileLayer } from './render3d/projectileView.ts';
import { Overlay } from './render3d/overlay.ts';

/**
 * 3D vertical slice.
 *
 * Runs the real sim (src/sim/) and renders it with three.js instead of the 2D
 * canvas. Nothing in src/sim/ or src/render/ is touched — this is a second
 * entry point so the 2D game keeps working untouched at /.
 *
 * Open http://localhost:5173/slice3d.html
 */

const SIM_STEP = 1 / 120;
const MAX_CATCHUP = 0.25;

/** Per-kind look. Everything but the tower reuses the one creep rig. */
const TINT: Record<string, number> = {
  melee_creep: 0x6b3a2c,
  ranged_creep: 0x2f5a6b,
  siege_creep: 0x5a4a2c,
  hero: 0x9a2f3c,
};
const SCALE: Record<string, number> = {
  melee_creep: 1,
  ranged_creep: 0.88,
  siege_creep: 1.25,
  hero: 1.45,
};

interface Record3D {
  view: UnitView;
  /** Last seen sim state, kept so a unit removed mid-death still falls over. */
  last: Unit;
  /** Seconds since the unit vanished from the sim. */
  ghost: number;
}

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLDivElement;

const stage = new Scene3D(canvas);
const overlay = new Overlay(overlayCanvas);
const bolts = new ProjectileLayer(stage.scene);
const world = new World({ ...DEFAULT_CONFIG, duration: 99999 });
const views = new Map<number, Record3D>();

// This page is a debug harness, so hand the console the live objects.
Object.assign(globalThis, { world, views, stage, overlay });

addEventListener('resize', () => {
  stage.resize();
  overlay.resize();
});
addEventListener('wheel', (e) => stage.zoom(e.deltaY * 0.0012), { passive: true });

let orbit = false;
addEventListener('keydown', (e) => {
  if (e.key === 'o' || e.key === 'O') {
    orbit = !orbit;
    stage.toggleOrbit(orbit);
  }
});

function towerMesh(unit: Unit): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(unit.radius * 0.9, unit.radius * 1.3, 260, 8),
    new THREE.MeshStandardMaterial({
      color: unit.team === 'radiant' ? 0x4a5d3a : 0x5d3a3a,
      roughness: 0.9,
    }),
  );
  body.position.y = 130;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  return g;
}

function start(asset: CreepAsset) {
  const towers = new Map<number, THREE.Object3D>();

  function syncUnit(unit: Unit, dt: number) {
    if (unit.kind === 'tower') {
      let mesh = towers.get(unit.id);
      if (!mesh) {
        mesh = towerMesh(unit);
        towers.set(unit.id, mesh);
        stage.scene.add(mesh);
      }
      mesh.position.set(unit.pos.x, 0, unit.pos.y);
      mesh.visible = unit.alive;
      return;
    }

    let rec = views.get(unit.id);
    if (!rec) {
      const view = new UnitView(unit, asset, TINT[unit.kind] ?? 0x777777);
      view.root.scale.multiplyScalar(SCALE[unit.kind] ?? 1);
      stage.scene.add(view.root);
      rec = { view, last: unit, ghost: 0 };
      views.set(unit.id, rec);
    }
    rec.last = unit;
    rec.ghost = 0;
    rec.view.sync(unit, dt);
  }

  let last = performance.now();
  let accumulator = 0;
  let fpsAccum = 0;
  let frames = 0;

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, MAX_CATCHUP);
    last = now;

    accumulator += dt;
    while (accumulator >= SIM_STEP) {
      world.step(SIM_STEP);
      accumulator -= SIM_STEP;
    }

    const seen = new Set<number>();
    for (const unit of world.units.values()) {
      seen.add(unit.id);
      syncUnit(unit, dt);
    }

    // Units the sim has already forgotten: keep the corpse around long enough
    // for the death clip to read, then drop it.
    for (const [id, rec] of views) {
      if (seen.has(id)) continue;
      rec.ghost += dt;
      rec.view.sync({ ...rec.last, alive: false }, dt);
      if (rec.ghost > 4) {
        rec.view.dispose();
        views.delete(id);
      }
    }
    for (const [id, mesh] of towers) {
      if (!world.units.has(id)) {
        mesh.removeFromParent();
        towers.delete(id);
      }
    }

    bolts.sync(world);

    stage.follow(world.player.pos.x, world.player.pos.y, dt);
    stage.render();
    // After stage.render(), so the camera matrices the overlay projects with are
    // the ones this frame was actually drawn from.
    overlay.render(world, stage.camera, (u) => MODEL_HEIGHT * (SCALE[u.kind] ?? 1));

    frames++;
    fpsAccum += dt;
    if (fpsAccum >= 0.5) {
      const alive = [...world.units.values()].filter((u) => u.alive).length;
      // Histogram of what each rig is playing: the quickest way to see that all
      // four clips actually fire, rather than assuming the state machine works.
      const hist: Record<string, number> = {};
      for (const r of views.values()) hist[r.view.clip] = (hist[r.view.clip] ?? 0) + 1;
      const clips = (['Idle', 'Walk', 'Attack', 'Death'] as const)
        .map((c) => `${c} ${hist[c] ?? 0}`)
        .join('  ');
      info.textContent =
        `${Math.round(frames / fpsAccum)} fps · ${views.size} rigs · ${alive} alive · ` +
        `t=${world.time.toFixed(0)}s\n${clips}\n` +
        `[O] orbit ${orbit ? 'on' : 'off'} · wheel to zoom`;
      frames = 0;
      fpsAccum = 0;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

loadCreep('/models/melee_creep.glb')
  .then(start)
  .catch((err) => {
    info.textContent = `Failed to load creep: ${err.message}`;
    console.error(err);
  });
