import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Unit } from '../sim/types.ts';

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

/** Below this sim-speed a unit is considered standing still. */
const WALK_EPSILON = 12;

export type ClipName = 'Idle' | 'Walk' | 'Attack' | 'Death';

export interface CreepAsset {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}

export async function loadCreep(url: string): Promise<CreepAsset> {
  const gltf = await new GLTFLoader().loadAsync(url);
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

  /** Seconds left in the attack clip before we may return to idle/walk. */
  private attackHold = 0;
  private prev = new THREE.Vector3();
  private speed = 0;
  private dead = false;

  constructor(asset: CreepAsset, tint?: number) {
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
    if (dt > 0) this.speed = pos.distanceTo(this.prev) / dt;
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

    this.attackHold = Math.max(0, this.attackHold - dt);

    if (unit.phase === 'windup' && this.attackHold <= 0) {
      // Rescale so the club connects on the sim's damage tick rather than
      // whenever the artist happened to put the contact frame.
      const scale = ATTACK_HIT_TIME / Math.max(unit.attackPoint, 0.01);
      const clipLength = this.actions.get('Attack')!.getClip().duration;
      this.play('Attack', 0.06, scale);
      this.attackHold = clipLength / scale;
    } else if (this.attackHold <= 0) {
      if (this.speed > WALK_EPSILON) {
        // Deliberately not foot-locked: sim creeps move 325 units/s, which is
        // several body-heights per second. Matching stride exactly would look
        // like a sprint. Cadence is scaled, then clamped, and slide is accepted.
        const cadence = THREE.MathUtils.clamp(this.speed / 240, 0.7, 2.0);
        this.play('Walk', 0.18, cadence);
        this.actions.get('Walk')!.timeScale = cadence;
      } else {
        this.play('Idle', 0.25);
      }
    }

    this.mixer.update(dt);
  }

  get isDead() {
    return this.dead;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
