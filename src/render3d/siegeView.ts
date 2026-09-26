import * as THREE from 'three';
import type { Unit } from '../sim/types.ts';
import { attackPointTime } from '../sim/constants.ts';
import { TEAM_TINT } from './appearance.ts';

/**
 * The siege creep, drawn as a catapult.
 *
 * Every other unit in the lane shares one humanoid rig with different kit bolted
 * on. A siege creep cannot: it is the one unit whose silhouette in Dota is not a
 * person, and drawing it as a 1.25x box-man threw away the clearest read in the
 * wave. It is also the creep whose timing is most worth recognising — 935 HP, a
 * 3 second attack interval and a 0.7 second wind-up, none of which is true of
 * anything standing next to it.
 *
 * So this is its own view, built from boxes and cylinders with no skeleton. The
 * throwing arm is driven directly off the sim's attack phases rather than an
 * animation clip, which means it is exact by construction: the arm reaches full
 * cock at the instant the wind-up ends, because both read the same
 * `attackPointTime`.
 */

/** Arm angle at rest, radians from vertical. Laid back over the frame. */
const ARM_REST = -0.35;
/** Fully cocked, just before release. */
const ARM_COCKED = -1.5;
/** Follow-through, after the shot is away. */
const ARM_RELEASED = 1.15;

/** Sim units. The frame sits about two thirds the height of a melee creep. */
const WHEEL_R = 26;

export class SiegeView {
  readonly root = new THREE.Group();
  private readonly arm = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  private prevPhase: Unit['phase'] = 'idle';
  private prev = new THREE.Vector3();
  private primed = false;
  private dead = false;
  private fallen = 0;
  /** Eased arm angle, so a cancelled wind-up relaxes instead of snapping. */
  private armAngle = ARM_REST;

  constructor(unit: Unit) {
    const tint = new THREE.Color(TEAM_TINT[unit.team]);
    const wood = this.track(
      new THREE.MeshStandardMaterial({ color: tint.clone().multiplyScalar(0.55).getHex(), roughness: 1, flatShading: true }),
    );
    const timber = this.track(
      new THREE.MeshStandardMaterial({ color: 0x5b4229, roughness: 1, flatShading: true }),
    );
    const iron = this.track(
      new THREE.MeshStandardMaterial({ color: 0x6f7883, roughness: 0.6, metalness: 0.4, flatShading: true }),
    );

    const add = (geom: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) => {
      this.track(geom);
      const m = new THREE.Mesh(geom, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // Chassis: a low deck on an axle, wider across the lane than along it so it
    // reads as a machine facing forward.
    const deck = add(new THREE.BoxGeometry(62, 18, 84), wood, this.root);
    deck.position.y = WHEEL_R + 6;
    const rail = add(new THREE.BoxGeometry(68, 10, 12), timber, this.root);
    rail.position.set(0, WHEEL_R + 20, -34);

    // Uprights the arm pivots between.
    for (const x of [-22, 22]) {
      const post = add(new THREE.BoxGeometry(9, 46, 9), timber, this.root);
      post.position.set(x, WHEEL_R + 34, 4);
    }

    const wheelGeom = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 8, 10);
    this.track(wheelGeom);
    for (const x of [-34, 34]) {
      for (const z of [-28, 28]) {
        const w = new THREE.Mesh(wheelGeom, timber);
        // Cylinders stand on +Y; roll it onto the axle across the machine.
        w.rotation.z = Math.PI / 2;
        w.position.set(x, WHEEL_R, z);
        w.castShadow = true;
        this.root.add(w);
        this.wheels.push(w);
      }
    }

    // The arm pivots at the top of the uprights. Its geometry runs up +Y from
    // the pivot so rotating the group about X swings it fore and aft.
    this.arm.position.set(0, WHEEL_R + 52, 4);
    this.root.add(this.arm);
    const beam = add(new THREE.BoxGeometry(10, 74, 10), timber, this.arm);
    beam.position.y = 37;
    const bucket = add(new THREE.BoxGeometry(26, 18, 26), iron, this.arm);
    bucket.position.y = 76;
    const counterweight = add(new THREE.BoxGeometry(24, 22, 24), iron, this.arm);
    counterweight.position.y = -16;

    this.root.position.set(unit.pos.x, 0, unit.pos.y);
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  /** Drive the view from one frame of sim state. */
  sync(unit: Unit, dt: number) {
    const pos = new THREE.Vector3(unit.pos.x, 0, unit.pos.y);
    if (!this.primed) {
      this.prev.copy(pos);
      this.primed = true;
    }
    const travelled = pos.distanceTo(this.prev);
    this.prev.copy(pos);

    this.root.position.copy(pos);
    // Same mapping the skinned rig uses: model forward is three's +Z, so a sim
    // facing of t is a yaw of PI/2 - t.
    this.root.rotation.y = Math.PI / 2 - unit.facing;

    if (!unit.alive) {
      // No death clip to play, so it sags onto its axle and stops.
      this.dead = true;
      this.fallen = Math.min(1, this.fallen + dt * 2.2);
      this.root.rotation.z = this.fallen * 0.5;
      this.root.position.y = -this.fallen * 14;
      return;
    }

    // Wheels roll with real distance covered, so a stopped machine's wheels
    // stop. dt is not used here on purpose: distance is already per-frame.
    if (travelled > 0) {
      for (const w of this.wheels) w.rotation.x -= travelled / WHEEL_R;
    }

    // The arm is driven by the sim's phases, not by a clip. During the wind-up
    // it winds back in step with the attack point, so it reaches full cock
    // exactly when the shot goes — both sides read the same helper.
    let want = ARM_REST;
    if (unit.phase === 'windup') {
      const total = attackPointTime(unit.attackPoint, unit.attackSpeedBonus);
      const p = THREE.MathUtils.clamp(1 - unit.phaseTimer / Math.max(total, 1e-4), 0, 1);
      want = ARM_REST + (ARM_COCKED - ARM_REST) * p;
    } else if (unit.phase === 'backswing') {
      want = ARM_RELEASED;
    }

    // The release has to be instant — that is the whole read — but everything
    // else eases, so a cancelled wind-up relaxes rather than snapping.
    const snap = this.prevPhase === 'windup' && unit.phase === 'backswing';
    this.armAngle = snap ? want : THREE.MathUtils.damp(this.armAngle, want, 9, dt);
    this.arm.rotation.x = this.armAngle;
    this.prevPhase = unit.phase;
  }

  get clip(): string {
    return this.dead ? 'Death' : this.prevPhase === 'windup' ? 'Attack' : 'Idle';
  }

  get isDead() {
    return this.dead;
  }

  dispose() {
    this.root.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
