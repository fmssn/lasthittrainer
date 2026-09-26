import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Unit } from '../sim/types.ts';
import { attackPointTime } from '../sim/constants.ts';
import { attachKit } from './weapons.ts';

/**
 * One animated unit on the 3D stage.
 *
 * The clip choice is derived from sim state only — nothing here writes back
 * into the sim, and nothing in sim/ knows this file exists. Swapping the creep
 * GLB for a real asset means matching four clip names, nothing more.
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
}

/** Base64 payload of a `data:` URL, as bytes. */
function decodeDataUrl(url: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

export async function loadCreep(url: string): Promise<CreepAsset> {
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
    throw new Error(`${url} is missing clips: ${missing.join(', ')}`);
  }
  return { scene: gltf.scene, clips: gltf.animations };
}

export class UnitView {
  readonly root: THREE.Group;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<ClipName, THREE.AnimationAction>();
  private current: ClipName = 'Idle';

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
    this.root.scale.setScalar(MODEL_SCALE);

    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (tint !== undefined) {
        // Clone so the two teams do not share one material instance.
        o.material = (o.material as THREE.MeshStandardMaterial).clone();
        (o.material as THREE.MeshStandardMaterial).color.setHex(tint);
      }
    });

    // Kit follows from sim state like everything else here: a unit that spawns
    // projectiles shoots, one that hits instantly swings. Attached after the
    // tint pass so steel, wood and cloth keep their own colours.
    if (!attachKit(this.root, unit.kind, unit.projectileSpeed)) {
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
      const scale = ATTACK_HIT_TIME / Math.max(point, 0.01);
      this.play('Attack', 0.06, scale);
    } else if (!swinging) {
      // Cancelled or finished: 0.12s out is quick enough to read as an
      // interrupted swing without snapping.
      if (this.speed > WALK_EPSILON) {
        // Deliberately not foot-locked: sim creeps move 325 units/s, which is
        // several body-heights per second. Matching stride exactly would look
        // like a sprint. Cadence is scaled, then clamped, and slide is accepted.
        const cadence = THREE.MathUtils.clamp(this.speed / 240, 0.7, 2.0);
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
