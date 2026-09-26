import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Team, Unit } from '../sim/types.ts';
import { attackPointTime } from '../sim/constants.ts';
import { attachKit } from './weapons.ts';

/**
 * One animated unit on the 3D stage.
 *
 * The clip choice is derived from sim state only — nothing here writes back
 * into the sim, and nothing in sim/ knows this file exists.
 *
 * Two kinds of file come through here. The box rig (melee_creep.glb) draws the
 * heroes: it is tinted per team and fitted with procedural kit, and its timing
 * numbers are the constants below. The KayKit skeletons (tools/blender/
 * build_units.py) draw the melee and ranged creeps: they carry their own
 * colours and weapons, and their hit time and stride in the file.
 */

/** Blender scene fps the clips were authored at. */
const CLIP_FPS = 24;
/**
 * Frame in the Attack clip where the club actually connects. The clip starts on
 * frame 1, so the hit sits (10 - 1) / 24 seconds in. The runtime rescales the
 * clip so this instant lands exactly on the sim's damage tick.
 */
const ATTACK_HIT_TIME = (10 - 1) / CLIP_FPS;

/** Model is authored 1.85 units tall; sim creeps read right at ~100 units. */
const MODEL_SCALE = 54;
/** Head height of an unscaled rig, in sim units. Health bars anchor to it. */
export const MODEL_HEIGHT = 1.85 * MODEL_SCALE;

/**
 * Height of a KayKit rig's head joint in sim units, which sets its scale. All
 * the skeletons share one rig with the head joint at the same height, so
 * scaling by it keeps a hat or helmet from changing how big the body is drawn.
 * 48 puts the melee creep's top at about 100, where the box creep stood.
 */
const KAYKIT_STATURE = 48;
const STATURE_JOINT = 'head';

/** Below this sim-speed a unit is considered standing still. */
const WALK_EPSILON = 12;

/**
 * Seconds of travel averaged into one speed reading.
 *
 * The sim only moves on its fixed 1/120 s step, so at render rates at or above
 * that a frame regularly lands between two steps and sees zero displacement.
 * Measured per frame, that zero drops the rig straight back to Idle mid-stride
 * and the walk cycle never survives its own crossfade. A short window rides
 * over the gaps without noticeably lagging a stop.
 */
const SPEED_WINDOW = 0.1;

export type ClipName = 'Idle' | 'Walk' | 'Attack' | 'Death';

export interface CreepAsset {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Sim units per file unit, before the renderer's per-kind scale. */
  scale: number;
  /** Seconds into Attack where the blow lands. */
  hitTime: number;
  /**
   * File units per second the Walk clip covers at time scale 1. Null for the
   * box rig, which keeps the cadence it was tuned at by eye.
   */
  groundSpeed: number | null;
  /** The box rig: tinted per team and fitted with procedural kit. */
  box: boolean;
}

/** The files the renderer draws with. Siege creeps and towers need none. */
export interface UnitAssets {
  box: CreepAsset;
  creeps: Record<'melee_creep' | 'ranged_creep', Record<Team, CreepAsset>>;
}

/** Base64 payload of a `data:` URL, as bytes. */
function decodeDataUrl(url: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

async function loadGltf(url: string) {
  const loader = new GLTFLoader();
  // A data: URL is decoded here and handed to parse() rather than loadAsync(),
  // which would fetch() it — and fetch() on a data: URL is a connect-src request,
  // so a host with a strict CSP blocks it. Lets a build inline the GLB.
  const gltf = url.startsWith('data:')
    ? await loader.parseAsync(decodeDataUrl(url), '')
    : await loader.loadAsync(url);
  const missing = (['Idle', 'Walk', 'Attack', 'Death'] as ClipName[])
    .filter((n) => !gltf.animations.some((c) => c.name === n));
  if (missing.length) {
    // Loud on purpose: a silently-dropped clip is the classic glTF export bug,
    // and it is much cheaper to catch here than to debug as "the creep T-poses".
    throw new Error(`${name(url)} is missing clips: ${missing.join(', ')}`);
  }
  return gltf;
}

function name(url: string): string {
  return url.startsWith('data:') ? 'an inlined model' : url;
}

/** A clip's number from its glTF extras, if it is a usable one. */
function extra(clip: THREE.AnimationClip, key: string): number | null {
  const v = clip.userData[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The box rig, which the heroes are drawn with. */
export async function loadCreep(url: string): Promise<CreepAsset> {
  const gltf = await loadGltf(url);
  return {
    scene: gltf.scene,
    clips: gltf.animations,
    scale: MODEL_SCALE,
    hitTime: ATTACK_HIT_TIME,
    groundSpeed: null,
    box: true,
  };
}

/**
 * A KayKit creep from tools/blender/build_units.py. Its contact time and stride
 * come from the clips' glTF extras; without them the swing would land visibly
 * early or late and the walk would skate, so a file missing either is refused.
 */
export async function loadKayKitCreep(url: string): Promise<CreepAsset> {
  const gltf = await loadGltf(url);
  const clip = (n: ClipName) => gltf.animations.find((c) => c.name === n)!;

  const attack = clip('Attack');
  const hitTime = extra(attack, 'hitTime');
  if (hitTime === null || hitTime <= 0 || hitTime >= attack.duration) {
    throw new Error(
      `${name(url)}: Attack needs a hitTime inside (0, ${attack.duration.toFixed(3)}) s ` +
        `in its glTF extras, got ${JSON.stringify(attack.userData.hitTime)}`,
    );
  }
  const groundSpeed = extra(clip('Walk'), 'groundSpeed');
  if (groundSpeed === null || groundSpeed <= 0) {
    throw new Error(
      `${name(url)}: Walk needs a positive groundSpeed in its glTF extras, ` +
        `got ${JSON.stringify(clip('Walk').userData.groundSpeed)}`,
    );
  }

  gltf.scene.updateMatrixWorld(true);
  const joint = gltf.scene.getObjectByName(STATURE_JOINT);
  const stature = joint ? joint.getWorldPosition(new THREE.Vector3()).y : 0;
  if (!(stature > 0)) throw new Error(`${name(url)} has no "${STATURE_JOINT}" joint to scale by`);

  return {
    scene: gltf.scene,
    clips: gltf.animations,
    scale: KAYKIT_STATURE / stature,
    hitTime,
    groundSpeed,
    box: false,
  };
}

/**
 * Everything the renderer draws with, loaded in parallel. `url` maps a path
 * under public/ to where it is served from, so a packed build can hand in
 * data: URLs instead.
 */
export async function loadUnitAssets(url: (path: string) => string): Promise<UnitAssets> {
  const creep = (kind: string, team: Team) => loadKayKitCreep(url(`models/units/${kind}_${team}.glb`));
  const [box, meleeR, meleeD, rangedR, rangedD] = await Promise.all([
    loadCreep(url('models/melee_creep.glb')),
    creep('melee_creep', 'radiant'),
    creep('melee_creep', 'dire'),
    creep('ranged_creep', 'radiant'),
    creep('ranged_creep', 'dire'),
  ]);
  return {
    box,
    creeps: {
      melee_creep: { radiant: meleeR, dire: meleeD },
      ranged_creep: { radiant: rangedR, dire: rangedD },
    },
  };
}

export class UnitView {
  readonly root: THREE.Group;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<ClipName, THREE.AnimationAction>();
  private current: ClipName = 'Idle';
  private readonly hitTime: number;
  private readonly groundSpeed: number | null;

  /** Phase seen last frame, so a new swing is detected as a transition. */
  private prevPhase: Unit['phase'] = 'idle';
  private prev = new THREE.Vector3();
  private speed = 0;
  /** False until the first sync seeds `prev`, so spawning is not a teleport. */
  private primed = false;
  private travelled = 0;
  private window = 0;
  private dead = false;

  constructor(unit: Unit, asset: CreepAsset, tint?: number) {
    this.root = cloneSkinned(asset.scene) as THREE.Group;
    this.root.scale.setScalar(asset.scale);
    this.hitTime = asset.hitTime;
    this.groundSpeed = asset.groundSpeed;

    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (asset.box && tint !== undefined) {
        // Clone so the two teams do not share one material instance.
        o.material = (o.material as THREE.MeshStandardMaterial).clone();
        (o.material as THREE.MeshStandardMaterial).color.setHex(tint);
      }
    });

    // Kit follows from sim state like everything else here: a unit that spawns
    // projectiles shoots, one that hits instantly swings. Attached after the
    // tint pass so steel, wood and cloth keep their own colours.
    if (asset.box && !attachKit(this.root, unit.kind, unit.projectileSpeed)) {
      throw new Error('creep rig is missing the bones the unit kit mounts on');
    }

    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of asset.clips) {
      const action = this.mixer.clipAction(clip);
      const name = clip.name as ClipName;
      if (name === 'Death') {
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
    this.actions.get('Idle')!.play();
  }

  private play(name: ClipName, fade = 0.15, timeScale = 1) {
    if (name === this.current && name !== 'Attack') return;
    const next = this.actions.get(name);
    const prev = this.actions.get(this.current);
    if (!next) return;

    next.reset();
    next.timeScale = timeScale;
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    else next.fadeIn(fade);
    this.current = name;
  }

  /** Drive the view from one frame of sim state. */
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
    // Model forward is Blender -Y, which the glTF Y-up conversion turns into
    // three's +Z. Facing angle t means direction (cos t, 0, sin t), and
    // R_y(p) * (0,0,1) = (sin p, 0, cos p), so p = PI/2 - t.
    this.root.rotation.y = Math.PI / 2 - unit.facing;

    if (!unit.alive) {
      if (!this.dead) {
        this.dead = true;
        this.play('Death', 0.12);
      }
      this.mixer.update(dt);
      return;
    }

    // The Attack clip is owned by the sim's attack phases, not by its own
    // duration. Dota lets you cancel both windup and backswing with a new
    // order, and world.ts models that by dropping the unit straight back to
    // phase 'idle' — so the rig blends out the instant the phase clears. A clip
    // that ran to completion regardless would show a swing the sim never made.
    const swinging = unit.phase === 'windup' || unit.phase === 'backswing';

    // Keyed on the phase transition, so a unit that goes
    // straight from backswing into the next windup restarts the clip instead of
    // finishing the previous swing's follow-through.
    if (unit.phase === 'windup' && this.prevPhase !== 'windup') {
      // Rescale so the club connects on the sim's damage tick rather than
      // whenever the artist happened to put the contact frame. attackPointTime
      // is the same helper the sim uses, so attack speed is accounted for.
      const point = attackPointTime(unit.attackPoint, unit.attackSpeedBonus);
      const scale = this.hitTime / Math.max(point, 0.01);
      this.play('Attack', 0.06, scale);
    } else if (!swinging) {
      // Cancelled or finished: 0.12s out is quick enough to read as an
      // interrupted swing without snapping.
      if (this.speed > WALK_EPSILON) {
        // The box rig is deliberately not foot-locked: 325 units/s is several
        // of its body-heights per second, and matching stride exactly would look
        // like a sprint, so it scales, clamps and accepts the slide. A KayKit
        // rig knows its own stride and runs (Running_A), so at 325 its feet stay
        // about planted: 1.86x for the melee creep, and the ranged one, drawn
        // at 0.88, just over the clamp. The scale includes that per-kind nudge.
        const stride = this.groundSpeed === null ? 240 : this.groundSpeed * this.root.scale.x;
        const cadence = THREE.MathUtils.clamp(this.speed / stride, 0.7, 2.0);
        this.play('Walk', 0.12, cadence);
        this.actions.get('Walk')!.timeScale = cadence;
      } else {
        this.play('Idle', 0.12);
      }
    }

    this.prevPhase = unit.phase;
    this.mixer.update(dt);
  }

  /** Which clip is playing right now. Drives the debug readout on the slice page. */
  get clip(): ClipName {
    return this.current;
  }

  get isDead() {
    return this.dead;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
