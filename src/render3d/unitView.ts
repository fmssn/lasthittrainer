import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Team, Unit } from '../sim/types.ts';
import { attackPointTime } from '../sim/constants.ts';
import { HEROES } from '../sim/heroes.ts';

/**
 * One animated unit on the 3D stage.
 *
 * The clip choice is derived from sim state only — nothing here writes back
 * into the sim, and nothing in sim/ knows this file exists.
 *
 * Two kinds of file come through here.
 * - The hero models (models/heroes/, built by hand in tools/blender/heroes.blend)
 *   wear their own gear, carry their hit time on the armature, and take the
 *   team colour on their `Team` material only.
 * - The KayKit skeletons (tools/blender/build_units.py) draw the melee and
 *   ranged creeps. They carry their own colours and weapons, and their hit time
 *   and stride in the file.
 */

/**
 * Sim units per metre for a hero model. The first rig, a 1.85 m box creep,
 * read right at ~100 sim units, and the heroes were modelled to that scale.
 */
const MODEL_SCALE = 54;
/** Head height of an unscaled rig, in sim units. Health bars anchor to it. */
export const MODEL_HEIGHT = 1.85 * MODEL_SCALE;

/**
 * Height of a KayKit rig's head joint in sim units, which sets its scale. All
 * the skeletons share one rig with the head joint at the same height, so
 * scaling by it keeps a hat or helmet from changing how big the body is drawn.
 * 48 puts the melee creep's top at about 100, level with MODEL_HEIGHT.
 */
const KAYKIT_STATURE = 48;
const STATURE_JOINT = 'head';

/** Below this sim-speed a unit is considered standing still. */
const WALK_EPSILON = 12;

/**
 * Walk clip rate at a unit's full move speed: the rate it was animated at.
 *
 * The walk used to be foot-locked. A creep's Running_A was played at whatever
 * rate kept its planted foot still at 325, which came to 1.86x, and a hero's
 * walk at 305 / 240 = 1.27x. The rigs are small for the distances Dota moves
 * them, so a planted foot needs that many steps a second, and playtesters
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
   * A hero model: only its `Team` material takes the tint. Everything else on
   * it is authored colour, and tinting skin and steel with the team colour is
   * what made the old box rig read as a painted mannequin.
   */
  teamTint: boolean;
}

/** The files the renderer draws with. Siege creeps and towers need none. */
export interface UnitAssets {
  creeps: Record<'melee_creep' | 'ranged_creep', Record<Team, CreepAsset>>;
  /** By hero id. Every hero in HEROES has one. */
  heroes: Record<string, CreepAsset>;
}

/** The one material a hero model lets the runtime recolour. */
const TEAM_MATERIAL = 'Team';

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

/**
 * A hero model from tools/blender/heroes.blend, authored in metres, so it takes
 * {@link MODEL_SCALE}. Its contact (or release) time is a
 * custom property on the armature, which the exporter writes as node extras,
 * so it travels with the file rather than living in a constant that the next
 * re-export silently invalidates. A file without one is refused, for the same
 * reason the KayKit loader refuses one.
 */
export async function loadHero(url: string): Promise<CreepAsset> {
  const gltf = await loadGltf(url);
  const attack = gltf.animations.find((c) => c.name === 'Attack')!;
  const found: number[] = [];
  gltf.scene.traverse((o) => {
    const v = o.userData.hitTime;
    if (typeof v === 'number' && Number.isFinite(v)) found.push(v);
  });
  const hitTime = found[0];
  if (hitTime === undefined || hitTime <= 0 || hitTime >= attack.duration) {
    throw new Error(`${name(url)}: the armature needs a hitTime inside (0, ${attack.duration.toFixed(3)}) s`);
  }
  return {
    scene: gltf.scene,
    clips: gltf.animations,
    scale: MODEL_SCALE,
    hitTime,
    teamTint: true,
  };
}

/**
 * A KayKit creep from tools/blender/build_units.py. Its contact time comes from
 * the Attack clip's glTF extras; without it the swing would land visibly early
 * or late, so a file missing it is refused. The Walk clip's `groundSpeed` extra
 * is still written but no longer read: see {@link WALK_CADENCE_MAX}.
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

  gltf.scene.updateMatrixWorld(true);
  const joint = gltf.scene.getObjectByName(STATURE_JOINT);
  const stature = joint ? joint.getWorldPosition(new THREE.Vector3()).y : 0;
  if (!(stature > 0)) throw new Error(`${name(url)} has no "${STATURE_JOINT}" joint to scale by`);

  return {
    scene: gltf.scene,
    clips: gltf.animations,
    scale: KAYKIT_STATURE / stature,
    hitTime,
    teamTint: false,
  };
}

/**
 * Everything the renderer draws with, loaded in parallel. `url` maps a path
 * under public/ to where it is served from, so a packed build can hand in
 * data: URLs instead.
 */
export async function loadUnitAssets(url: (path: string) => string): Promise<UnitAssets> {
  const creep = (kind: string, team: Team) => loadKayKitCreep(url(`models/units/${kind}_${team}.glb`));
  // One model per hero in the roster, and a missing one is as fatal as a
  // creep: there is nothing to fall back to that swings on the hero's timing.
  const heroIds = HEROES.map((h) => h.id);
  const [[meleeR, meleeD, rangedR, rangedD], heroModels] = await Promise.all([
    Promise.all([
      creep('melee_creep', 'radiant'),
      creep('melee_creep', 'dire'),
      creep('ranged_creep', 'radiant'),
      creep('ranged_creep', 'dire'),
    ]),
    Promise.all(heroIds.map((id) => loadHero(url(`models/heroes/${id}.glb`)))),
  ]);
  return {
    creeps: {
      melee_creep: { radiant: meleeR, dire: meleeD },
      ranged_creep: { radiant: rangedR, dire: rangedD },
    },
    heroes: Object.fromEntries(heroIds.map((id, i) => [id, heroModels[i]])),
  };
}

export class UnitView {
  readonly root: THREE.Group;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<ClipName, THREE.AnimationAction>();
  private current: ClipName = 'Idle';
  private readonly hitTime: number;

  /** Phase seen last frame, so a new swing is detected as a transition. */
  private prevPhase: Unit['phase'] = 'idle';
  private prev = new THREE.Vector3();
  private speed = 0;
  /** False until the first sync seeds `prev`, so spawning is not a teleport. */
  private primed = false;
  private travelled = 0;
  private window = 0;
  private dead = false;

  constructor(asset: CreepAsset, tint?: number) {
    this.root = cloneSkinned(asset.scene) as THREE.Group;
    this.root.scale.setScalar(asset.scale);
    this.hitTime = asset.hitTime;

    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = o.material as THREE.MeshStandardMaterial;
      // A hero's sword trail and release flash are translucent sheets; a
      // shadow of one would be a solid grey shape on the lane.
      o.castShadow = !mat.transparent;
      o.receiveShadow = true;
      if (asset.teamTint && mat.name === TEAM_MATERIAL && tint !== undefined) {
        // Clone so the two teams do not share one material instance.
        o.material = mat.clone();
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
      // Rescale so the blow lands on the sim's damage tick rather than
      // whenever the artist happened to put the contact frame. attackPointTime
      // is the same helper the sim uses, so attack speed is accounted for.
      const point = attackPointTime(unit.attackPoint, unit.attackSpeedBonus);
      const scale = this.hitTime / Math.max(point, 0.01);
      this.play('Attack', 0.06, scale);
    } else if (!swinging) {
      // Cancelled or finished: 0.12s out is quick enough to read as an
      // interrupted swing without snapping.
      if (this.speed > WALK_EPSILON) {
        const cadence = THREE.MathUtils.clamp(this.speed / unit.moveSpeed, WALK_CADENCE_MIN, WALK_CADENCE_MAX);
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
