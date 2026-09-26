import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { UnitKind } from '../sim/types.ts';

/**
 * Procedural kit for the shared creep rig: weapons, helmets, shields, capes.
 *
 * The rig carries nothing of its own, so one GLB serves every unit in the lane
 * and this file bolts the differences on at load time. Everything is built from
 * boxes, like the rig itself — the point is silhouette, not art.
 *
 * Silhouette is not decoration here. A ranged creep has 300 HP and a melee one
 * 550, and which is which decides whether a swing is a last hit or a wasted
 * one. When both are the same box-man in the same colour at two slightly
 * different scales, that call is being made off a health bar alone. A hood and
 * a bow against a helmet and a sword makes it readable from across the lane,
 * which is what the real game gives you.
 *
 * Everything is authored in the model's own units (the rig is 1.85 tall) and
 * parented to a bone, so the root's MODEL_SCALE and the skeleton's animation
 * both come along for free.
 */

export type WeaponKind = 'sword' | 'bow';

/**
 * Bone to hang each weapon on. The sword takes `armR`, the arm the Attack clip
 * swings; the bow takes `armL`, which stays steady while the swing on the other
 * arm reads as drawing the string.
 *
 * Two traps in those four characters. The names are three's, not Blender's:
 * GLTFLoader runs node names through PropertyBinding.sanitizeNodeName, which
 * strips the dot, so Blender's `arm.R` arrives here as `armR` and looking up
 * the Blender spelling silently finds nothing. And the rig's L/R are the
 * modeller's, not the character's: the figure faces Blender -Y, so `arm.R` at
 * +X is on its *left*. Neither matters as long as the two weapons stay on
 * opposite arms and the sword is on the one that swings.
 */
const HAND_BONE: Record<WeaponKind, string> = { sword: 'armR', bow: 'armL' };

/**
 * Distance from a hand bone's head to its tail, i.e. where the fist is. Both
 * arms run 1.40 -> 0.85 in the Blender rig. In bone-local space +Y points down
 * the bone, so the hand sits at (0, HAND_Y, 0).
 */
const HAND_Y = 0.55;

/**
 * Rest pose in the bone's frame, chosen for the top-down camera. Straight out
 * of the fist the sword points dead level and disappears into the unit's own
 * footprint from above, so `x` shoulders it. The bow stands vertical, which
 * from directly overhead is a dot, so `z` cants it away from the body to give
 * it some width to see.
 */
const REST_POSE: Record<WeaponKind, { x: number; z: number }> = {
  sword: { x: 0.8, z: 0 },
  bow: { x: 0.12, z: 0.35 },
};

/**
 * Bone-local axes at rest, after make_creep.py's `align_roll(FORWARD)`:
 *   +Y  down the arm      +Z  the way the unit faces      +X  its left
 * Weapon geometry below is written in that frame, with the origin moved to the
 * hand, so "forward" is +z and "up" is -y.
 */

const MATS = {
  steel: new THREE.MeshStandardMaterial({ color: 0xb9c4cf, roughness: 0.45, metalness: 0.55, flatShading: true }),
  leather: new THREE.MeshStandardMaterial({ color: 0x2f2621, roughness: 0.95, flatShading: true }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.9, flatShading: true }),
  string: new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.8 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0x3b3038, roughness: 1, flatShading: true }),
  darkSteel: new THREE.MeshStandardMaterial({ color: 0x7c8794, roughness: 0.6, metalness: 0.5, flatShading: true }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd8b45c, roughness: 0.4, metalness: 0.7, flatShading: true }),
};

type Vec3 = [number, number, number];

/**
 * An axis-aligned box in the bone's own frame. Used instead of {@link segment}
 * for armour, where which way the cross-section faces matters: segment() picks
 * the rotation about its own axis for you, which is fine for a blade and wrong
 * for a pauldron.
 */
function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/** A box of cross-section `w` x `h` spanning `a` -> `b`. */
function segment(a: Vec3, b: Vec3, w: number, h: number): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const dir = to.clone().sub(from);
  const len = dir.length();

  const g = new THREE.BoxGeometry(w, h, len);
  const m = new THREE.Matrix4().compose(
    from.clone().add(to).multiplyScalar(0.5),
    // BoxGeometry's depth runs along +Z, so point +Z down the segment.
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return g;
}

/** Merge per material, so each weapon ends up as one mesh with a material array. */
function build(parts: Array<{ geom: THREE.BufferGeometry; mat: THREE.Material }>) {
  const mats = [...new Set(parts.map((p) => p.mat))];
  const ordered = mats.map((m) => parts.filter((p) => p.mat === m).map((p) => p.geom));
  const merged = mergeGeometries(
    ordered.map((group) => mergeGeometries(group, false)!),
    true, // useGroups: one draw group per material, in the order above
  )!;
  return { geometry: merged, materials: mats };
}

function makeSword() {
  return build([
    // Grip and pommel run back out of the fist; the blade runs forward.
    { geom: segment([0, 0, -0.17], [0, 0, 0.0], 0.055, 0.055), mat: MATS.leather },
    { geom: segment([0, 0, -0.2], [0, 0, -0.16], 0.09, 0.09), mat: MATS.steel },
    { geom: segment([-0.16, 0, 0.02], [0.16, 0, 0.02], 0.06, 0.06), mat: MATS.steel },
    { geom: segment([0, 0, 0.03], [0, 0, 0.64], 0.12, 0.05), mat: MATS.steel },
    // Separate, thinner tip box: boxes cannot taper, and a blunt-ended blade
    // reads as a plank at this size.
    { geom: segment([0, 0, 0.64], [0, 0, 0.8], 0.06, 0.04), mat: MATS.steel },
  ]);
}

function makeBow() {
  // Limb profile from the top tip down, mirrored through the grip. The belly of
  // the bow is forward (+z) and the tips come back toward the archer, so the
  // string can run straight down the near side.
  const limb: Vec3[] = [
    [0, -0.46, 0.0],
    [0, -0.3, 0.09],
    [0, -0.12, 0.14],
    [0, 0.12, 0.14],
    [0, 0.3, 0.09],
    [0, 0.46, 0.0],
  ];
  const parts = [];
  for (let i = 0; i < limb.length - 1; i++) {
    // Thinner toward the tips, which is what makes it read as a bow rather
    // than a bent stick.
    const taper = i === 0 || i === limb.length - 2 ? 0.045 : 0.062;
    parts.push({ geom: segment(limb[i], limb[i + 1], taper, taper), mat: MATS.wood });
  }
  parts.push({ geom: segment([0, -0.1, 0.14], [0, 0.1, 0.14], 0.07, 0.08), mat: MATS.leather });
  parts.push({ geom: segment(limb[0], limb[limb.length - 1], 0.016, 0.016), mat: MATS.string });
  return build(parts);
}

/**
 * Head and body kit, in the bone frames described above. For `head` and `spine`
 * the bone runs straight up, so local +Y is up, +Z is the way the unit faces
 * and +X is its left. The head bone is 0.4 long, so its tail — the crown of the
 * skull — sits at y = 0.4.
 */

/**
 * Crested helm: the melee creep reads as armoured and front-heavy.
 *
 * Kept narrower than the skull on purpose. The camera looks down the lane at a
 * 57 degree pitch, so a cap sized to the head is a plate covering the whole
 * unit from above and the team colour underneath disappears. The crest does the
 * identifying instead — a fore-and-aft ridge is exactly what stays readable
 * from up there.
 */
function makeHelm() {
  return build([
    { geom: box(0.34, 0.12, 0.34, 0, 0.33, 0), mat: MATS.darkSteel },
    // A brow that overhangs the face is most of what makes a box read as a helm.
    { geom: box(0.36, 0.07, 0.1, 0, 0.26, 0.16), mat: MATS.darkSteel },
    { geom: box(0.07, 0.17, 0.44, 0, 0.46, -0.02), mat: MATS.steel },
  ]);
}

/** Peaked hood: the ranged creep reads as a robed caster, not a soldier. */
function makeHood() {
  return build([
    { geom: box(0.36, 0.42, 0.16, 0, 0.24, -0.14), mat: MATS.cloth },
    { geom: box(0.3, 0.26, 0.3, 0, 0.3, 0.0), mat: MATS.cloth },
    // The peak leans forward, which is what separates a hood from a bucket.
    { geom: box(0.12, 0.26, 0.18, 0, 0.5, 0.05), mat: MATS.cloth },
  ]);
}

/** A three-pointed crown, so the hero is the tallest thing in the lane. */
function makeCrown() {
  const parts = [{ geom: box(0.4, 0.09, 0.4, 0, 0.3, 0), mat: MATS.gold }];
  for (const x of [-0.15, 0, 0.15]) {
    const h = x === 0 ? 0.3 : 0.2;
    parts.push({ geom: box(0.07, h, 0.07, x, 0.34 + h / 2, -0.04), mat: MATS.gold });
  }
  return build(parts);
}

/** Pauldrons on the spine bone: width at the shoulder line. */
function makePauldrons(big: boolean) {
  const w = big ? 0.2 : 0.16;
  const parts = [];
  for (const x of [-1, 1]) {
    parts.push({ geom: box(w, 0.13, 0.3, x * 0.3, 0.33, 0), mat: MATS.darkSteel });
  }
  return build(parts);
}

/** A cape hanging off the hero's back. Nothing else in the lane has one. */
function makeCape() {
  return build([
    { geom: box(0.46, 0.72, 0.05, 0, 0.04, -0.21), mat: MATS.cloth },
    { geom: box(0.5, 0.1, 0.1, 0, 0.36, -0.18), mat: MATS.leather },
  ]);
}

/** A round-ish shield for the melee creep's off hand. */
function makeShield() {
  return build([
    { geom: box(0.06, 0.4, 0.34, 0.06, 0, 0.04), mat: MATS.wood },
    { geom: box(0.04, 0.44, 0.1, 0.07, 0, 0.04), mat: MATS.darkSteel },
    { geom: box(0.05, 0.12, 0.12, 0.09, 0, 0.04), mat: MATS.steel },
  ]);
}

type KitPart = 'sword' | 'bow' | 'helm' | 'hood' | 'crown' | 'pauldrons' | 'bigPauldrons' | 'cape' | 'shield';

const MAKERS: Record<KitPart, () => ReturnType<typeof build>> = {
  sword: makeSword,
  bow: makeBow,
  helm: makeHelm,
  hood: makeHood,
  crown: makeCrown,
  pauldrons: () => makePauldrons(false),
  bigPauldrons: () => makePauldrons(true),
  cape: makeCape,
  shield: makeShield,
};

/** Bone each part hangs on, and how far down that bone it sits. */
const MOUNT: Record<KitPart, { bone: string; y: number }> = {
  sword: { bone: HAND_BONE.sword, y: HAND_Y },
  bow: { bone: HAND_BONE.bow, y: HAND_Y },
  helm: { bone: 'head', y: 0 },
  hood: { bone: 'head', y: 0 },
  crown: { bone: 'head', y: 0 },
  pauldrons: { bone: 'spine', y: 0 },
  bigPauldrons: { bone: 'spine', y: 0 },
  cape: { bone: 'spine', y: 0 },
  shield: { bone: HAND_BONE.bow, y: HAND_Y },
};

/** Built once and shared: every unit of a kind draws the same geometry. */
const CACHE = new Map<KitPart, ReturnType<typeof build>>();

function asset(kind: KitPart) {
  let a = CACHE.get(kind);
  if (!a) {
    a = MAKERS[kind]();
    CACHE.set(kind, a);
  }
  return a;
}

/**
 * Hang one part on its bone. Returns false when the bone is missing, which
 * means the GLB was exported from a rig this code does not know.
 */
function attachPart(rig: THREE.Object3D, kind: KitPart): boolean {
  const mount = MOUNT[kind];
  const bone = rig.getObjectByName(mount.bone);
  if (!bone) return false;

  const a = asset(kind);
  const mesh = new THREE.Mesh(a.geometry, a.materials);
  mesh.position.y = mount.y;
  const rest = REST_POSE[kind as WeaponKind];
  if (rest) mesh.rotation.set(rest.x, 0, rest.z);
  mesh.castShadow = true;
  // Kit is deliberately not team-tinted: steel, wood and cloth are how you tell
  // a swordsman from an archer at this camera distance, and tinting flattens
  // every one of them back into the team colour the body already carries.
  bone.add(mesh);
  return true;
}

/** What each kind of unit wears. */
function kitFor(kind: UnitKind, ranged: boolean): KitPart[] {
  if (kind === 'hero') return [ranged ? 'bow' : 'sword', 'crown', 'bigPauldrons', 'cape'];
  if (kind === 'ranged_creep') return ['bow', 'hood'];
  // The siege creep is not drawn on this rig at all; see SiegeView.
  if (kind === 'siege_creep') return [];
  return ['sword', 'shield', 'helm', 'pauldrons'];
}

/**
 * Dress `rig` for `unit`. Ranged/melee is read off the sim the same way
 * everything else in the renderer is — a unit that spawns projectiles shoots,
 * one that hits instantly swings.
 *
 * Returns false if the rig has no bones to hang anything on.
 */
export function attachKit(rig: THREE.Object3D, kind: UnitKind, projectileSpeed: number): boolean {
  let ok = true;
  for (const part of kitFor(kind, projectileSpeed > 0)) {
    if (!attachPart(rig, part)) ok = false;
  }
  return ok;
}
