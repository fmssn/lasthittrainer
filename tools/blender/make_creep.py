"""
Procedurally build a rigged, animated low-poly melee creep and export it as GLB.

Run headless:
    blender --background --python tools/blender/make_creep.py -- --out public/models/melee_creep.glb

The point of this script is the pipeline, not the art. Every part is a box, every
bone is hand-placed, and the four clips (Idle / Walk / Attack / Death) are plain
euler keyframes. Swap the geometry for a real asset later: as long as the bone
names and clip names survive, the runtime loader does not change.

Convention: bone rolls are aligned so that a POSITIVE X rotation always means
"swing/lean forward" (toward -Y), for every bone. Keeps the animation code below
readable instead of a pile of sign guesses.
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector

FORWARD = Vector((0.0, -1.0, 0.0))

# Bone rest poses, Z-up, origin between the feet. head -> tail, parent.
BONES = [
    ("root",  (0.00, 0, 0.00), (0.00, 0, 0.30), None,    False),
    ("hips",  (0.00, 0, 0.80), (0.00, 0, 1.05), "root",  True),
    ("spine", (0.00, 0, 1.05), (0.00, 0, 1.45), "hips",  True),
    ("head",  (0.00, 0, 1.45), (0.00, 0, 1.85), "spine", True),
    ("arm.L", (-0.36, 0, 1.40), (-0.36, 0, 0.85), "spine", True),
    ("arm.R", (0.36, 0, 1.40), (0.36, 0, 0.85), "spine", True),
    ("leg.L", (-0.15, 0, 0.80), (-0.15, 0, 0.00), "hips", True),
    ("leg.R", (0.15, 0, 0.80), (0.15, 0, 0.00), "hips", True),
]

# Mesh parts: (vertex group / bone, center, size). One box each.
PARTS = [
    ("hips",  (0.00, 0.00, 0.92), (0.46, 0.28, 0.26)),
    ("spine", (0.00, 0.00, 1.26), (0.52, 0.30, 0.44)),
    ("head",  (0.00, -0.02, 1.66), (0.38, 0.38, 0.38)),
    ("arm.L", (-0.36, 0.00, 1.12), (0.16, 0.16, 0.58)),
    ("arm.R", (0.36, 0.00, 1.12), (0.16, 0.16, 0.58)),
    # Club, welded to the right arm so it inherits the swing.
    ("arm.R", (0.36, -0.10, 0.80), (0.12, 0.44, 0.12)),
    ("leg.L", (-0.15, 0.00, 0.40), (0.22, 0.22, 0.80)),
    ("leg.R", (0.15, 0.00, 0.40), (0.22, 0.22, 0.80)),
]


def box(center, size):
    """8 verts + 6 quads, wound outward."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    v = [
        (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
    ]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def clear_scene():
    """read_factory_settings(use_empty=True) is not reliably empty across Blender
    versions, so delete whatever it leaves behind explicitly."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def build_mesh():
    """One mesh, built by hand so vertex order is deterministic and each box can
    be assigned to its bone with weight 1.0 (rigid, blocky, always correct)."""
    verts, faces, groups = [], [], {}
    for name, center, size in PARTS:
        base = len(verts)
        v, f = box(center, size)
        verts.extend(v)
        faces.extend([tuple(i + base for i in quad) for quad in f])
        groups.setdefault(name, []).extend(range(base, base + len(v)))

    mesh = bpy.data.meshes.new("CreepMesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for poly in mesh.polygons:
        poly.use_smooth = False

    obj = bpy.data.objects.new("Creep", mesh)
    bpy.context.collection.objects.link(obj)

    for name, indices in groups.items():
        vg = obj.vertex_groups.new(name=name)
        vg.add(indices, 1.0, 'REPLACE')

    mat = bpy.data.materials.new("CreepMat")
    if not mat.node_tree:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.42, 0.20, 0.16, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.8
    mesh.materials.append(mat)
    return obj


def build_armature():
    arm_data = bpy.data.armatures.new("CreepArmature")
    rig = bpy.data.objects.new("CreepRig", arm_data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')

    for name, head, tail, parent, deform in BONES:
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail = Vector(head), Vector(tail)
        eb.use_deform = deform
        eb.align_roll(FORWARD)  # +X rotation == forward, for every bone
    for name, _h, _t, parent, _d in BONES:
        if parent:
            arm_data.edit_bones[name].parent = arm_data.edit_bones[parent]

    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
    return rig


def bind(mesh_obj, rig):
    mesh_obj.parent = rig
    mod = mesh_obj.modifiers.new("Armature", 'ARMATURE')
    mod.object = rig


def rad(d):
    return math.radians(d)


def key(rig, frame, pose):
    """pose: {bone: (rx_deg, ry_deg, rz_deg)} or {bone: {'loc': (x,y,z)}}."""
    for bone, value in pose.items():
        pb = rig.pose.bones[bone]
        if isinstance(value, dict):
            if 'loc' in value:
                pb.location = Vector(value['loc'])
                pb.keyframe_insert('location', frame=frame)
            if 'rot' in value:
                pb.rotation_euler = [rad(a) for a in value['rot']]
                pb.keyframe_insert('rotation_euler', frame=frame)
        else:
            pb.rotation_euler = [rad(a) for a in value]
            pb.keyframe_insert('rotation_euler', frame=frame)


def new_action(rig, name):
    rig.animation_data_clear()
    ad = rig.animation_data_create()
    act = bpy.data.actions.new(name)
    ad.action = act
    return act


def iter_fcurves(act):
    """Blender 4.4+ moved fcurves into action layers/strips/channelbags.
    Older builds keep them flat on the action."""
    if hasattr(act, "fcurves"):
        yield from act.fcurves
        return
    for layer in act.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves


def finish(act, interp='BEZIER'):
    act.use_fake_user = True  # required for glTF 'ACTIONS' export mode
    for fc in iter_fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = interp


def anim_idle(rig):
    act = new_action(rig, "Idle")
    # 40 frames, loops: gentle breathing bob, arms drifting.
    key(rig, 1,  {"hips": {"loc": (0, 0, 0), "rot": (0, 0, 0)}, "spine": (2, 0, 0),
                  "arm.L": (4, 0, 0), "arm.R": (-4, 0, 0), "head": (0, 0, 0)})
    key(rig, 20, {"hips": {"loc": (0, -0.03, 0), "rot": (1, 0, 0)}, "spine": (4, 0, 0),
                  "arm.L": (-5, 0, 0), "arm.R": (5, 0, 0), "head": (-2, 0, 3)})
    key(rig, 40, {"hips": {"loc": (0, 0, 0), "rot": (0, 0, 0)}, "spine": (2, 0, 0),
                  "arm.L": (4, 0, 0), "arm.R": (-4, 0, 0), "head": (0, 0, 0)})
    finish(act)


def anim_walk(rig):
    act = new_action(rig, "Walk")
    # 24 frames, two contact poses + two passes. Legs lead, arms counter-swing.
    key(rig, 1,  {"leg.L": (28, 0, 0), "leg.R": (-28, 0, 0),
                  "arm.L": (-22, 0, 0), "arm.R": (22, 0, 0),
                  "spine": (6, 0, 0), "hips": {"loc": (0, 0, 0), "rot": (0, 0, -3)}})
    key(rig, 7,  {"leg.L": (0, 0, 0), "leg.R": (0, 0, 0),
                  "arm.L": (0, 0, 0), "arm.R": (0, 0, 0),
                  "spine": (6, 0, 0), "hips": {"loc": (0, 0, 0.04), "rot": (0, 0, 0)}})
    key(rig, 13, {"leg.L": (-28, 0, 0), "leg.R": (28, 0, 0),
                  "arm.L": (22, 0, 0), "arm.R": (-22, 0, 0),
                  "spine": (6, 0, 0), "hips": {"loc": (0, 0, 0), "rot": (0, 0, 3)}})
    key(rig, 19, {"leg.L": (0, 0, 0), "leg.R": (0, 0, 0),
                  "arm.L": (0, 0, 0), "arm.R": (0, 0, 0),
                  "spine": (6, 0, 0), "hips": {"loc": (0, 0, 0.04), "rot": (0, 0, 0)}})
    key(rig, 24, {"leg.L": (28, 0, 0), "leg.R": (-28, 0, 0),
                  "arm.L": (-22, 0, 0), "arm.R": (22, 0, 0),
                  "spine": (6, 0, 0), "hips": {"loc": (0, 0, 0), "rot": (0, 0, -3)}})
    finish(act)


def anim_attack(rig):
    act = new_action(rig, "Attack")
    # 18 frames. Frames 1-10 are the windup, 10 is the hit, 10-18 the backswing.
    # The runtime scales this clip so frame 10 lands exactly on the damage tick.
    key(rig, 1,  {"arm.R": (0, 0, 0), "spine": (2, 0, 0), "hips": (0, 0, 0)})
    key(rig, 7,  {"arm.R": (-115, 0, 0), "spine": (-12, 0, 0), "hips": (0, 0, 10)})
    key(rig, 10, {"arm.R": (62, 0, 0), "spine": (16, 0, 0), "hips": (0, 0, -12)})
    key(rig, 13, {"arm.R": (48, 0, 0), "spine": (12, 0, 0), "hips": (0, 0, -8)})
    key(rig, 18, {"arm.R": (0, 0, 0), "spine": (2, 0, 0), "hips": (0, 0, 0)})
    finish(act)


def anim_death(rig):
    act = new_action(rig, "Death")
    # 30 frames, does not loop. Buckle, then fall backward from the feet.
    key(rig, 1,  {"root": (0, 0, 0), "spine": (2, 0, 0), "head": (0, 0, 0),
                  "arm.L": (0, 0, 0), "arm.R": (0, 0, 0),
                  "leg.L": (0, 0, 0), "leg.R": (0, 0, 0)})
    key(rig, 6,  {"root": (8, 0, 0), "spine": (14, 0, 0), "head": (10, 0, 0),
                  "arm.L": (-18, 0, 0), "arm.R": (-14, 0, 0),
                  "leg.L": (6, 0, 0), "leg.R": (-4, 0, 0)})
    key(rig, 20, {"root": (-72, 0, 0), "spine": (-18, 0, 0), "head": (16, 0, 0),
                  "arm.L": (-46, 0, 0), "arm.R": (-52, 0, 0),
                  "leg.L": (24, 0, 0), "leg.R": (14, 0, 0)})
    key(rig, 30, {"root": (-90, 0, 0), "spine": (-8, 0, 0), "head": (6, 0, 0),
                  "arm.L": (-30, 0, 0), "arm.R": (-34, 0, 0),
                  "leg.L": (10, 0, 0), "leg.R": (6, 0, 0)})
    finish(act)


def export(rig, out_path):
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    # Leave animation_data intact: in ACTIONS mode the exporter walks every action
    # with a fake user, but only for objects that are actually animated.
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    for child in rig.children:
        child.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_bake_animation=True,
        export_apply=False,
        export_yup=True,
    )


def verify(out_path):
    """Report what actually survived the exporter.

    The glTF JSON chunk is ground truth: it is exactly what three.js will see.
    Blender's own importer is used only as a "does it load at all" smoke test,
    because it is not a faithful mirror (5.2 spawns a stray Icosphere on every
    import, which is an importer quirk and is not present in the file)."""
    import struct

    data = open(out_path, "rb").read()
    if data[:4] != b"glTF":
        raise SystemExit("not a GLB: " + out_path)
    gltf, off = None, 12
    while off < len(data):
        length, chunk_type = struct.unpack_from("<II", data, off)
        if chunk_type == 0x4E4F534A:  # 'JSON'
            gltf = json.loads(data[off + 8: off + 8 + length])
            break
        off += 8 + length
    if gltf is None:
        raise SystemExit("no JSON chunk in " + out_path)

    prims = [p for m in gltf.get("meshes", []) for p in m.get("primitives", [])]
    accessors = gltf.get("accessors", [])

    def count(prim, attr):
        idx = prim.get("attributes", {}).get(attr)
        return accessors[idx]["count"] if idx is not None else 0

    tris = sum(accessors[p["indices"]]["count"] // 3 for p in prims if "indices" in p)

    clear_scene()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=out_path)
    loaded = [o.name for o in bpy.data.objects if o not in before]

    return {
        "file": os.path.relpath(out_path),
        "bytes": os.path.getsize(out_path),
        "meshes": [m.get("name") for m in gltf.get("meshes", [])],
        "verts": sum(count(p, "POSITION") for p in prims),
        "tris": tris,
        "skinned": all("JOINTS_0" in p.get("attributes", {}) for p in prims),
        "joints": len(gltf.get("skins", [{}])[0].get("joints", [])),
        "bones": sorted(n["name"] for n in gltf.get("nodes", []) if "mesh" not in n
                        and n.get("name") not in ("CreepRig",)),
        "animations": [a.get("name") for a in gltf.get("animations", [])],
        "materials": [m.get("name") for m in gltf.get("materials", [])],
        "reimported_ok": "Creep" in loaded and "CreepRig" in loaded,
    }


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/models/melee_creep.glb")
    args = ap.parse_args(argv)

    out = os.path.abspath(args.out)

    clear_scene()
    mesh_obj = build_mesh()
    rig = build_armature()
    bind(mesh_obj, rig)

    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    for maker in (anim_idle, anim_walk, anim_attack, anim_death):
        maker(rig)
    bpy.ops.object.mode_set(mode='OBJECT')

    export(rig, out)
    print("GLB_REPORT " + json.dumps(verify(out)))


if __name__ == "__main__":
    main()
