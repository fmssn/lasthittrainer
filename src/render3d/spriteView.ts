import * as THREE from 'three';
import type { Team, Unit } from '../sim/types.ts';
import { attackPointTime } from '../sim/constants.ts';

/**
 * A unit drawn as a pre-rendered sprite: heroes, creeps, catapults and towers.
 *
 * They are Synty POLYGON models rendered in Blender from the lane camera's own
 * angle, in 16 facings (a tower in one), every frame of four clips, snapped to
 * a 255-colour palette (tools/blender/build_characters.py and build_props.py
 * render them through supplyline's sprite pipeline, and pack_sprites.py packs
 * the result). What is on screen is a quad facing the camera with the frame for
 * the unit's clip, time and facing on it, so a swing reads exactly as it was
 * rendered.
 *
 * A page stores palette indices, one byte per pixel, not colours. The last few
 * palette entries are shades of the key colour a hero's cloth was rendered in,
 * and each team has its own palette with those entries in its colour: a hero's
 * team colour is a palette swap, as sprites have always done it. Creeps,
 * catapults and towers are a different model per team and use none of it.
 *
 * The sprite writes the depth of its feet across its whole height, so it sorts
 * against every other sprite as a card standing where the unit stands. Drawn
 * as the tilted quad it geometrically is, its lower half would sink into the
 * lane. It casts no shadow of its own (a flat card would throw a sliver); an
 * invisible capsule of the unit's size casts one instead.
 */

/** Below this sim-speed a unit is considered standing still. */
export const WALK_EPSILON = 12;

/**
 * Walk clip rate at a unit's full move speed: the rate it was animated at.
 *
 * The walk used to be foot-locked, played at whatever rate kept a planted foot
 * still. The units are small for the distances Dota moves them, so a planted
 * foot needs that many steps a second (1.86x for a creep), and playtesters
 * found the legs frantic. So the feet slide a little instead, and the stride
 * reads at the pace it was animated for. Slower than full speed (squeezing
 * past a wavemate) slows the clip in proportion, down to the minimum.
 */
const WALK_CADENCE_MAX = 1;
const WALK_CADENCE_MIN = 0.5;

/**
 * Seconds of travel averaged into one speed reading.
 *
 * The sim only moves on its fixed 1/120 s step, so at render rates at or above
 * that a frame regularly lands between two steps and sees zero displacement.
 * Measured per frame, that zero drops a unit straight back to Idle mid-stride.
 * A short window rides over the gaps without noticeably lagging a stop.
 */
export const SPEED_WINDOW = 0.1;

export type ClipName = 'Idle' | 'Walk' | 'Attack' | 'Death';

/** The clips a unit that moves and swings cannot be drawn without. */
export const UNIT_CLIPS: readonly ClipName[] = ['Idle', 'Walk', 'Attack', 'Death'];

/** How a view stands in the scene: its size, its shadow, and how far its depth is lifted. */
export interface SpriteFit {
  /** Sim units per metre of the rendered model. */
  unitsPerMetre: number;
  /** How far toward the camera the sprite's depth sits from its feet: enough to clear the lane under it. */
  lift: number;
  /** The invisible shadow caster, a capsule about as wide and tall as the body. */
  shadowRadius: number;
  shadowHeight: number;
}

/** A frame's crop: page, x, y, width, height on the page, and the feet relative to its top-left (px). */
type Cell = [number, number, number, number, number, number, number];

export interface SpriteClip {
  fps: number;
  loop: boolean;
  frames: number;
  /** Scenery only: which side of the lane it grows on, and what it is. */
  side?: 'radiant' | 'dire' | 'both';
  kind?: 'tree' | 'rock' | 'bush';
  /** Attack only: seconds into the clip, at time scale 1, where the blow lands or the arrow leaves. */
  hitTime?: number;
  /**
   * Walk only: metres per second the feet travel at time scale 1. Recorded,
   * but no longer played to: see WALK_CADENCE_MAX.
   */
  groundSpeed?: number;
  /** By direction, then frame. */
  cells: Cell[][];
}

export interface SpriteSheet {
  pixelsPerMetre: number;
  directions: number;
  pages: THREE.DataTexture[];
  /** A unit's are its four ClipNames (a tower has only Idle); scenery's are its models. */
  clips: Record<string, SpriteClip>;
  /** One palette per team: the same colours, the key ramp in the team's. */
  palettes: Record<Team, THREE.DataTexture>;
}

interface PaletteFile {
  colors: string[];
  teamRamp: { first: number; count: number };
}

interface SheetFile {
  pixelsPerMetre: number;
  directions: number;
  pages: string[];
  clips: Record<string, SpriteClip>;
}

/**
 * The key ramp's shades, as build_heroes.py wrote them: the key colour at
 * 0.14 to 1.0 of full, in sRGB, darkest first.
 */
function rampLevel(i: number, count: number): number {
  return 0.14 + ((1.0 - 0.14) * i) / (count - 1);
}

/**
 * Key level a fully lit, brightest team swatch renders at. A team shade is the
 * team colour scaled by level over this, so the cloth keeps its shading.
 */
const RAMP_REFERENCE = 0.85;

/**
 * Loads a sheet's pages and manifest. `url` maps a path under public/ to where
 * it is served from; `tints` is each team's colour for a hero's key ramp.
 * `needs` names the clips the sheet must have. An Attack without its hitTime
 * would swing off the sim's timing, so it is refused.
 */
export async function loadSprites(
  id: string,
  url: (path: string) => string,
  tints: Record<Team, number>,
  needs: readonly ClipName[] = [],
): Promise<SpriteSheet> {
  const [palette, sheet] = await Promise.all([
    fetchJson<PaletteFile>(url('sprites/palette.json')),
    fetchJson<SheetFile>(url(`sprites/${id}.json`)),
  ]);
  for (const [name, clip] of Object.entries(sheet.clips)) {
    if (clip.cells.length !== sheet.directions) throw new Error(`${id}: sprite clip ${name} is incomplete`);
  }
  for (const name of needs) {
    if (!sheet.clips[name]) throw new Error(`${id}: sprite clip ${name} is missing`);
  }
  const attack = sheet.clips.Attack;
  if (needs.includes('Attack') && !(attack.hitTime! > 0 && attack.hitTime! < attack.frames / attack.fps)) {
    throw new Error(`${id}: the Attack sprites need a hitTime inside the clip`);
  }
  const pages = await Promise.all(sheet.pages.map(async (p) => pageTexture(await decodeGreyPng(await fetchBytes(url(`sprites/${p}`))))));
  return {
    pixelsPerMetre: sheet.pixelsPerMetre,
    directions: sheet.directions,
    pages,
    clips: sheet.clips,
    palettes: {
      radiant: paletteTexture(palette, tints.radiant),
      dire: paletteTexture(palette, tints.dire),
    },
  };
}

function pageTexture(image: { width: number; height: number; data: Uint8Array }): THREE.DataTexture {
  const tex = new THREE.DataTexture(image.data, image.width, image.height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

function paletteTexture(palette: PaletteFile, tint: number): THREE.DataTexture {
  const data = new Uint8Array(256 * 4);
  const team = new THREE.Color(tint);
  const { first, count } = palette.teamRamp;
  palette.colors.forEach((hex, i) => {
    const index = i + 1;
    let rgb = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    if (index >= first && index < first + count) {
      const k = rampLevel(index - first, count) / RAMP_REFERENCE;
      // THREE.Color holds linear values; the palette is sRGB.
      const c = team.clone().convertLinearToSRGB();
      rgb = [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, v * k) * 255));
    }
    data.set([rgb[0], rgb[1], rgb[2], 255], index * 4);
  });
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ loading

/**
 * A `data:` URL is decoded here, not fetched: fetch() on one is a connect-src
 * request, which a host with a strict CSP blocks, and a packed build inlines
 * every sheet as one.
 */
async function fetchBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    return Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url))) as T;
}

/**
 * An 8-bit greyscale PNG's samples, top row first. Decoded here rather than by
 * the browser, which would expand it to RGBA and may colour-manage it on the
 * way: these bytes are palette indices, and one off is another colour.
 */
async function decodeGreyPng(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array<ArrayBuffer>[] = [];
  for (let off = 8; off < bytes.length; ) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (type === 'IHDR') {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      const [depth, colour, , , interlace] = bytes.subarray(off + 16, off + 21);
      if (depth !== 8 || colour !== 0 || interlace !== 0) throw new Error('sprite pages must be 8-bit greyscale PNGs');
    } else if (type === 'IDAT') {
      idat.push(bytes.slice(off + 8, off + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    const src = y * (width + 1) + 1;
    const row = y * width;
    if (filter === 0) {
      // pack_sprites.py writes every row unfiltered.
      out.set(raw.subarray(src, src + width), row);
      continue;
    }
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? out[row + x - 1] : 0;
      const b = y > 0 ? out[row - width + x] : 0;
      const c = x > 0 && y > 0 ? out[row - width + x - 1] : 0;
      let p = raw[src + x];
      if (filter === 1) p += a;
      else if (filter === 2) p += b;
      else if (filter === 3) p += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = p & 255;
    }
  }
  return { width, height, data: out };
}

// ------------------------------------------------------------------ drawing

export const SPRITE_SHADER = {
  vertex: /* glsl */ `
    uniform vec4 rect;
    uniform vec2 origin;
    uniform vec2 pageSize;
    uniform float unitsPerPixel;
    uniform float lift;
    varying vec2 vUv;
    #include <fog_pars_vertex>
    void main() {
      // position.xy runs 0..1 across the crop, y up; px is in crop pixels, y down.
      vec2 px = vec2(position.x * rect.z, (1.0 - position.y) * rect.w);
      vec3 foot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
      vec3 world = foot + (right * (px.x - origin.x) + up * (origin.y - px.y)) * unitsPerPixel;
      vec4 mvPosition = viewMatrix * vec4(world, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      vec4 feet = projectionMatrix * viewMatrix * vec4(foot + back * lift, 1.0);
      gl_Position.z = feet.z / feet.w * gl_Position.w;
      vUv = (rect.xy + px) / pageSize;
      #include <fog_vertex>
    }
  `,
  fragment: /* glsl */ `
    uniform sampler2D page;
    uniform sampler2D palette;
    uniform float maskPass;
    varying vec2 vUv;
    #include <fog_pars_fragment>
    void main() {
      float i = floor(texture2D(page, vUv).r * 255.0 + 0.5);
      if (i < 0.5) discard;
      if (maskPass > 0.5) {
        gl_FragColor = vec4(1.0);
        return;
      }
      gl_FragColor = texture2D(palette, vec2((i + 0.5) / 256.0, 0.5));
      #include <colorspace_fragment>
      #include <fog_fragment>
    }
  `,
};

export class SpriteView {
  readonly root = new THREE.Group();
  private readonly quad: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly unitsPerPixel: number;

  private current: ClipName = 'Idle';
  private time = 0;
  private timeScale = 1;

  private prevPhase: Unit['phase'] = 'idle';
  private prev = new THREE.Vector3();
  private speed = 0;
  private primed = false;
  private travelled = 0;
  private window = 0;
  private dead = false;

  constructor(
    private readonly sheet: SpriteSheet,
    team: Team,
    private readonly camera: THREE.Camera,
    fit: SpriteFit,
  ) {
    this.unitsPerPixel = fit.unitsPerMetre / sheet.pixelsPerMetre;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          page: { value: null },
          palette: { value: null },
          rect: { value: new THREE.Vector4() },
          origin: { value: new THREE.Vector2() },
          pageSize: { value: new THREE.Vector2() },
          unitsPerPixel: { value: this.unitsPerPixel },
          lift: { value: fit.lift },
          maskPass: { value: 0 },
        },
      ]),
      vertexShader: SPRITE_SHADER.vertex,
      fragmentShader: SPRITE_SHADER.fragment,
      fog: true,
    });
    this.material.uniforms.palette.value = sheet.palettes[team];
    // The outline's mask passes swap every material for a flat one, which would
    // draw this quad as a rectangle. It keeps its own and goes flat itself when
    // the camera drawing it does not see the main layer.
    this.material.allowOverride = false;
    const geometry = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
    this.quad = new THREE.Mesh(geometry, this.material);
    // The vertex shader places it, so its bounds say nothing.
    this.quad.frustumCulled = false;
    this.quad.onBeforeRender = (_r, _s, camera) => {
      this.material.uniforms.maskPass.value = camera.layers.isEnabled(0) ? 0 : 1;
    };
    this.root.add(this.quad);

    const caster = new THREE.Mesh(
      new THREE.CapsuleGeometry(fit.shadowRadius, Math.max(0, fit.shadowHeight - 2 * fit.shadowRadius), 4, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    (caster.material as THREE.Material).allowOverride = false;
    caster.position.y = fit.shadowHeight / 2;
    caster.castShadow = true;
    this.root.add(caster);
  }

  sync(unit: Unit, dt: number) {
    const pos = new THREE.Vector3(unit.pos.x, 0, unit.pos.y);
    if (!this.primed) {
      this.prev.copy(pos);
      this.primed = true;
    }
    this.travelled += pos.distanceTo(this.prev);
    this.window += dt;
    if (this.window >= SPEED_WINDOW) {
      this.speed = this.travelled / this.window;
      this.travelled = 0;
      this.window = 0;
    }
    this.prev.copy(pos);
    this.root.position.copy(pos);

    // The Attack clip is owned by the sim's attack phases, not by its own
    // duration: it starts on the phase turning to windup, rescaled so the blow
    // lands (or the shot leaves) on the damage tick, and a cancelled or finished
    // swing drops straight back to Walk or Idle. attackPointTime is the helper
    // the sim uses, so attack speed is accounted for. A sheet without a clip
    // (a tower has only Idle) stays on what it has.
    if (!unit.alive) {
      if (!this.dead) {
        this.dead = true;
        if (this.sheet.clips.Death) this.play('Death', 1);
        else this.root.visible = false;
      }
    } else if (this.sheet.clips.Attack) {
      const swinging = unit.phase === 'windup' || unit.phase === 'backswing';
      if (unit.phase === 'windup' && this.prevPhase !== 'windup') {
        const point = attackPointTime(unit.attackPoint, unit.attackSpeedBonus);
        this.play('Attack', this.sheet.clips.Attack.hitTime! / Math.max(point, 0.01));
      } else if (!swinging) {
        if (this.speed > WALK_EPSILON) {
          const cadence = THREE.MathUtils.clamp(this.speed / unit.moveSpeed, WALK_CADENCE_MIN, WALK_CADENCE_MAX);
          if (this.current !== 'Walk') this.play('Walk', cadence);
          this.timeScale = cadence;
        } else if (this.current !== 'Idle') {
          this.play('Idle', 1);
        }
      }
      this.prevPhase = unit.phase;
    }
    this.time += dt * this.timeScale;
    this.show(unit.facing);
  }

  private play(name: ClipName, timeScale: number) {
    this.current = name;
    this.time = 0;
    this.timeScale = timeScale;
  }

  private show(facing: number) {
    const clip = this.sheet.clips[this.current];
    let frame = Math.floor(this.time * clip.fps + 1e-6);
    frame = clip.loop ? ((frame % clip.frames) + clip.frames) % clip.frames : Math.min(frame, clip.frames - 1);

    // Direction 0 faces the camera; each next one is the unit turned a step
    // clockwise seen from above, which is a step up in sim angle.
    const cam = this.camera.position;
    const toward = Math.atan2(cam.z - this.root.position.z, cam.x - this.root.position.x);
    const step = (2 * Math.PI) / this.sheet.directions;
    const n = this.sheet.directions;
    const dir = ((Math.round((facing - toward) / step) % n) + n) % n;

    const [page, x, y, w, h, ox, oy] = clip.cells[dir][frame];
    const u = this.material.uniforms;
    const tex = this.sheet.pages[page];
    u.page.value = tex;
    (u.pageSize.value as THREE.Vector2).set(tex.image.width, tex.image.height);
    (u.rect.value as THREE.Vector4).set(x, y, w, h);
    (u.origin.value as THREE.Vector2).set(ox, oy);
    this.quad.visible = w > 0;
  }

  get clip(): ClipName {
    return this.current;
  }

  dispose() {
    this.root.removeFromParent();
    this.material.dispose();
    this.quad.geometry.dispose();
    for (const child of this.root.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }
}
