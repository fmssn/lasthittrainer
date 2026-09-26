import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LANE_HALF_WIDTH } from '../sim/constants.ts';

/**
 * The lane, as a place you can judge distance in.
 *
 * The ground used to be two flat planes — a dark one for the world and a lighter
 * one for the lane — which met along a hard diagonal seam and gave the eye
 * nothing to measure against. That is a readability problem, not a decorative
 * one: last hitting is a game of "am I in range", and a featureless field makes
 * a creep 200 units away look exactly like one 500 units away.
 *
 * So: a noisy ground texture with the lane path baked into it (no seam, soft
 * edges), rock ridges standing along both sides of the corridor, and a treeline
 * behind them. The ridges do double duty — they explain the invisible wall the
 * sim clamps movement to at LANE_HALF_WIDTH, which until now just stopped units
 * dead in open grass.
 *
 * The playable corridor itself stays perfectly flat at y = 0. Every piece of
 * relief here lives outside it, so the ground-plane raycast that turns a click
 * into a lane point, the upright cylinders used for picking, and the ring
 * geometry all keep working untouched.
 */

/** How far out the rock ridges stand from the lane centre. */
const CLIFF_OFFSET = LANE_HALF_WIDTH + 55;
/** Lane runs along +x from before the Radiant spawn to past the Dire one. */
const LANE_FROM = -600;
const LANE_TO = 6600;

/** Small deterministic PRNG, so the lane is laid out the same way every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ground: mottled earth, seamless on both axes.
 *
 * Wrapped in x and y so the tile can repeat in both directions at roughly
 * square world scale. Stretching one 512px tile across 8000 units of depth and
 * 2200 of length, which is what a single non-repeating tile did, turns every
 * blob into a long ellipse and the whole field reads as horizontal banding.
 */
function groundTexture(): THREE.Texture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const r = rng(0x5eed);

  ctx.fillStyle = '#26301f';
  ctx.fillRect(0, 0, S, S);

  // Drawn at all nine wrap offsets so the tile joins itself on every edge.
  const blob = (x: number, y: number, rad: number, fill: string) => {
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
        g.addColorStop(0, fill);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  for (let i = 0; i < 220; i++) {
    const shade = r();
    const col =
      shade < 0.4
        ? 'rgba(48,60,40,0.42)'
        : shade < 0.75
          ? 'rgba(30,38,26,0.46)'
          : 'rgba(58,68,44,0.26)';
    blob(r() * S, r() * S, 16 + r() * 54, col);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The lane path, as a transparent overlay rather than a second opaque plane.
 *
 * Alpha falls off across the width, so the path has no edge to catch the eye —
 * the hard diagonal seam where the old lane plane met the ground was the single
 * most artificial thing in the frame. Repeats along the lane only, so the band
 * stays put across it.
 */
function pathTexture(planeWidth: number): THREE.Texture {
  const W = 512;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const r = rng(0x9a7);

  const half = (LANE_HALF_WIDTH / planeWidth) * H;
  const mid = H / 2;
  const grad = ctx.createLinearGradient(0, mid - half * 1.5, 0, mid + half * 1.5);
  grad.addColorStop(0, 'rgba(86,78,58,0)');
  grad.addColorStop(0.25, 'rgba(86,78,58,0.34)');
  grad.addColorStop(0.5, 'rgba(96,87,64,0.44)');
  grad.addColorStop(0.75, 'rgba(86,78,58,0.34)');
  grad.addColorStop(1, 'rgba(86,78,58,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Scuffing along the direction of travel. Faint and thin: a rut you can see
  // clearly is a rectangle, and a field of rectangles is worse than no detail.
  ctx.globalAlpha = 0.1;
  for (let i = 0; i < 70; i++) {
    const y = mid + (r() - 0.5) * 2 * half;
    ctx.fillStyle = r() < 0.5 ? '#3a3425' : '#6b6145';
    const w = 16 + r() * 54;
    const x = r() * W;
    ctx.fillRect(x, y, w, 1);
    if (x + w > W) ctx.fillRect(x - W, y, w, 1);
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** One rock: a squashed, randomly-faceted lump. */
function rockGeometry(): THREE.BufferGeometry {
  // Low-poly icosahedron, jittered per vertex so no two rocks read as clones
  // once they are rotated and scaled.
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const r = rng(0xb00c);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * (0.75 + r() * 0.5),
      pos.getY(i) * (0.7 + r() * 0.6),
      pos.getZ(i) * (0.75 + r() * 0.5),
    );
  }
  g.computeVertexNormals();
  return g;
}

/** Trunk plus canopy, merged into one geometry so a tree is one instance. */
function treeGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(7, 10, 60, 5);
  trunk.translate(0, 30, 0);
  const canopy = new THREE.ConeGeometry(46, 130, 6);
  canopy.translate(0, 118, 0);
  return mergeGeometries([trunk, canopy], false)!;
}

export interface Terrain {
  group: THREE.Group;
  dispose(): void;
}

export function buildTerrain(): Terrain {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const DEPTH = 8000;
  const tex = track(groundTexture());
  // Roughly square world-space tiles, so the mottle keeps its shape.
  tex.repeat.set(20000 / 1600, DEPTH / 1600);

  const ground = new THREE.Mesh(
    track(new THREE.PlaneGeometry(20000, DEPTH)),
    track(new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const PATH_WIDTH = LANE_HALF_WIDTH * 3;
  const pathTex = track(pathTexture(PATH_WIDTH));
  pathTex.repeat.set(20000 / 2400, 1);
  const path = new THREE.Mesh(
    track(new THREE.PlaneGeometry(20000, PATH_WIDTH)),
    track(
      new THREE.MeshStandardMaterial({
        map: pathTex,
        transparent: true,
        roughness: 1,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    ),
  );
  path.rotation.x = -Math.PI / 2;
  path.position.y = 0.4;
  path.receiveShadow = true;
  group.add(path);

  // --- rock ridges, one row each side of the corridor ---------------------
  const r = rng(0x1a2b);
  const rockGeom = track(rockGeometry());
  // Dark on purpose: the ridges are there to bound the corridor and give the
  // eye something to measure against, not to be looked at.
  // Very dark on purpose. These are lit by the same 3.1-intensity key the units
  // are, and a mid-grey rock under it comes out near white — which puts the
  // brightest thing on screen at the edge of the frame, where nothing worth
  // looking at ever happens.
  const rockMat = track(new THREE.MeshStandardMaterial({ color: 0x272d27, roughness: 1, flatShading: true }));
  const STEP = 115;
  const perSide = Math.ceil((LANE_TO - LANE_FROM) / STEP);
  const rocks = new THREE.InstancedMesh(rockGeom, rockMat, perSide * 2);
  rocks.receiveShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  let i = 0;
  for (const side of [-1, 1]) {
    for (let k = 0; k < perSide; k++) {
      const x = LANE_FROM + k * STEP + (r() - 0.5) * 70;
      const z = side * (CLIFF_OFFSET + 30 + r() * 90);
      const h = 70 + r() * 110;
      pos.set(x, h * 0.3, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
      scl.set(34 + r() * 30, h * 0.42, 32 + r() * 28);
      rocks.setMatrixAt(i++, m.compose(pos, q, scl));
    }
  }
  rocks.instanceMatrix.needsUpdate = true;
  group.add(rocks);

  // --- treeline behind the rocks ------------------------------------------
  const treeGeom = track(treeGeometry());
  const treeMat = track(new THREE.MeshStandardMaterial({ color: 0x24341f, roughness: 1, flatShading: true }));
  const TREE_STEP = 190;
  const rows = 3;
  const perRow = Math.ceil((LANE_TO - LANE_FROM) / TREE_STEP);
  const trees = new THREE.InstancedMesh(treeGeom, treeMat, perRow * rows * 2);
  let t = 0;
  for (const side of [-1, 1]) {
    for (let row = 0; row < rows; row++) {
      for (let k = 0; k < perRow; k++) {
        const x = LANE_FROM + k * TREE_STEP + (r() - 0.5) * 150;
        const z = side * (CLIFF_OFFSET + 180 + row * 210 + (r() - 0.5) * 130);
        const s = 0.8 + r() * 0.7;
        pos.set(x, 0, z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
        scl.set(s, s * (0.85 + r() * 0.5), s);
        trees.setMatrixAt(t++, m.compose(pos, q, scl));
      }
    }
  }
  trees.instanceMatrix.needsUpdate = true;
  group.add(trees);

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
      rocks.dispose();
      trees.dispose();
    },
  };
}
