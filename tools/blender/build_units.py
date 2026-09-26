"""
Build the unit GLBs the runtime loads from the KayKit character packs.

Run headless, after tools/fetch_assets.sh has put Blender and the packs in tools/.cache/:
    blender --background --python tools/blender/build_units.py -- [--only melee_creep] [--renders DIR]

One entry in UNITS is one look. For each entry the script imports the KayKit
character, strips the weapons it does not use, bolts on the ones it does, joins
every part into one skinned mesh (one draw call per material), keeps four clips
renamed to Idle / Walk / Attack / Death, finds the attack's contact time and the
walk's ground speed, then writes a Radiant and a Dire copy with a recoloured
atlas:

    public/models/units/<id>_<team>.glb

The contact time is stored on the Attack action as the custom property
"hitTime" (seconds from the start of the clip), and the Walk clip's ground
speed (m/s its planted feet slide back at, at its authored rate) as
"groundSpeed". Blender 5.2 writes action custom properties to glTF
animations[i].extras, which GLTFLoader copies onto AnimationClip.userData, so
the runtime reads clip.userData.hitTime and clip.userData.groundSpeed.

Blender's export is then compacted (compact_glb): channels that only restate
the rest pose are dropped, and UVs, weights and normals are stored as
normalized integers. Normals use KHR_mesh_quantization, which GLTFLoader reads
natively, so the runtime needs no decoder. Every file is checked from its own
glTF JSON and data afterwards (GLB_REPORT), and the script exits non-zero if
any file breaks the contract the runtime relies on. Two builds are
byte-identical.

--renders DIR writes verification images: <id>_<team>_sheet.png (Attack at
t=0, mid-windup, contact and end; a Walk frame; the last Death frame) and
<id>_teams.png (Radiant beside Dire from the game camera, at game scale and
closer). Workbench needs an OpenGL context: on a machine without a display, run
Blender under `xvfb-run -a`.
"""

import argparse
import json
import math
import os
import struct
import sys

import bpy
import numpy as np
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(REPO, "tools", ".cache")
PACKS = {
    "skeletons": os.path.join(CACHE, "kaykit-Skeletons", "addons", "kaykit_character_pack_skeletons"),
    "adventures": os.path.join(CACHE, "kaykit-Adventures", "addons", "kaykit_character_pack_adventures"),
}
OUT_DIR = os.path.join(REPO, "public", "models", "units")

# KayKit keys its clips at 30 fps (Idle is 33 keys over 1.0667 s). Importing at
# Blender's default 24 puts every key on a fractional frame and the exporter
# then resamples them on whole frames, which shifts clip ends by up to 20 ms.
# At 30 each key lands on a frame and the export reproduces the source keys.
FPS = 30

HANDSLOTS = ("handslot.r", "handslot.l")

# All nine KayKit characters share this rig, IK and control bones included.
JOINTS = 41
CLIPS = ("Idle", "Walk", "Attack", "Death")
BUDGET_BYTES = 400 * 1024
# How far a handslot at Idle t=0 may sit from where it is on Attack's first
# and last frames. Every idle that matches its attack does so exactly; these
# only absorb noise.
SEAM_METRES = 0.02
SEAM_DEGREES = 3.0
# How far above its rest height the ball of a foot may be and still count as
# on the ground, for ground_speed().
PLANT_METRES = 0.02
# The most a joint may turn between neighbouring keys of a clip. KayKit's own
# clips peak at 67 deg a frame (the chop's knee); a step past this is a sign
# slip in an edited channel, which three plays as a spin in one frame.
KEY_STEP_DEGREES = 90.0

# Where a weapon sits relative to its handslot joint, in glTF terms:
# (joint, translation, rotation as x, y, z, w). Not identity: these are copied
# from the local transforms KayKit gives its own in-pack weapons (read from the
# character GLB JSON), so an attached Skeletons weapon is held exactly like the
# Adventurers' built-in ones. Right-hand items are turned 180 deg about the
# handslot's Y (the grip axis), because one mesh serves both hands and the two
# handslots are mirror images of each other.
GRIPS = {
    # Knight.glb 1H_Sword, Barbarian.glb 1H_Axe: 3.3 cm up the grip axis.
    "sword.r": ("handslot.r", (0.0, 0.0333, 0.0), (0.0, -1.0, 0.0, 0.0)),
    # Mage.glb 2H_Staff: same turn, held at its origin (the staff's middle).
    "staff.r": ("handslot.r", (0.0, 0.0, 0.0), (0.0, -1.0, 0.0, 0.0)),
    # Knight.glb Round_Shield and the other shields: no turn, 15.6 cm out along
    # Z so the boss sits over the forearm instead of inside the fist.
    "shield.l": ("handslot.l", (0.0, 0.0170, 0.1559), (0.0, 0.0, 0.0, 1.0)),
}

# The importer converts mesh data from glTF Y-up to Blender Z-up, which turns a
# bone-parented object's own frame -90 deg about X relative to the joint.
# Measured on the in-pack weapons: blender_rel = T @ R_gltf @ this.
MESH_FRAME = Matrix.Rotation(-math.pi / 2, 4, "X")

# Team colours. `hue` (degrees) is where team cloth is pushed; `glow` is the
# Skeletons' eye emissive. The lane is a dull yellow-green (hue ~97, saturation
# 0.3), so team green separates from it by saturation, not hue. Red is a clean
# red rather than the skeletons' own maroon (hue 344), so Dire creeps change too.
TEAMS = {
    "radiant": {"hue": 118.0, "glow": (0.35, 1.0, 0.22)},
    "dire": {"hue": 2.0, "glow": (1.0, 0.16, 0.06)},
}

# Team cloth rules (see recolour()). Hue bands are degrees, lo > hi wraps
# through 0; cells are 128 px atlas cells, column and row from the top left.
# Everything no rule claims (bone, steel, skin, hair, wood) keeps its colour.
# The numbers come from the atlas cells each mesh actually samples.
CELL = 128

# Skeletons atlas. Maroon is the cloak, hood, robe, hat and horn bands. Leather
# is straps, belts and grip wraps; bone is hue 29-30 with up to 0.49
# saturation in its shadowed half, so the leather band must stop short of it.
SK_MAROON = {"hues": (320.0, 8.0), "min_sat": 0.3}
SK_LEATHER = {"hues": (8.0, 22.0), "min_sat": 0.3}
# The warrior's helmet dome is the biggest thing on it seen from the lane
# camera, and it is dull brown leather in the same colour as the boots, so no
# hue/saturation rule can pick it out. Only the helmet and the blade's grip
# sample these cells.
WARRIOR_DOME = {"cells": [(6, 4), (6, 5)]}

# Each entry: id (the creep kind; heroes and the siege catapult are drawn by
# the runtime without these files), pack,
# character (GLB under Characters/gltf), keep (in-pack weapon meshes to keep;
# every other handslot mesh is deleted), attach (Skeletons Assets weapons and
# the grip they go in), clips (runtime name -> KayKit clip), grip_from_attack
# (optional runtime clips whose handslot.r is keyed to the Attack's opening
# grip, see hold_attack_grip()), hit_time (optional override, seconds),
# return_from (optional, seconds: the Attack's tail from there on is blended
# back to its first frame, see return_to_start()), cloth (team recolour rules,
# see recolour()), shade (optional grading of everything the rules leave alone).
UNITS = [
    # --- Creeps (Skeletons pack) ----------------------------------------------
    {
        "id": "melee_creep",
        "pack": "skeletons",
        "character": "Skeleton_Warrior",
        "keep": [],
        # The small shield gives the melee creep a front-on silhouette distinct
        # from the ranged creep's staff.
        "attach": [("Skeleton_Blade", "sword.r"), ("Skeleton_Shield_Small_A", "shield.l")],
        # Running_A: lane creeps move at 325, as fast as a
        # hero, and Walking_A's planted foot covers only 0.74 m/s, so a walk
        # would slide over most of the ground it crosses. The run keeps the
        # feet planted inside the runtime's cadence clamp.
        "clips": {"Idle": "Idle", "Walk": "Running_A", "Attack": "1H_Melee_Attack_Chop", "Death": "Death_A"},
        "cloth": [SK_MAROON, SK_LEATHER, WARRIOR_DOME],
    },
    {
        "id": "ranged_creep",
        "pack": "skeletons",
        "character": "Skeleton_Mage",
        "keep": [],
        # The rig holds a staff head-down at idle and head-first at the cast;
        # KayKit's own Mage staff does the same, and the cast is what matters.
        "attach": [("Skeleton_Staff", "staff.r")],
        "clips": {"Idle": "Idle", "Walk": "Running_A", "Attack": "Spellcast_Shoot", "Death": "Death_A"},
        "cloth": [SK_MAROON, SK_LEATHER],
    },
]


# --- Scene ------------------------------------------------------------------

def reset_scene():
    """read_factory_settings(use_empty=True) is not reliably empty across Blender
    versions, so delete whatever it leaves behind explicitly."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    return scene


def import_gltf(path):
    """Import a glTF and return the objects it created.

    disable_bone_shape stops the importer from building its Icosphere bone
    display shape; any Icosphere that still appears is deleted, because it is an
    importer artefact and must never reach an export."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)
    new = [o for o in bpy.data.objects if o not in before]
    for obj in [o for o in new if o.name.startswith("Icosphere")]:
        new.remove(obj)
        delete_object(obj)
    return new


def delete_object(obj):
    data = obj.data if obj.type == "MESH" else None
    bpy.data.objects.remove(obj, do_unlink=True)
    if data is not None and data.users == 0:
        bpy.data.meshes.remove(data)


def purge_orphans():
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


# --- Build steps --------------------------------------------------------------

def pack_path(pack, *parts):
    return os.path.join(PACKS[pack], *parts)


def import_character(spec):
    path = pack_path(spec["pack"], "Characters", "gltf", spec["character"] + ".glb")
    objs = import_gltf(path)
    rigs = [o for o in objs if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise SystemExit(f"{spec['id']}: expected one armature in {path}, got {len(rigs)}")
    return rigs[0]


def handslot_meshes(rig):
    return [o for o in rig.children
            if o.type == "MESH" and o.parent_type == "BONE" and o.parent_bone in HANDSLOTS]


def strip_weapons(rig, keep):
    """Weapons are the meshes parented to a handslot bone. Hats, capes and
    helmets hang off head/chest and stay."""
    present = {o.name for o in handslot_meshes(rig)}
    missing = set(keep) - present
    if missing:
        raise SystemExit(f"weapons {sorted(missing)} not in character (has {sorted(present)})")
    for obj in handslot_meshes(rig):
        if obj.name not in keep:
            delete_object(obj)


def attach_weapon(rig, asset, grip_name):
    """Import a Skeletons Assets weapon and parent it to a handslot bone so the
    exported node carries exactly the grip transform in GRIPS."""
    bone, t, q = GRIPS[grip_name]
    objs = [o for o in import_gltf(pack_path("skeletons", "Assets", "gltf", asset + ".gltf"))
            if o.type == "MESH"]
    if len(objs) != 1:
        raise SystemExit(f"{asset}: expected one mesh, got {[o.name for o in objs]}")
    weapon = objs[0]
    weapon.name = asset
    weapon.data.name = asset  # instead of the asset file's "Cube.007"

    # The asset brings its own copy of the shared atlas ("skeleton.001" with
    # "skeleton_texture.001"). Point it at the character's material so the file
    # carries one material and one image, after checking the two really are
    # the same texture.
    body_mats = {m.name: m for o in rig.children if o.type == "MESH" for m in o.data.materials if m}
    for slot in weapon.material_slots:
        base = slot.material.name.split(".")[0]
        if base not in body_mats:
            raise SystemExit(f"{asset}: material {slot.material.name} has no match on the body")
        if atlas_image(slot.material).packed_file.data != atlas_image(body_mats[base]).packed_file.data:
            raise SystemExit(f"{asset}: its {base} atlas differs from the character's")
        slot.material = body_mats[base]
    purge_orphans()

    # Pose the rig at rest so pose_bone.matrix is the joint's rest frame; the
    # glTF translation maps straight onto the Blender bone frame (the importer's
    # BLENDER bone heuristic keeps joint axes), only the mesh frame needs the
    # Y-up correction.
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    weapon.parent = rig
    weapon.parent_type = "BONE"
    weapon.parent_bone = bone
    rot = Quaternion((q[3], q[0], q[1], q[2])).to_matrix().to_4x4()
    weapon.matrix_world = (rig.matrix_world @ rig.pose.bones[bone].matrix
                           @ Matrix.Translation(t) @ rot @ MESH_FRAME)
    rig.data.pose_position = "POSE"
    bpy.context.view_layer.update()
    return weapon


def join_meshes(rig, name):
    """Make the look one skinned mesh. KayKit ships every character as 8-12
    parts on one atlas, and three draws each part in its own call, twice with
    shadows on: a busy lane reached ~390 calls. Joined, a look is one call per
    material (the Skeletons' eyes have their own).

    Rigid parts (hats, helmets, capes, weapons) hang off a bone; each is put in
    that bone's vertex group at weight 1, which moves it exactly as the bone
    parent did. Done in the rest pose, so the bind pose is where the parts
    were. Returns each rigid part's name, bone and rest bounds in glTF axes
    (Y up, Z = -Blender Y), for the report to find it again in the file."""
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    parts = sorted((o for o in rig.children if o.type == "MESH"), key=lambda o: o.name)
    skinned = [o for o in parts if o.parent_type == "OBJECT" and
               any(m.type == "ARMATURE" and m.object == rig for m in o.modifiers)]
    if not skinned:
        raise SystemExit(f"{name}: no skinned part to join into")
    rigid = {}
    for obj in parts:
        if obj in skinned:
            continue
        if obj.parent_type != "BONE":
            raise SystemExit(f"{name}: {obj.name} is neither skinned nor on a bone")
        world = obj.matrix_world.copy()
        pts = np.array([tuple(world @ v.co) for v in obj.data.vertices])
        rigid[obj.name] = {"bone": obj.parent_bone,
                           "min": [float(pts[:, 0].min()), float(pts[:, 2].min()), float(-pts[:, 1].max())],
                           "max": [float(pts[:, 0].max()), float(pts[:, 2].max()), float(-pts[:, 1].min())]}
        bone = obj.parent_bone
        obj.parent_type = "OBJECT"
        obj.parent_bone = ""
        obj.matrix_world = world
        obj.vertex_groups.new(name=bone).add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    body = skinned[0]
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = name
    body.data.name = name
    rig.data.pose_position = "POSE"
    bpy.context.view_layer.update()
    return rigid


def set_action(rig, action):
    ad = rig.animation_data or rig.animation_data_create()
    ad.action = action
    # Blender 4.4+ slotted actions: make sure the rig's slot is bound, or the
    # action evaluates to nothing.
    if action is not None and getattr(ad, "action_slot", True) is None and action.slots:
        ad.action_slot = action.slots[0]


def keep_clips(rig, clips):
    """Keep the four chosen actions under their runtime names and delete the rest,
    which is ~95% of each source file."""
    wanted = {}
    for runtime_name, source in clips.items():
        act = bpy.data.actions.get(source)
        if act is None:
            raise SystemExit(f"clip {source} not in character")
        wanted[source] = runtime_name
    set_action(rig, None)
    for act in list(bpy.data.actions):
        if act.name not in wanted:
            bpy.data.actions.remove(act)
    if rig.animation_data:
        for track in list(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(track)
    out = {}
    # Two passes so a rename can never collide with a source name still in use.
    for act in list(bpy.data.actions):
        act.name = "__" + wanted[act.name]
    for act in list(bpy.data.actions):
        act.name = act.name[2:]
        act.use_fake_user = True  # required for glTF 'ACTIONS' export mode
        out[act.name] = act
    return out


def channelbag(action):
    return anim_utils.action_get_channelbag_for_slot(action, action.slots[0])


def hold_attack_grip(acts, clips, bone="handslot.r"):
    """Key `bone` in each of `clips` to its transform on the Attack's first
    frame, held for the whole clip. The handslot is the weapon's grip: KayKit's
    generic clips hold every weapon the same way, and the attack clips turn it
    for the weapon they were made for."""
    attack = acts["Attack"]
    prefix = f'pose.bones["{bone}"].'
    grip = {(fc.data_path, fc.array_index): fc.evaluate(attack.frame_range[0])
            for fc in channelbag(attack).fcurves if fc.data_path.startswith(prefix)}
    for name in clips:
        curves = {(fc.data_path, fc.array_index): fc
                  for fc in channelbag(acts[name]).fcurves if fc.data_path.startswith(prefix)}
        if set(curves) != set(grip):
            raise SystemExit(f"{name}: {bone} channels {sorted(curves)} differ from Attack's {sorted(grip)}")
        for key, fc in curves.items():
            for kp in fc.keyframe_points:
                kp.co.y = grip[key]
                kp.handle_left.y = grip[key]
                kp.handle_right.y = grip[key]
            fc.update()


def return_to_start(action, from_t):
    """Blend `action` from `from_t` seconds to its last frame into the pose on
    its first frame, so the clip ends where it starts. Every channel is re-keyed
    on each frame of the tail with a smoothstep weight, which leaves the
    authored motion without a jump and arrives at rest. Quaternions blend
    towards whichever sign of the start is nearer the tail's first key, the
    same sign for the whole tail, and are renormalised. Keys up to from_t are
    left alone."""
    f0, f1 = action.frame_range
    fa = from_t * FPS
    if abs(fa - round(fa)) > 1e-6 or not f0 < fa < f1:
        raise SystemExit(f"{action.name}: return_from {from_t} is not a frame inside the clip")
    fa = int(round(fa))
    frames = range(fa, int(f1) + 1)
    groups = {}
    for fc in channelbag(action).fcurves:
        groups.setdefault(fc.data_path, {})[fc.array_index] = fc
    for path, group in groups.items():
        fcs = [group[i] for i in sorted(group)]
        start = np.array([fc.evaluate(f0) for fc in fcs])
        authored = np.array([[fc.evaluate(f) for fc in fcs] for f in frames])
        if np.abs(authored - start).max() <= 1e-9:
            continue
        quat = path.endswith("rotation_quaternion")
        target = start
        if quat:
            # Pick the target's sign once, from a sign-continuous tail. Picked
            # per frame, it flips wherever the tail passes 180 deg from the
            # start pose, and the blend jumps there (sniper's handIK.l: 163 deg
            # in one frame).
            for k in range(1, len(authored)):
                if np.dot(authored[k], authored[k - 1]) < 0:
                    authored[k] = -authored[k]
            if np.dot(authored[0], start) < 0:
                target = -start
        prev = authored[0]
        for f, v in zip(frames[1:], authored[1:]):
            s = (f - fa) / (f1 - fa)
            w = s * s * (3 - 2 * s)
            v = v * (1 - w) + target * w
            if quat:
                v = v / np.linalg.norm(v)
                # Keep neighbouring keys in one hemisphere: Blender
                # interpolates the components, not the rotation.
                v = v if np.dot(v, prev) >= 0 else -v
                prev = v
            for fc, x in zip(fcs, v):
                fc.keyframe_points.insert(f, float(x), options={"REPLACE", "FAST"})
        for fc in fcs:
            # New keys take the user default (Bezier); the clip is linear.
            for kp in fc.keyframe_points:
                if kp.co.x > fa:
                    kp.interpolation = "LINEAR"
            fc.update()


def sample_hands(rig, action, step=0.25):
    """Speed of each handslot, in m/s, sampled every `step` frames. The speed
    over (f - step, f] is stamped at f."""
    scene = bpy.context.scene
    set_action(rig, action)
    f0, f1 = action.frame_range
    series = {h: [] for h in HANDSLOTS}
    prev = {}
    f = f0
    while f <= f1 + 1e-6:
        scene.frame_set(int(f), subframe=f - int(f))
        for h in HANDSLOTS:
            p = rig.matrix_world @ rig.pose.bones[h].head
            if h in prev:
                series[h].append((f / FPS, (p - prev[h]).length * FPS / step))
            prev[h] = p.copy()
        f += step
    return series


def detect_contact(rig, action):
    """The contact is the end of the fast stroke: take whichever hand has the
    higher peak speed, and return the first sample after that peak where its
    speed falls below 40% of the peak. For a swing that is the moment the blade
    stops at the target; for a cast or shot it is the end of the thrust, where
    the projectile leaves. Samples are a quarter of a 30 fps frame apart, which
    is 1/120 s, the sim's own tick."""
    series = sample_hands(rig, action)
    hand = max(series, key=lambda h: max(s for _, s in series[h]))
    s = series[hand]
    i = max(range(len(s)), key=lambda k: s[k][1])
    j = next((k for k in range(i, len(s)) if s[k][1] < 0.4 * s[i][1]), None)
    if j is None:
        raise SystemExit(f"{action.name}: {hand} never slows after its peak")
    return {"hand": hand, "peak_t": round(s[i][0], 3), "peak_speed": round(s[i][1], 2),
            "contact": round(s[j][0], 3)}


def ground_speed(rig, action, step=0.25):
    """How fast the ground passes under the in-place Walk clip at its authored
    rate, in m/s: the speed a planted foot slides backwards. The runtime divides
    the sim's speed by this (times its scale) to get the clip's time scale, so a
    foot on the ground stays put when the two agree.

    A foot counts as planted while the ball of the foot (the toes joint) is
    within PLANT_METRES of its rest height; forward is Blender -Y, so the
    backward speed is +Y. The median over every planted sample of both feet
    rides over heel strike and push-off, where the ball is low but not yet (or
    no longer) carrying weight: on Walking_A those run from -0.4 to 1.9 m/s
    around a stance of 0.74. A run is planted for a few samples per step, all
    within 10% of each other."""
    scene = bpy.context.scene
    feet = ("toes.l", "toes.r")
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    rest = {b: (rig.matrix_world @ rig.pose.bones[b].head).z for b in feet}
    rig.data.pose_position = "POSE"
    set_action(rig, action)
    f0, f1 = action.frame_range
    prev, speeds = {}, []
    f = f0
    while f <= f1 + 1e-6:
        scene.frame_set(int(f), subframe=f - int(f))
        for b in feet:
            p = rig.matrix_world @ rig.pose.bones[b].head
            planted = p.z < rest[b] + PLANT_METRES
            if planted and prev.get(b) is not None:
                speeds.append((p.y - prev[b]) * FPS / step)
            prev[b] = p.y if planted else None
        f += step
    if len(speeds) < 8:
        raise SystemExit(f"{action.name}: only {len(speeds)} planted-foot samples")
    speeds.sort()
    speed = round(speeds[len(speeds) // 2], 3)
    if speed <= 0:
        raise SystemExit(f"{action.name}: planted feet move forwards ({speed} m/s)")
    return speed


# --- Team colours -------------------------------------------------------------

def atlas_image(material):
    for node in material.node_tree.nodes:
        if node.type == "TEX_IMAGE" and node.image is not None:
            return node.image
    raise SystemExit(f"material {material.name} has no image texture")


def rgb_to_hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    safe = np.where(d > 1e-6, d, 1.0)
    h = np.where(mx == r, ((g - b) / safe) % 6.0,
                 np.where(mx == g, (b - r) / safe + 2.0, (r - g) / safe + 4.0))
    h = np.where(d > 1e-6, h * 60.0, 0.0)
    s = np.where(mx > 1e-6, d / np.where(mx > 1e-6, mx, 1.0), 0.0)
    return h, s, mx


def hsv_to_rgb(h, s, v):
    c = v * s
    hp = (h % 360.0) / 60.0
    x = c * (1 - np.abs(hp % 2 - 1))
    z = np.zeros_like(c)
    sector = np.floor(hp).astype(np.int32) % 6
    table = [(c, x, z), (x, c, z), (z, c, x), (z, x, c), (x, z, c), (c, z, x)]
    rgb = np.zeros(h.shape + (3,), dtype=np.float32)
    for k, (r, g, b) in enumerate(table):
        m = sector == k
        rgb[m] = np.stack([r[m], g[m], b[m]], -1)
    return rgb + (v - c)[..., None]


def in_band(h, band):
    lo, hi = band
    return ((h >= lo) & (h < hi)) if lo <= hi else ((h >= lo) | (h < hi))


def cell_slice(rows, col, row):
    # Blender stores pixel rows bottom-up; atlas cells are counted from the top.
    return slice(rows - (row + 1) * CELL, rows - row * CELL), slice(col * CELL, (col + 1) * CELL)


def recolour(pixels, team_hue, rules, shade=None):
    """Push team-cloth pixels to the team hue, keeping each pixel's value so the
    atlas's baked gradients and highlight strips survive. The pixels are the
    sRGB-encoded bytes / 255, so the maths works on the colours as painted.

    Each rule claims the pixels in its hue band that are at least `min_sat`
    saturated and at most `max_value` bright, or the whole of its `cells`, and
    minus its `except_cells`. Claimed pixels get the team hue (or the rule's
    own `hue`, for a part that must not read as either team), saturation of at
    least `sat_floor` (KayKit's dustier cloth, like the barbarian's 0.4 blue,
    would otherwise come out a grey-green nobody reads as a team) and their
    value times `value`. The first rule to claim a pixel wins. `shade` grades
    every unclaimed pixel. Returns the pixels and the fraction that took the
    team hue."""
    rgb = pixels[..., :3]
    h, s, v = rgb_to_hsv(rgb)
    rows = pixels.shape[0]
    claimed = np.zeros(h.shape, dtype=bool)
    team = np.zeros(h.shape, dtype=bool)
    out_h, out_s, out_v = h.copy(), s.copy(), v.copy()
    for rule in rules:
        if "cells" in rule:
            m = np.zeros(h.shape, dtype=bool)
            for cell in rule["cells"]:
                m[cell_slice(rows, *cell)] = True
        else:
            m = in_band(h, rule["hues"]) & (s >= rule.get("min_sat", 0.3)) & (v <= rule.get("max_value", 1.0))
        for cell in rule.get("except_cells", []):
            m[cell_slice(rows, *cell)] = False
        m &= ~claimed
        out_h[m] = rule.get("hue", team_hue)
        out_s[m] = np.maximum(s[m], rule.get("sat_floor", 0.6))
        out_v[m] = np.clip(v[m] * rule.get("value", 1.0), 0.0, 1.0)
        claimed |= m
        if "hue" not in rule:
            team |= m
    if shade:
        out_v[~claimed] = v[~claimed] * shade["value"]
        out_s[~claimed] = s[~claimed] * shade["sat"]
    out = pixels.copy()
    out[..., :3] = hsv_to_rgb(out_h, out_s, out_v)
    return out, float(team.mean())


def paint_team(spec, material, base_pixels, size, team):
    """Swap the material's atlas for a recoloured, packed copy."""
    w, h = size
    pixels, coverage = recolour(base_pixels, TEAMS[team]["hue"], spec["cloth"], spec.get("shade"))
    name = f"{spec['id']}_{team}"
    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    # alpha=False: the atlas is opaque, and an RGB PNG is a quarter smaller.
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.pixels.foreach_set(pixels.ravel())
    img.pack()
    for node in material.node_tree.nodes:
        if node.type == "TEX_IMAGE":
            node.image = img
    return coverage


def paint_glow(team):
    """The Skeletons' eyes use a separate untextured 'Glow' material. KayKit
    leaves its base colour at glTF's default white metal, and under the lane's
    sun that adds a white sheen over the emissive, which turned Dire's red
    eyes salmon in the game. A black base leaves only the glow, lit or not."""
    mat = bpy.data.materials.get("Glow")
    if mat is None:
        return False
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    bsdf.inputs["Emission Color"].default_value = (*TEAMS[team]["glow"], 1.0)
    return True


# --- Export and report -------------------------------------------------------------

def export(rig, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    set_action(rig, None)
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    for child in rig.children:
        child.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_extras=True,
        export_yup=True,
        export_apply=False,
        # All 41 joints: the handslots are not deform bones, and the weapons
        # hang off them.
        export_def_bones=False,
        # Keep constant channels. The exporter's own optimiser would drop them
        # without checking them against the rest pose; compact_glb() drops only
        # the ones that restate it.
        export_optimize_animation_keep_anim_armature=True,
        export_image_format="AUTO",
    )


def read_glb(path):
    data = open(path, "rb").read()
    if data[:4] != b"glTF":
        raise SystemExit("not a GLB: " + path)
    gltf, blob, off = None, b"", 12
    while off < len(data):
        length, chunk_type = struct.unpack_from("<II", data, off)
        if chunk_type == 0x4E4F534A:  # 'JSON'
            gltf = json.loads(data[off + 8: off + 8 + length])
        elif chunk_type == 0x004E4942:  # 'BIN'
            blob = data[off + 8: off + 8 + length]
        off += 8 + length
    if gltf is None:
        raise SystemExit("no JSON chunk in " + path)
    return gltf, blob, len(data)


def write_glb(path, gltf, blob):
    js = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode()
    js += b" " * (-len(js) % 4)
    blob = bytes(blob) + b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(js) + (8 + len(blob) if blob else 0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        if blob:
            f.write(struct.pack("<II", len(blob), 0x004E4942) + blob)


# --- Compaction ----------------------------------------------------------------------
#
# Blender's exporter writes every channel of all 41 joints in every clip (492
# channels, ~80% of them two identical keys) and stores every vertex attribute
# as float32. For KayKit that is ~590 KB a file, and the JSON describing those
# channels is a fifth of it. The pass below rewrites the exported GLB:
#
# - A channel whose every key equals the joint's rest value is dropped. three's
#   PropertyMixer blends toward, and on stop restores, each property's value
#   from when its binding was made (the rest pose), so a joint a clip does not
#   animate sits at exactly the value the dropped keys held. A constant channel
#   that differs from rest is kept.
# - UVs become normalized uint16 and skin weights normalized uint8 (both core
#   glTF); normals become normalized int8 under KHR_mesh_quantization, which
#   GLTFLoader supports without a decoder. Positions stay float32, so bounds,
#   skinning and picking see exactly what Blender wrote.
# - Animation data is packed into one buffer view and identical accessors are
#   shared, which is most of the JSON.

COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
              5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
REST = {"translation": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0], "scale": [1.0, 1.0, 1.0]}
# Well inside what anyone can see (0.01 mm, ~0.001 deg) and well above float32
# noise in the exporter's sampling.
REST_EPS = 1e-5


def accessor_array(gltf, blob, index):
    acc = gltf["accessors"][index]
    if "sparse" in acc:
        raise SystemExit("sparse accessors are not expected from this build")
    view = gltf["bufferViews"][acc["bufferView"]]
    dtype = np.dtype(COMPONENTS[acc["componentType"]]).newbyteorder("<")
    width = WIDTH[acc["type"]]
    elem = dtype.itemsize * width
    stride = view.get("byteStride", elem)
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    idx = start + np.arange(acc["count"])[:, None] * stride + np.arange(elem)[None, :]
    raw = np.frombuffer(blob, dtype=np.uint8)[idx]
    return np.ascontiguousarray(raw).view(dtype).reshape(acc["count"], width)


def equals_rest(values, rest, path):
    diff = np.abs(values - rest).max()
    if path == "rotation":  # q and -q are the same rotation
        diff = min(diff, np.abs(values + rest).max())
    return diff <= REST_EPS


def quantize_weights(w):
    """Round to 1/255 while keeping every vertex's weights summing to exactly
    255, by giving the rounding error to each vertex's largest weight."""
    q = np.rint(w * 255.0).astype(np.int32)
    err = 255 - q.sum(axis=1)
    top = np.argmax(w, axis=1)
    q[np.arange(len(q)), top] += err
    if q.min() < 0 or q.max() > 255:
        raise SystemExit("weight quantization out of range")
    return q.astype(np.uint8)


def compact_glb(path):
    gltf, blob, before = read_glb(path)
    nodes = gltf["nodes"]
    dropped = kept = 0

    # 1. Channels that restate the rest pose.
    for anim in gltf.get("animations", []):
        channels = []
        for ch in anim["channels"]:
            target = ch["target"]
            sampler = anim["samplers"][ch["sampler"]]
            out = accessor_array(gltf, blob, sampler["output"]).astype(np.float64)
            rest = np.array(nodes[target["node"]].get(target["path"], REST[target["path"]]))
            if target["path"] in REST and equals_rest(out, rest, target["path"]):
                dropped += 1
            else:
                channels.append(ch)
                kept += 1
        used = sorted({ch["sampler"] for ch in channels})
        remap = {old: new for new, old in enumerate(used)}
        anim["samplers"] = [anim["samplers"][i] for i in used]
        for ch in channels:
            ch["sampler"] = remap[ch["sampler"]]
        anim["channels"] = channels

    # 2. Rebuild every accessor, re-encoding vertex attributes on the way.
    out_blob = bytearray()
    views, accessors, cache = [], [], {}

    def push_view(data, target=None, stride=None, shared=None):
        """Append bytes as a new buffer view (4-byte aligned), or into the shared
        animation view. Returns (view index, byte offset within the view)."""
        if shared is not None:
            view = views[shared]
            # The shared view must stay the last thing in the blob while it grows.
            assert view["byteOffset"] + view["byteLength"] == len(out_blob)
            pad = -view["byteLength"] % 4
            view_off = view["byteLength"] + pad
            out_blob.extend(b"\0" * pad + data)
            view["byteLength"] = view_off + len(data)
            return shared, view_off
        out_blob.extend(b"\0" * (-len(out_blob) % 4))
        view = {"buffer": 0, "byteOffset": len(out_blob), "byteLength": len(data)}
        if target:
            view["target"] = target
        if stride:
            view["byteStride"] = stride
        out_blob.extend(data)
        views.append(view)
        return len(views) - 1, 0

    anim_view = None

    def emit(arr, src, component, normalized=False, target=None, stride=None, keep_bounds=True,
             animation=False):
        nonlocal anim_view
        dtype = np.dtype(COMPONENTS[component])
        arr = np.ascontiguousarray(arr, dtype=dtype)
        data = arr.tobytes()
        if stride:
            width = arr.shape[1] * dtype.itemsize
            padded = np.zeros((arr.shape[0], stride), dtype=np.uint8)
            padded[:, :width] = np.frombuffer(data, dtype=np.uint8).reshape(arr.shape[0], width)
            data = padded.tobytes()
        acc = {"componentType": component, "count": int(arr.shape[0]), "type": src["type"]}
        if normalized:
            acc["normalized"] = True
        if keep_bounds:
            for k in ("min", "max"):
                if k in src:
                    acc[k] = src[k]
        key = (animation, component, normalized, acc["type"], data, json.dumps(acc, sort_keys=True))
        if animation and key in cache:
            return cache[key]
        if animation:
            if anim_view is None:
                anim_view, _ = push_view(b"")
            view, off = push_view(data, shared=anim_view)
        else:
            view, off = push_view(data, target=target, stride=stride)
        acc["bufferView"] = view
        if off:
            acc["byteOffset"] = off
        accessors.append(acc)
        index = len(accessors) - 1
        if animation:
            cache[key] = index
        return index

    src_accessors = gltf["accessors"]
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            attrs = {}
            for name, idx in prim["attributes"].items():
                src = src_accessors[idx]
                arr = accessor_array(gltf, blob, idx)
                if name.startswith("TEXCOORD") and src["componentType"] == 5126 \
                        and arr.min() >= 0.0 and arr.max() <= 1.0:
                    attrs[name] = emit(np.rint(arr * 65535.0), src, 5123, normalized=True,
                                       target=34962, keep_bounds=False)
                elif name.startswith("WEIGHTS") and src["componentType"] == 5126:
                    attrs[name] = emit(quantize_weights(arr), src, 5121, normalized=True,
                                       target=34962, keep_bounds=False)
                elif name == "NORMAL" and src["componentType"] == 5126:
                    attrs[name] = emit(np.clip(np.rint(arr * 127.0), -127, 127), src, 5120,
                                       normalized=True, target=34962, stride=4, keep_bounds=False)
                else:
                    attrs[name] = emit(arr, src, src["componentType"], target=34962)
            prim["attributes"] = attrs
            src = src_accessors[prim["indices"]]
            prim["indices"] = emit(accessor_array(gltf, blob, prim["indices"]), src,
                                   src["componentType"], target=34963)
    for skin in gltf.get("skins", []):
        src = src_accessors[skin["inverseBindMatrices"]]
        skin["inverseBindMatrices"] = emit(accessor_array(gltf, blob, skin["inverseBindMatrices"]),
                                           src, 5126)
    for anim in gltf.get("animations", []):
        for sampler in anim["samplers"]:
            for key in ("input", "output"):
                src = src_accessors[sampler[key]]
                sampler[key] = emit(accessor_array(gltf, blob, sampler[key]), src,
                                    src["componentType"], animation=True)
    for image in gltf.get("images", []):
        view = gltf["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        image["bufferView"], _ = push_view(blob[start:start + view["byteLength"]])

    gltf["accessors"] = accessors
    gltf["bufferViews"] = views
    gltf["buffers"] = [{"byteLength": len(out_blob)}]
    gltf.setdefault("extensionsUsed", [])
    gltf.setdefault("extensionsRequired", [])
    for key in ("extensionsUsed", "extensionsRequired"):
        if "KHR_mesh_quantization" not in gltf[key]:
            gltf[key].append("KHR_mesh_quantization")
    write_glb(path, gltf, out_blob)
    return {"bytes_before": before, "channels_kept": kept, "channels_dropped": dropped}


def node_matrix(node):
    t = node.get("translation", [0, 0, 0])
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    s = node.get("scale", [1, 1, 1])
    m = Quaternion((w, x, y, z)).to_matrix().to_4x4()
    for i in range(3):
        for j in range(3):
            m[i][j] *= s[j]
    m.translation = Vector(t)
    return m


def clip_tracks(gltf, blob, anim):
    """node index -> {path: (times, values, interpolation)} for one clip."""
    tracks = {}
    for ch in anim["channels"]:
        sampler = anim["samplers"][ch["sampler"]]
        if sampler.get("interpolation", "LINEAR") not in ("LINEAR", "STEP"):
            raise SystemExit(f"{anim.get('name')}: unexpected {sampler['interpolation']} sampler")
        tracks.setdefault(ch["target"]["node"], {})[ch["target"]["path"]] = (
            accessor_array(gltf, blob, sampler["input"])[:, 0].astype(np.float64),
            accessor_array(gltf, blob, sampler["output"]).astype(np.float64),
            sampler.get("interpolation", "LINEAR"))
    return tracks


def track_value(track, path, t):
    times, values, interp = track
    k = int(np.searchsorted(times, t, side="right")) - 1
    if k < 0:
        return values[0]
    if k >= len(times) - 1 or interp == "STEP":
        return values[k]
    a = (t - times[k]) / (times[k + 1] - times[k])
    b = values[k + 1]
    if path == "rotation":  # nlerp along the short way; keys are a frame apart
        b = b if np.dot(values[k], b) >= 0 else -b
        q = values[k] * (1 - a) + b * a
        return q / np.linalg.norm(q)
    return values[k] * (1 - a) + b * a


def posed_world(nodes, parent, tracks, t):
    """World matrix of node i at time t of a clip, as three's mixer poses it: a
    node the clip has no channel for sits at its rest transform."""
    world = {}

    def world_of(i):
        if i not in world:
            node = dict(nodes[i])
            for path, track in tracks.get(i, {}).items():
                node[path] = list(track_value(track, path, t))
            m = node_matrix(node)
            world[i] = world_of(parent[i]) @ m if i in parent else m
        return world[i]
    return world_of


def top_and_bottom(positions, m):
    """Highest and lowest world Y of a mesh's vertices under world matrix m."""
    y = positions @ np.array(m[1][:3]) + m[1][3]
    return float(y.max()), float(y.min())


def glb_report(path, spec, hit_time, walk_speed, weapons_before):
    """What actually survived the exporter, from the GLB's own JSON and data:
    exactly what three.js will see. Returns (report, violations)."""
    gltf, blob, nbytes = read_glb(path)
    nodes = gltf.get("nodes", [])
    accessors = gltf.get("accessors", [])
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    world_of = posed_world(nodes, parent, {}, 0.0)

    prims = [(i, p) for i, n in enumerate(nodes) if "mesh" in n
             for p in gltf["meshes"][n["mesh"]]["primitives"]]
    tris = sum(accessors[p["indices"]]["count"] // 3 for _, p in prims if "indices" in p)
    positions = {id(p): accessor_array(gltf, blob, p["attributes"]["POSITION"]).astype(np.float64)
                 for _, p in prims}

    # Which vertices are a weapon. join_meshes() weights each weapon wholly to
    # its hand's joint, and KayKit weights no body vertex to a handslot at all.
    skin = gltf.get("skins", [{}])[0]
    joint_of = {nodes[j]["name"]: k for k, j in enumerate(skin.get("joints", []))}
    ibm = (accessor_array(gltf, blob, skin["inverseBindMatrices"]).astype(np.float64)
           if "inverseBindMatrices" in skin else None)
    slot_of = {}
    for i, p in prims:
        names = np.full(len(positions[id(p)]), "", dtype=object)
        if "JOINTS_0" in p["attributes"] and "WEIGHTS_0" in p["attributes"]:
            joints = accessor_array(gltf, blob, p["attributes"]["JOINTS_0"]).astype(np.int64)
            wacc = accessors[p["attributes"]["WEIGHTS_0"]]
            weights = accessor_array(gltf, blob, p["attributes"]["WEIGHTS_0"]).astype(np.float64)
            if wacc.get("normalized"):
                weights /= np.iinfo(COMPONENTS[wacc["componentType"]]).max
            for slot in HANDSLOTS:
                if slot in joint_of:
                    names[((joints == joint_of[slot]) * weights).sum(axis=1) >= 0.999] = slot
        slot_of[id(p)] = names

    def on_slot(posed, i, p, slot):
        """World positions of the vertices riding `slot` in a pose, skinned as
        three does it: joint world x inverse bind x the mesh's bind transform."""
        m = slot_of[id(p)] == slot
        if not m.any():
            return np.zeros((0, 3))
        joint = skin["joints"][joint_of[slot]]
        skinning = np.array(posed(joint)) @ ibm[joint_of[slot]].reshape(4, 4).T @ np.array(world_of(i))
        v = positions[id(p)][m]
        return v @ skinning[:3, :3].T + skinning[:3, 3]

    # Rest height, from every vertex as three's Box3.setFromObject(obj, true)
    # measures it: the mesh is stored in bind pose, which is the rest pose.
    tops, body_tops = [], []
    for i, p in prims:
        top, _ = top_and_bottom(positions[id(p)], world_of(i))
        tops.append(top)
        body = positions[id(p)][slot_of[id(p)] == ""]
        if len(body):
            body_tops.append(top_and_bottom(body, world_of(i))[0])

    anims = {}
    for a in gltf.get("animations", []):
        times = [accessors[s["input"]] for s in a["samplers"]]
        anims[a.get("name")] = {
            "start": round(min(t["min"][0] for t in times), 4),
            "duration": round(max(t["max"][0] for t in times), 4),
            "channels": len(a["channels"]),
            "extras": a.get("extras"),
        }

    # Each hand's weapon at rest, and how far skinning puts it from its bind
    # position (zero if the skin's inverse bind matrices match its joints).
    weapons, skin_rest_error = {}, 0.0
    for slot in HANDSLOTS:
        pts, err = [], 0.0
        for i, p in prims:
            skinned = on_slot(world_of, i, p, slot)
            if len(skinned):
                bind = positions[id(p)][slot_of[id(p)] == slot]
                w = np.array(world_of(i))
                err = max(err, float(np.abs(skinned - (bind @ w[:3, :3].T + w[:3, 3])).max()))
                pts.append(skinned)
        if pts:
            pts = np.concatenate(pts)
            weapons[slot] = {"verts": len(pts), "min": [round(float(v), 4) for v in pts.min(axis=0)],
                             "max": [round(float(v), 4) for v in pts.max(axis=0)]}
        skin_rest_error = max(skin_rest_error, err)

    # Clip seams and the ground, posed from the file's own channels. The
    # runtime fades Idle into the windup in 60 ms, so a hand that is somewhere
    # else on Attack's first frame whips there in that fade and reads as the
    # blow. It fades a finished backswing back out in 120 ms, and cuts straight
    # from it into a back-to-back swing, so Attack's last frame has to match
    # too. A weapon under the lane in Idle or Walk is on screen all game.
    # Death's first frame is reported too, since the runtime fades into it in
    # 120 ms from wherever the unit was; it is only enforced for a held grip
    # (below), because Juggernaut's guard idle is meant to differ from it.
    clips = {a.get("name"): clip_tracks(gltf, blob, a) for a in gltf.get("animations", [])}
    seam = {}
    if "Idle" in clips and "Attack" in clips and "Death" in clips:
        idle = posed_world(nodes, parent, clips["Idle"], 0.0)
        attack_end = max(times[-1] for paths in clips["Attack"].values() for times, _, _ in paths.values())
        for which, clip, t in (("start", "Attack", 0.0), ("end", "Attack", attack_end), ("death", "Death", 0.0)):
            other = posed_world(nodes, parent, clips[clip], t)
            seam[which] = {}
            for i, n in enumerate(nodes):
                if n.get("name") in HANDSLOTS:
                    a, b = idle(i), other(i)
                    deg = math.degrees(a.to_quaternion().rotation_difference(b.to_quaternion()).angle)
                    seam[which][n["name"]] = [round((a.translation - b.translation).length, 3),
                                              round(min(deg, 360 - deg), 1)]
    # A held grip (grip_from_attack) must match the Attack's opening grip over
    # the whole of each clip that holds it, in the joint's own frame.
    grip_hold = {}
    if "Attack" in clips:
        slot = next(i for i, n in enumerate(nodes) if n.get("name") == "handslot.r")

        def local_rot(name, t):
            track = clips[name].get(slot, {}).get("rotation")
            q = track_value(track, "rotation", t) if track else nodes[slot].get("rotation", REST["rotation"])
            return Quaternion((q[3], q[0], q[1], q[2]))
        grip = local_rot("Attack", 0.0)
        for name in spec.get("grip_from_attack", []):
            worst = 0.0
            for t in np.arange(0.0, anims[name]["duration"] + 1e-9, 1 / FPS):
                deg = math.degrees(grip.rotation_difference(local_rot(name, float(t))).angle)
                worst = max(worst, min(deg, 360 - deg))
            grip_hold[name] = round(worst, 2)
    weapon_low = {}
    for name in ("Idle", "Walk"):
        if name not in clips or not weapons:
            continue
        low = np.inf
        for t in np.arange(0.0, anims[name]["duration"] + 1e-9, 1 / (4 * FPS)):
            posed = posed_world(nodes, parent, clips[name], float(t))
            for slot in weapons:
                for i, p in prims:
                    v = on_slot(posed, i, p, slot)
                    if len(v):
                        low = min(low, float(v[:, 1].min()))
        weapon_low[name] = round(low, 3)
    # The largest turn any joint makes between two neighbouring keys, per clip.
    # Three slerps the short way, so this is the angle it actually plays.
    key_step = {}
    for name, tracks in clips.items():
        worst = [0.0, None]
        for i, paths in tracks.items():
            if "rotation" not in paths or len(paths["rotation"][1]) < 2:
                continue
            q = paths["rotation"][1]
            q = q / np.linalg.norm(q, axis=1, keepdims=True)
            dots = np.clip(np.abs(np.sum(q[1:] * q[:-1], axis=1)), 0.0, 1.0)
            deg = math.degrees(2 * math.acos(float(dots.min())))
            if deg > worst[0]:
                worst = [round(deg, 1), nodes[i]["name"]]
        key_step[name] = worst

    report = {
        "file": os.path.relpath(path, REPO),
        "bytes": nbytes,
        "meshes": [n["name"] for n in nodes if "mesh" in n],
        "primitives": len(prims),
        "tris": tris,
        "joints": len(gltf.get("skins", [{}])[0].get("joints", [])),
        "animations": anims,
        "images": [(im.get("name"), gltf["bufferViews"][im["bufferView"]]["byteLength"])
                   for im in gltf.get("images", [])],
        "materials": [m.get("name") for m in gltf.get("materials", [])],
        "emissive": {m["name"]: [round(c, 3) for c in m["emissiveFactor"]]
                     for m in gltf.get("materials", []) if "emissiveFactor" in m},
        "weapons": weapons,
        "weapons_before": weapons_before,
        "skin_rest_error": skin_rest_error,
        "rest_height": round(max(tops), 3),
        "body_height": round(max(body_tops), 3),
        "idle_attack_seam": seam,
        "grip_hold": grip_hold,
        "weapon_low": weapon_low,
        "key_step": key_step,
    }

    bad = []
    if nbytes > BUDGET_BYTES:
        bad.append(f"{nbytes} bytes is over the {BUDGET_BYTES} budget")
    if report["joints"] != JOINTS:
        bad.append(f"{report['joints']} joints, expected {JOINTS}")
    if sorted(anims) != sorted(CLIPS):
        bad.append(f"animations {sorted(anims)}, expected exactly {sorted(CLIPS)}")
    for name, a in anims.items():
        if a["start"] != 0:
            bad.append(f"{name} starts at {a['start']}, not 0")
    attack = anims.get("Attack")
    if attack is not None:
        ht = (attack["extras"] or {}).get("hitTime")
        if ht is None:
            bad.append("Attack has no extras.hitTime")
        elif not 0 < ht < attack["duration"]:
            bad.append(f"hitTime {ht} outside (0, {attack['duration']})")
        elif abs(ht - hit_time) > 1e-6:
            bad.append(f"hitTime {ht} in file, {hit_time} intended")
    for name, a in anims.items():
        if name != "Attack" and a["extras"] and "hitTime" in a["extras"]:
            bad.append(f"{name} carries a hitTime")
    walk = anims.get("Walk")
    if walk is not None:
        gs = (walk["extras"] or {}).get("groundSpeed")
        if gs is None:
            bad.append("Walk has no extras.groundSpeed")
        elif not gs > 0 or abs(gs - walk_speed) > 1e-6:
            bad.append(f"groundSpeed {gs} in file, {walk_speed} intended")
    for name, a in anims.items():
        if name != "Walk" and a["extras"] and "groundSpeed" in a["extras"]:
            bad.append(f"{name} carries a groundSpeed")
    if any(n.get("name", "").startswith("Icosphere") for n in nodes) or \
            any(m.get("name", "").startswith("Icosphere") for m in gltf.get("meshes", [])):
        bad.append("Icosphere in file")
    mesh_nodes = [n for n in nodes if "mesh" in n]
    if len(mesh_nodes) != 1:
        bad.append(f"{len(mesh_nodes)} mesh nodes, expected the one join_meshes() makes")
    elif len(prims) != len(gltf.get("materials", [])):
        bad.append(f"{len(prims)} primitives for {len(gltf.get('materials', []))} materials")
    # Every weapon on the hand it was put on, where it was put: the join and
    # the export must not move it. Blender's bounds are float64 over float32.
    expected = {w["bone"]: w for w in weapons_before.values()}
    if set(weapons) != set(expected):
        bad.append(f"weapons on {sorted(weapons)}, expected on {sorted(expected)}")
    for slot, w in weapons.items():
        want = expected.get(slot)
        if want and max(abs(a - b) for k in ("min", "max") for a, b in zip(w[k], want[k])) > 1e-3:
            bad.append(f"{slot} weapon at rest spans {w['min']}..{w['max']}, "
                       f"expected {[round(v, 4) for v in want['min']]}..{[round(v, 4) for v in want['max']]}")
    if skin_rest_error > 1e-4:
        bad.append(f"weapons skin {skin_rest_error:.2e} m off their bind pose at rest")
    for which, frame in (("start", "Attack t=0"), ("end", "Attack's end")):
        for name, (dist, deg) in seam.get(which, {}).items():
            if dist > SEAM_METRES or deg > SEAM_DEGREES:
                bad.append(f"{name} moves {dist} m / {deg} deg between Idle t=0 and {frame}")
    for name, deg in grip_hold.items():
        if deg > SEAM_DEGREES:
            bad.append(f"handslot.r turns {deg} deg from the Attack's grip in {name}")
    for name, low in weapon_low.items():
        if low < 0:
            bad.append(f"a weapon reaches y={low}, under the ground, in {name}")
    for name, (deg, joint) in key_step.items():
        if deg > KEY_STEP_DEGREES:
            bad.append(f"{joint} turns {deg} deg between two keys of {name}")
    return report, bad


# --- Verification renders -------------------------------------------------------------

LANE = (0x47 / 255, 0x57 / 255, 0x3D / 255)   # scene.ts lane plane colour
BACKGROUND = (0x14 / 255, 0x1D / 255, 0x22 / 255)


def render_setup(scene, w, h):
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    # 'Standard' so the atlas colours come out as painted; AgX would shift the
    # very hues these renders exist to judge. Three.js draws without tone mapping.
    scene.view_settings.view_transform = "Standard"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "TEXTURE"
    shading.show_shadows = True
    shading.shadow_intensity = 0.35
    shading.show_cavity = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.color = BACKGROUND


def add_camera(scene, name, location, target, ortho=None, fov=None):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    scene.collection.objects.link(cam)
    cam.location = location
    cam.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.sensor_fit = "VERTICAL"
        cam.data.angle_y = math.radians(fov)
    cam.data.clip_end = 500
    scene.camera = cam
    return cam


def add_label(scene, cam, text, ortho):
    """A text strip in the top-left of an ortho camera's view."""
    curve = bpy.data.curves.new("label", "FONT")
    curve.body = text
    curve.size = ortho * 0.045
    obj = bpy.data.objects.new("label", curve)
    scene.collection.objects.link(obj)
    obj.parent = cam
    obj.location = (-ortho * 0.47, ortho * 0.43, -5.0)
    mat = bpy.data.materials.new("label")
    mat.diffuse_color = (1, 1, 1, 1)
    curve.materials.append(mat)
    return obj


def add_ground(scene, size, color):
    bpy.ops.mesh.primitive_plane_add(size=size)
    plane = bpy.context.active_object
    mat = bpy.data.materials.new("ground")
    mat.diffuse_color = (*color, 1.0)
    plane.data.materials.append(mat)
    return plane


def check_gl():
    """Workbench needs an OpenGL context. Without a display, Blender on Linux
    looks for headless EGL, and when libEGL is missing it aborts in native code
    instead of raising, so check before building anything."""
    if not sys.platform.startswith("linux") or os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        return
    import ctypes
    try:
        ctypes.CDLL("libEGL.so.1")
    except OSError:
        raise SystemExit("--renders needs OpenGL: there is no display and no libEGL.so.1. "
                         "Run Blender under `xvfb-run -a`.")


def render_to_array(scene, path):
    scene.render.filepath = path
    try:
        bpy.ops.render.render(write_still=True)
    except RuntimeError as e:
        raise SystemExit(f"render failed ({e}). Workbench needs OpenGL: on a headless "
                         "machine run Blender under `xvfb-run -a`.")
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    os.remove(path)
    return px.reshape(h, w, 4)


def save_array(px, path):
    h, w = px.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.pixels.foreach_set(px.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def load_glb_for_render(path):
    objs = import_gltf(path)
    rig = next(o for o in objs if o.type == "ARMATURE")
    return rig, {a.name: a for a in bpy.data.actions}


def pose(rig, action, t):
    # compact_glb dropped every channel that restates the rest pose. three
    # puts such a joint back at rest; Blender would keep whatever the previous
    # clip left there, so reset every joint first.
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    set_action(rig, action)
    f = t * FPS
    bpy.context.scene.frame_set(int(f), subframe=f - int(f))


def contact_sheet(glb, hit_time, out_png, tile=360):
    """Attack at t=0, mid-windup, contact and end; a Walk frame; the last Death
    frame. 3/4 front view (KayKit faces -Y), from the weapon-hand side."""
    scene = reset_scene()
    render_setup(scene, tile, tile)
    rig, acts = load_glb_for_render(glb)
    add_ground(scene, 12, (0.30, 0.34, 0.28))
    ortho = 3.8
    az = math.radians(35)
    target = Vector((0.0, 0.25, 1.15))
    cam = add_camera(scene, "sheet", target + Vector((-math.sin(az) * 12, -math.cos(az) * 12, 4.5)),
                     target, ortho=ortho)
    label = add_label(scene, cam, "", ortho)
    attack, walk, death = acts["Attack"], acts["Walk"], acts["Death"]
    a_end = attack.frame_range[1] / FPS
    frames = [
        (attack, 0.0, "Attack t=0"),
        (attack, hit_time / 2, f"windup {hit_time / 2:.3f}"),
        (attack, hit_time, f"contact {hit_time:.3f}"),
        (attack, a_end, f"Attack end {a_end:.3f}"),
        (walk, walk.frame_range[1] / FPS / 4, "Walk 1/4"),
        (death, death.frame_range[1] / FPS, "Death end"),
    ]
    tiles = []
    for act, t, text in frames:
        label.data.body = text
        pose(rig, act, t)
        tiles.append(render_to_array(scene, out_png + ".tile.png"))
    rows = [np.concatenate(tiles[i:i + 3], axis=1) for i in (3, 0)]  # pixel rows run bottom-up
    save_array(np.concatenate(rows, axis=0), out_png)


def team_pair(glbs, out_png):
    """Radiant and Dire side by side from the game camera (57 deg pitch, long
    lens), on the lane colour. Top: game scale, units ~40 px tall, blown up 3x
    with nearest-neighbour so the pixels stay honest. Bottom: 3x closer."""
    scene = reset_scene()
    add_ground(scene, 40, LANE)
    for i, glb in enumerate(glbs):
        rig, acts = load_glb_for_render(glb)
        rig.location.x = (-0.9, 0.9)[i]
        # Facing down-lane and a little toward the camera, as a laner mostly is.
        # The importer leaves the rig in quaternion mode, where rotation_euler
        # is stored but ignored.
        rig.rotation_mode = "XYZ"
        rig.rotation_euler.z = math.radians(-60)
        pose(rig, acts["Idle"], 0.0)
    pitch, dist = math.radians(57), 60.0
    target = Vector((0.0, 0.0, 0.6))
    loc = target + Vector((0.0, -math.cos(pitch) * dist, math.sin(pitch) * dist))
    # Measured on the warrior: from this pitch a 2.6 m unit covers about 2 m of
    # frame height (its height foreshortened plus its depth), so a 160 px frame
    # 7.5 m tall shows it about 40 px tall.
    small_h = 160
    fov = math.degrees(2 * math.atan(7.5 / 2 / dist))
    render_setup(scene, 240, small_h)
    add_camera(scene, "game", loc, target, fov=fov)
    small = render_to_array(scene, out_png + ".small.png")
    big_small = small.repeat(3, axis=0).repeat(3, axis=1)
    render_setup(scene, 720, 480)
    add_camera(scene, "close", loc, target, fov=fov / 3)
    close = render_to_array(scene, out_png + ".close.png")
    save_array(np.concatenate([close, big_small], axis=0), out_png)


# --- Main ---------------------------------------------------------------------------

def build(spec, out_dir):
    reset_scene()
    rig = import_character(spec)
    strip_weapons(rig, spec["keep"])
    for asset, grip in spec["attach"]:
        attach_weapon(rig, asset, grip)
    rigid = join_meshes(rig, spec["character"])
    weapons = {n: r for n, r in rigid.items() if r["bone"] in HANDSLOTS}
    expected = set(spec["keep"]) | {a for a, _ in spec["attach"]}
    if set(weapons) != expected:
        raise SystemExit(f"{spec['id']}: weapons {sorted(weapons)} on the hands, expected {sorted(expected)}")
    acts = keep_clips(rig, spec["clips"])
    hold_attack_grip(acts, spec.get("grip_from_attack", []))

    det = detect_contact(rig, acts["Attack"])
    hit = spec.get("hit_time", det["contact"])
    if "return_from" in spec:
        # After detection, and only after the hit, so the contact is found on
        # the clip as KayKit authored it.
        if spec["return_from"] <= hit:
            raise SystemExit(f"{spec['id']}: return_from {spec['return_from']} is not after hitTime {hit}")
        return_to_start(acts["Attack"], spec["return_from"])
    acts["Attack"]["hitTime"] = hit
    walk_speed = ground_speed(rig, acts["Walk"])
    acts["Walk"]["groundSpeed"] = walk_speed

    body_mats = {m for o in rig.children if o.type == "MESH" for m in o.data.materials
                 if m and m.name != "Glow"}
    if len(body_mats) != 1:
        raise SystemExit(f"{spec['id']}: expected one atlas material, got {[m.name for m in body_mats]}")
    material = body_mats.pop()
    base = atlas_image(material)
    size = tuple(base.size)
    base_pixels = np.empty(size[0] * size[1] * 4, dtype=np.float32)
    base.pixels.foreach_get(base_pixels)
    base_pixels = base_pixels.reshape(size[1], size[0], 4)

    print(f"BUILD {spec['id']}: contact detected {det['contact']} ({det['hand']} peak "
          f"{det['peak_speed']} m/s at {det['peak_t']}), used {hit}; walk ground speed {walk_speed} m/s")

    results = []
    for team in TEAMS:
        coverage = paint_team(spec, material, base_pixels, size, team)
        glow = paint_glow(team)
        purge_orphans()
        out = os.path.join(out_dir, f"{spec['id']}_{team}.glb")
        export(rig, out)
        compaction = compact_glb(out)
        report, bad = glb_report(out, spec, hit, walk_speed, weapons)
        report.update({"unit": spec["id"], "team": team, "cloth_coverage": round(coverage, 3),
                       "compaction": compaction,
                       "glow": glow, "clips": spec["clips"], "contact_detected": det["contact"],
                       "contact_hand": det["hand"], "hit_time": hit, "ground_speed": walk_speed})
        print("GLB_REPORT " + json.dumps(report))
        for b in bad:
            print(f"GLB_VIOLATION {report['file']}: {b}")
        results.append((out, report, bad))
    return results


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="build_units.py")
    ap.add_argument("--only", help="comma-separated unit ids (default: all)")
    ap.add_argument("--out", default=OUT_DIR, help="output directory")
    ap.add_argument("--renders", help="write verification renders to this directory")
    args = ap.parse_args(argv)

    if bpy.app.version[:2] < (5, 2):
        # Older exporters do not write action custom properties to
        # animations[].extras, so hitTime would silently go missing.
        raise SystemExit(f"Blender {bpy.app.version_string} is too old; use the 5.2 that "
                         "tools/fetch_assets.sh installs.")
    for name, path in PACKS.items():
        if not os.path.isdir(path):
            raise SystemExit(f"KayKit {name} pack not found at {path}. Run tools/fetch_assets.sh first.")

    ids = [u["id"] for u in UNITS]
    only = args.only.split(",") if args.only else ids
    unknown = sorted(set(only) - set(ids))
    if unknown:
        raise SystemExit(f"unknown unit ids {unknown}; known: {ids}")

    if args.renders:
        check_gl()
    out_dir = os.path.abspath(args.out)
    results = []
    for spec in UNITS:
        if spec["id"] in only:
            results.append((spec, build(spec, out_dir)))

    if args.renders:
        rdir = os.path.abspath(args.renders)
        os.makedirs(rdir, exist_ok=True)
        for spec, files in results:
            for out, report, _ in files:
                contact_sheet(out, report["hit_time"],
                              os.path.join(rdir, os.path.basename(out)[:-4] + "_sheet.png"))
            team_pair([f[0] for f in files], os.path.join(rdir, spec["id"] + "_teams.png"))

    flat = [f for _, files in results for f in files]
    total = sum(r["bytes"] for _, r, _ in flat)
    bad = [(r["file"], b) for _, r, bads in flat for b in bads]
    print(f"BUILD_TOTAL {len(flat)} files, {total} bytes")
    if bad:
        for f, b in bad:
            print(f"FAILED {f}: {b}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Blender prints an uncaught exception from a --python script and then
        # exits 0, which would let a broken build pass.
        import traceback
        traceback.print_exc()
        sys.exit(1)
