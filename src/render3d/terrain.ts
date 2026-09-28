import * as THREE from 'three';
import { LANE_HALF_WIDTH } from '../sim/constants.ts';
import type { Assets, GroundTile } from './assets.ts';
import type { SpriteSheet } from './spriteView.ts';
import { UNITS_PER_METRE } from './appearance.ts';

/**
 * The lane, as a place you can judge distance in.
 *
 * Last hitting is a game of "am I in range", and a featureless field makes a
 * creep 200 units away look exactly like one 500 units away. So the ground
 * carries texture at a scale you can count, the path is worn into it, rock
 * ridges stand along both sides of the corridor, and a treeline stands behind
 * them. The ridges do double duty: they explain the invisible wall the sim
 * clamps movement to at LANE_HALF_WIDTH.
 *
 * The ground is the packs' own seamless textures (build_props.py), mixed in
 * the shader so no tile ever repeats one-for-one: every texture is sampled
 * twice, at two scales and turned against itself, and a noise field picks
 * between the two; two more noise fields lay patches of a second ground and of
 * flowers or moss over the first. Radiant's half is grass and Dire's mud, and
 * the line between them wanders across the middle of the lane.
 *
 * Trees, rocks and bushes are sprites like the units: cards standing on the
 * ground, each a random model in a random one of its eight facings, scaled a
 * little, and never the same model as the one beside it. Living trees give
 * way to dead ones across the middle, with a few strays either side.
 *
 * The playable corridor itself stays perfectly flat at y = 0, so the
 * ground-plane raycast that turns a click into a lane point, the upright
 * cylinders used for picking, and the ring geometry all keep working.
 */

/** How far out the rock ridges stand from the lane centre. */
const CLIFF_OFFSET = LANE_HALF_WIDTH + 55;
/** Lane runs along +x from before the Radiant spawn to past the Dire one. */
const LANE_FROM = -600;
const LANE_TO = 6600;
/** Where Radiant's ground gives way to Dire's: the middle of the lane. */
const LANE_MID = 3000;
/** World size of one ground tile, in sim units: about as many texture pixels as screen pixels at the default zoom. */
const TILE_SIZE = 540;
/**
 * The ground's textures are lit by the same 3.1-intensity sun as the units,
 * and at full strength the lane outshines everything standing on it.
 */
const GROUND_GAIN = 0.62;

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
 * Four independent channels of smooth noise that tile. Summed octaves of a
 * wrapped random lattice, each smoothed with a cubic, so the shader can read it
 * at any scale without seams.
 */
function noiseTexture(): THREE.DataTexture {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const r = rng(0x5eed);
  const acc = new Float32Array(S * S * 4);
  for (let c = 0; c < 4; c++) {
    let amp = 1;
    let total = 0;
    for (const cells of [4, 8, 16, 32]) {
      const lattice = Array.from({ length: cells * cells }, r);
      const at = (i: number, j: number) => lattice[((j + cells) % cells) * cells + ((i + cells) % cells)];
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const fx = (x / S) * cells;
          const fy = (y / S) * cells;
          const i = Math.floor(fx);
          const j = Math.floor(fy);
          const u = (fx - i) * (fx - i) * (3 - 2 * (fx - i));
          const v = (fy - j) * (fy - j) * (3 - 2 * (fy - j));
          const top = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
          const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
          acc[(y * S + x) * 4 + c] += (top + (bottom - top) * v) * amp;
        }
      }
      total += amp;
      amp *= 0.5;
    }
    for (let k = c; k < acc.length; k += 4) data[k] = Math.round((acc[k] / total) * 255);
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const GROUND_PARS = /* glsl */ `
  uniform sampler2D tGrass, tGrassDark, tFlowers, tPath, tMud, tMudStones, tPathDire, tMoss, tNoise;
  uniform float tileSize, laneHalf, laneMid, groundGain;
  varying vec3 vGround;
  // A texture sampled twice, at two scales and turned against itself, with a
  // noise field choosing between them: no tile repeats one-for-one.
  vec3 tiled(sampler2D t, vec2 p) {
    vec2 a = p / tileSize;
    vec2 b = mat2(0.8, -0.6, 0.6, 0.8) * p / (tileSize * 1.31) + vec2(0.37, 0.71);
    float m = texture2D(tNoise, p / (tileSize * 3.7)).a;
    return mix(texture2D(t, a).rgb, texture2D(t, b).rgb, smoothstep(0.35, 0.65, m));
  }
`;

const GROUND_MIX = /* glsl */ `
  {
    vec2 p = vGround.xz;
    vec4 wide = texture2D(tNoise, p / 2600.0);
    vec4 near = texture2D(tNoise, p / 700.0 + 0.5);
    vec3 radiant = mix(tiled(tGrass, p), tiled(tGrassDark, p), smoothstep(0.42, 0.68, wide.r));
    radiant = mix(radiant, tiled(tFlowers, p), smoothstep(0.62, 0.74, near.g) * 0.85);
    vec3 dire = mix(tiled(tMud, p), tiled(tMudStones, p), smoothstep(0.4, 0.66, wide.g));
    dire = mix(dire, tiled(tMoss, p), smoothstep(0.6, 0.74, near.b) * 0.75);
    // The line between the sides wanders a few hundred units either way.
    float side = smoothstep(-450.0, 450.0, p.x - laneMid + (wide.b - 0.5) * 1400.0);
    vec3 ground = mix(radiant, dire, side);
    // The path: worn down the middle, its edge ragged.
    float edge = abs(p.y) + (near.r - 0.5) * 150.0;
    float path = 1.0 - smoothstep(laneHalf * 0.45, laneHalf * 1.05, edge);
    vec3 lane = mix(tiled(tPath, p), tiled(tPathDire, p), side);
    diffuseColor.rgb *= mix(ground, lane, path * 0.8) * groundGain;
  }
`;

const UNIFORM_OF: Record<GroundTile, string> = {
  grass: 'tGrass',
  grass_dark: 'tGrassDark',
  flowers: 'tFlowers',
  path: 'tPath',
  mud: 'tMud',
  mud_stones: 'tMudStones',
  path_dire: 'tPathDire',
  moss: 'tMoss',
};

function groundMaterial(assets: Assets, noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 1 });
  const uniforms: Record<string, { value: unknown }> = {
    tNoise: { value: noise },
    tileSize: { value: TILE_SIZE },
    laneHalf: { value: LANE_HALF_WIDTH },
    laneMid: { value: LANE_MID },
    groundGain: { value: GROUND_GAIN },
  };
  for (const [name, uniform] of Object.entries(UNIFORM_OF)) uniforms[uniform] = { value: assets.ground[name as GroundTile] };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGround;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGround = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND_PARS}`)
      .replace('#include <map_fragment>', GROUND_MIX);
  };
  return mat;
}

// ------------------------------------------------------------------ scenery

const SCENERY_VERTEX = /* glsl */ `
  attribute vec4 iRect;
  attribute vec2 iOrigin;
  attribute vec4 iFoot;
  attribute float iShade;
  uniform vec2 pageSize;
  uniform float lift;
  varying vec2 vUv;
  varying float vShade;
  #include <fog_pars_vertex>
  void main() {
    // As a unit's sprite (spriteView.ts), one per instance: iRect is the crop,
    // iOrigin its foot point, iFoot where it stands and its sim units per pixel.
    vec2 px = vec2(position.x * iRect.z, (1.0 - position.y) * iRect.w);
    vec3 foot = iFoot.xyz;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    vec3 world = foot + (right * (px.x - iOrigin.x) + up * (iOrigin.y - px.y)) * iFoot.w;
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vec4 feet = projectionMatrix * viewMatrix * vec4(foot + back * lift, 1.0);
    gl_Position.z = feet.z / feet.w * gl_Position.w;
    vUv = (iRect.xy + px) / pageSize;
    vShade = iShade;
    #include <fog_vertex>
  }
`;

const SCENERY_FRAGMENT = /* glsl */ `
  uniform sampler2D page;
  uniform sampler2D palette;
  varying vec2 vUv;
  varying float vShade;
  #include <fog_pars_fragment>
  void main() {
    float i = floor(texture2D(page, vUv).r * 255.0 + 0.5);
    if (i < 0.5) discard;
    gl_FragColor = texture2D(palette, vec2((i + 0.5) / 256.0, 0.5));
    #include <colorspace_fragment>
    gl_FragColor.rgb *= vShade;
    #include <fog_fragment>
  }
`;

/**
 * How bright each kind of scenery is drawn against its render. The sprites are
 * lit as brightly as the units, and a pale rock at full strength is the
 * brightest thing on screen, at the edge of the frame where nothing worth
 * looking at ever happens: the ridges are there to bound the corridor, not to
 * be looked at.
 */
const SHADE: Record<string, number> = { rock: 0.5, bush: 0.72, tree: 0.8 };

interface Placement {
  x: number;
  z: number;
  variant: string;
  /** Fraction of the model's full height. */
  scale: number;
}

/** Scenery sprites as one instanced quad per page. */
function sceneryMeshes(sheet: SpriteSheet, placements: Placement[], track: <T extends { dispose(): void }>(d: T) => T): THREE.Mesh[] {
  const r = rng(0xd1ec);
  const byPage = new Map<number, number[][]>();
  for (const p of placements) {
    const clip = sheet.clips[p.variant];
    const dir = Math.floor(r() * sheet.directions);
    const [page, x, y, w, h, ox, oy] = clip.cells[dir][0];
    if (!w) continue;
    const perPixel = (UNITS_PER_METRE * p.scale) / sheet.pixelsPerMetre;
    const list = byPage.get(page) ?? [];
    list.push([x, y, w, h, ox, oy, p.x, 0, p.z, perPixel, SHADE[clip.kind ?? 'rock'] ?? 1]);
    byPage.set(page, list);
  }
  const palette = sheet.palettes.radiant;
  const meshes: THREE.Mesh[] = [];
  for (const [page, list] of byPage) {
    const base = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
    const geom = track(new THREE.InstancedBufferGeometry());
    geom.index = base.index;
    geom.setAttribute('position', base.getAttribute('position'));
    geom.instanceCount = list.length;
    geom.setAttribute('iRect', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((l) => l.slice(0, 4))), 4));
    geom.setAttribute('iOrigin', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((l) => l.slice(4, 6))), 2));
    geom.setAttribute('iFoot', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((l) => l.slice(6, 10))), 4));
    geom.setAttribute('iShade', new THREE.InstancedBufferAttribute(new Float32Array(list.map((l) => l[10])), 1));
    const tex = sheet.pages[page];
    const mat = track(
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            page: { value: null },
            palette: { value: null },
            pageSize: { value: new THREE.Vector2(tex.image.width, tex.image.height) },
            lift: { value: 30 },
          },
        ]),
        vertexShader: SCENERY_VERTEX,
        fragmentShader: SCENERY_FRAGMENT,
        fog: true,
      }),
    );
    mat.uniforms.page.value = tex;
    mat.uniforms.palette.value = palette;
    const mesh = new THREE.Mesh(geom, mat);
    // The vertex shader places every card, so the quad's own bounds say nothing.
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }
  return meshes;
}

/**
 * Picks scenery. Which side's models a spot draws from is a coin weighted by
 * how far past the middle it is, so the two sides blend over a stretch rather
 * than at a line; and a spot never repeats the model its neighbour took.
 */
function picker(sheet: SpriteSheet, r: () => number) {
  const all = Object.entries(sheet.clips).map(([name, clip]) => ({ name, side: clip.side ?? 'both', kind: clip.kind ?? 'rock' }));
  let last = '';
  return (kind: 'tree' | 'rock' | 'bush', x: number): string => {
    const dire = THREE.MathUtils.smoothstep(x + (r() - 0.5) * 900, LANE_MID - 900, LANE_MID + 900);
    const side = r() < dire ? 'dire' : 'radiant';
    let options = all.filter((v) => v.kind === kind && (v.side === side || v.side === 'both') && v.name !== last);
    if (!options.length) options = all.filter((v) => v.kind === kind);
    last = options[Math.floor(r() * options.length)].name;
    return last;
  };
}

export interface Terrain {
  group: THREE.Group;
  dispose(): void;
}

export function buildTerrain(assets: Assets): Terrain {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const DEPTH = 8000;
  const noise = track(noiseTexture());
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(20000, DEPTH)), track(groundMaterial(assets, noise)));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const r = rng(0x1a2b);
  const pick = picker(assets.scenery, r);
  const placements: Placement[] = [];

  // --- rock ridges, one row each side of the corridor, a bush now and then ---
  const STEP = 115;
  const perSide = Math.ceil((LANE_TO - LANE_FROM) / STEP);
  for (const side of [-1, 1]) {
    for (let k = 0; k < perSide; k++) {
      const x = LANE_FROM + k * STEP + (r() - 0.5) * 70;
      const z = side * (CLIFF_OFFSET + 30 + r() * 90);
      placements.push({ x, z, variant: pick('rock', x), scale: 0.45 + r() * 0.4 });
      if (r() < 0.3) {
        const bx = x + (r() - 0.5) * STEP;
        placements.push({ x: bx, z: z + side * (40 + r() * 60), variant: pick('bush', bx), scale: 0.7 + r() * 0.4 });
      }
    }
  }

  // --- treeline behind the rocks ------------------------------------------
  const TREE_STEP = 190;
  const rows = 3;
  const perRow = Math.ceil((LANE_TO - LANE_FROM) / TREE_STEP);
  for (const side of [-1, 1]) {
    for (let row = 0; row < rows; row++) {
      for (let k = 0; k < perRow; k++) {
        const x = LANE_FROM + k * TREE_STEP + (r() - 0.5) * 150;
        const z = side * (CLIFF_OFFSET + 180 + row * 210 + (r() - 0.5) * 130);
        placements.push({ x, z, variant: pick('tree', x), scale: 0.72 + r() * 0.28 });
      }
    }
  }
  for (const mesh of sceneryMeshes(assets.scenery, placements, track)) group.add(mesh);

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
