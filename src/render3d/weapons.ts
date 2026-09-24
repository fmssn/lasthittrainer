import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural weapons for the shared creep rig.
 *
 * The rig carries no weapon of its own, so one GLB serves melee and ranged
 * units: this file bolts a sword or a bow onto a hand bone at load time. Both
 * are built from boxes, like the rig itself — the point is silhouette, not art.
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
};

type Vec3 = [number, number, number];

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

/** Built once and shared: every unit of a kind draws the same geometry. */
const CACHE = new Map<WeaponKind, ReturnType<typeof build>>();

function asset(kind: WeaponKind) {
  let a = CACHE.get(kind);
  if (!a) {
    a = kind === 'sword' ? makeSword() : makeBow();
    CACHE.set(kind, a);
  }
  return a;
}

/**
 * Hang a weapon on `rig`'s hand bone. Returns false when the bone is missing,
 * which means the GLB was exported from a rig this code does not know.
 */
export function attachWeapon(rig: THREE.Object3D, kind: WeaponKind): boolean {
  const bone = rig.getObjectByName(HAND_BONE[kind]);
  if (!bone) return false;

  const mesh = new THREE.Mesh(asset(kind).geometry, asset(kind).materials);
  mesh.position.y = HAND_Y;
  mesh.rotation.set(REST_POSE[kind].x, 0, REST_POSE[kind].z);
  mesh.castShadow = true;
  // Weapons are deliberately not team-tinted: steel and wood are how you tell a
  // sword from a bow at this camera distance, and tinting flattens both.
  bone.add(mesh);
  return true;
}
