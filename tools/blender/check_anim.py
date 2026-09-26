"""
Check the hero models' clips for what three.js will actually show, and film it.

Run headless with the Blender that tools/fetch_assets.sh installs:
    blender --background --python tools/blender/check_anim.py -- \
        --glb public/models/heroes/swordmaster.glb [--glb ...] \
        [--blend tools/blender/heroes.blend] [--out shots/anim] [--clips Attack,Walk] [--no-video]

Workbench needs OpenGL: on a machine without a display, run it under `xvfb-run -a`.

It reads the GLBs, never writes them, and only opens the .blend (it is never
saved). Per clip it checks, at the file's own 60 fps samples:

  rotation  the angle each bone turns relative to its parent between one
            sample and the next, in degrees per 1/60 s. Short path, so q and
            -q are the same rotation, as three's slerp treats them.
  jitter    two consecutive steps that both turn a lot about roughly opposite
            axes: the bone snaps out and back.
  seam      Idle and Walk loop, so last -> first counts as one more step.
  clipping  the deformed meshes intersecting each other, minus what already
            intersects in the bind pose (a modelling choice, not a pose).
  weights   from the GLB: sums that are not 1, vertices with no weights. With
            --blend, from the source: more than 4 deform influences (the
            exporter drops the rest), and Preserve Volume (three has no dual
            quaternion skinning, so the viewport shows a deformation the game
            never does).
  contact   the rig's hitTime extra: its frame and whether it is in the clip.

It writes <out>/report.md (worst first), <out>/report.json (every flagged
frame) and, unless --no-video, <out>/<hero>_<clip>.mp4: grey clay, a 3/4 view
at the lane camera's pitch beside an orthographic side view, every 60 fps
sample encoded at 15 fps (4x slow), flagged frames held. On a flagged frame
the skin of each flagged bone is orange and clipping faces are red.
"""

import argparse
import json
import math
import os
import shutil
import sys
from collections import defaultdict

import bpy
import numpy as np
from mathutils import Quaternion, Vector
from mathutils.bvhtree import BVHTree

# Borrow build_units' render helpers without leaving a __pycache__ in tools/.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_units import (add_camera, add_ground, add_label, check_gl, import_gltf,  # noqa: E402
                         render_setup, render_to_array, save_array, set_action)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The heroes are keyed and exported at 60 fps ("Always Sample"), so importing
# at 60 puts every sample on a whole frame and frame_set() reads the file's
# own values, not an interpolation between them.
FPS = 60
CLIPS = ("Idle", "Walk", "Attack", "Death")
LOOPING = ("Idle", "Walk")

# --- Thresholds ---------------------------------------------------------------

# Degrees a bone may turn in one 1/60 s sample. A fast sword cut peaks around
# 30-50 deg/f on the arm; past 45 the eye stops seeing motion between two
# poses and sees a cut, since three draws no motion blur.
ROT_WARN = 45.0
# At 90 deg/f a bone covers half a turn in two samples, so on a 30 fps display
# it jumps 180 deg between drawn frames and reads as a pop with no direction.
ROT_ERROR = 90.0
# Loose chains (tail, band, sash, braid, scarf) are secondary motion: they
# should trail the body, and they are long and thin, so a given angle moves
# their tip further than it moves a limb's. A flick past 30 deg/f reads as a whip.
ROT_WARN_LOOSE = 30.0
# Jitter: both steps above this and turning about axes more than JITTER_AXIS
# apart, i.e. the bone goes out and comes straight back. Below 8 deg a frame a
# reversal is an ordinary ease through an extreme.
JITTER_STEP = 8.0
JITTER_AXIS = 120.0
# A pair of parts clips when this many face pairs intersect in one frame. One
# or two is a grazing contact along a seam, invisible at game scale; three or
# more means one surface is passing through another.
CLIP_FACES = 3
# A pair that clips in more than this share of a clip's frames is layering (a
# garment skinned differently from what it covers, so the two surfaces cross
# wherever the pose bends them), not a pop. Both heroes are layered clothes,
# and on the first run nearly every frame of every clip had some; held, they
# would drown the pops the holds exist to show. Layering is still reported and
# still painted red, but listed apart and not held.
LAYERING_SHARE = 0.5
# The exporter stores weights as normalised integers, which moves a sum off 1
# by up to about 0.008. More than 0.01 is a real error in the data.
WEIGHT_TOL = 0.01
# three.js skins with four influences per vertex (JOINTS_0 / WEIGHTS_0).
MAX_INFLUENCES = 4
# Welding grid for rest positions, in metres. glTF splits a vertex wherever a
# normal, UV or material changes, and the copies sit at exactly the same
# position; 0.1 mm absorbs float noise and is far below any real gap.
WELD = 1e-4
# Faces smaller than this (m^2) are skipped for clipping: effect meshes are
# hidden by scaling their bone to zero, which collapses every face to a point
# where all of them "intersect".
DEGENERATE_AREA = 1e-10
# In the video, a vertex belongs to a flagged bone when it carries more than
# this much of that bone's weight.
HIGHLIGHT_WEIGHT = 0.3

# --- Video ----------------------------------------------------------------------

VIEW_PX = 640               # each of the two views is square
VIDEO_FPS = 15              # 60 fps samples at 15 fps: 4x slow motion
HOLD = 8                    # extra copies of a flagged frame
LANE_PITCH = 57.0           # scene.ts camera pitch
LANE_FOV = 20.0             # scene.ts vertical field of view
AZIMUTH = 35.0              # 3/4 view, from the front-right (the weapon hand)
CLAY_SATURATION = 0.25      # how much of each material's own colour survives
ORANGE = (1.0, 0.42, 0.02, 1.0)
RED = (0.95, 0.03, 0.03, 1.0)
BACKGROUND = (0x14 / 255, 0x1D / 255, 0x22 / 255)
GROUND = (0.30, 0.33, 0.29)
LABEL_LINES = 7
LABEL_STRIP = (VIEW_PX * 2, 208)   # under both views; 8 lines of 24 px
LABEL_LINE_PX = 24
FRAME_FILL = 0.9            # share of the frame the clip's bounds may fill
FRAME_STRIDE = 7            # every 7th vertex of every frame is enough to frame on
WORST_ROWS = 25             # rows in the report's top table; every row is in its clip's own table


# --- Scene ---------------------------------------------------------------------

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    return scene


def load_hero(path):
    objs = import_gltf(path)
    rig = next(o for o in objs if o.type == "ARMATURE")
    if "hitTime" not in rig:
        raise SystemExit(f"{path}: the armature carries no hitTime extra")
    # The importer puts every clip on an NLA track; with those in place the
    # active action would be blended with whichever strip sits on top.
    if rig.animation_data:
        for track in list(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(track)
    meshes = sorted((o for o in objs if o.type == "MESH"), key=lambda o: o.name)
    acts = {a.name: a for a in bpy.data.actions}
    hero_id = rig.get("heroId", os.path.splitext(os.path.basename(path))[0])
    return rig, meshes, acts, hero_id


def hero_title(hero_id):
    return hero_id.replace("_", " ").title()


def clip_frames(action):
    f0, f1 = action.frame_range
    return list(range(int(round(f0)), int(round(f1)) + 1))


# --- Bones -------------------------------------------------------------------------

def loose_bones(rig):
    """Bones that are neither a hand, a foot, the head, nor an ancestor of one."""
    core = set()
    for bone in rig.data.bones:
        if bone.name.split(".")[0] in ("hand", "foot", "head"):
            b = bone
            while b is not None:
                core.add(b.name)
                b = b.parent
    return {b.name for b in rig.data.bones if b.name not in core}


def local_rotations(rig):
    """Each bone's rotation relative to its parent, as keyed. The importer's
    bone-axis correction conjugates the glTF rotation, which leaves the angle
    between two samples unchanged."""
    out = {}
    for pb in rig.pose.bones:
        if pb.rotation_mode == "QUATERNION":
            q = pb.rotation_quaternion.copy()
        else:
            q = pb.matrix_basis.to_quaternion()
        q.normalize()
        out[pb.name] = q
    return out


def step(q0, q1):
    """(degrees, unit axis in parent space) turning q0 into q1, short path."""
    d = q1 @ q0.inverted()
    if d.w < 0:
        d = -d
    angle = math.degrees(2.0 * math.acos(min(1.0, d.w)))
    axis = Vector((d.x, d.y, d.z))
    return angle, (axis.normalized() if axis.length > 1e-9 else axis)


# --- Meshes ------------------------------------------------------------------------

class Topology:
    """Every mesh concatenated into one face list, with what the clipping
    check and the video need per face: part name, welded vertices, masks."""

    def __init__(self, rig, meshes):
        self.meshes = meshes
        self.v_off, self.f_off = [], []
        rest_co, faces, face_mat, face_mesh = [], [], [], []
        weights = []            # per mesh: dict bone -> np array (V,)
        nv = nf = 0
        for obj in meshes:
            me = obj.data
            self.v_off.append(nv)
            self.f_off.append(nf)
            co = np.empty(len(me.vertices) * 3, dtype=np.float64)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            mw = np.array(obj.matrix_world)
            rest_co.append(co @ mw[:3, :3].T + mw[:3, 3])
            for p in me.polygons:
                faces.append([nv + i for i in p.vertices])
                slot = me.materials[p.material_index] if p.material_index < len(me.materials) else None
                face_mat.append(slot.name if slot else obj.name)
                face_mesh.append(len(self.v_off) - 1)
            names = {vg.index: vg.name for vg in obj.vertex_groups}
            w = defaultdict(lambda n=len(me.vertices): np.zeros(n, dtype=np.float32))
            for v in me.vertices:
                for g in v.groups:
                    w[names[g.group]][v.index] = g.weight
            weights.append(dict(w))
            nv += len(me.vertices)
            nf += len(me.polygons)
        self.nv, self.nf = nv, nf
        # Vertices owned by an effect bone (the sword trail, the release
        # flash) are left out of the camera framing: they are on screen for a
        # frame or two and would otherwise shrink the hero in every other one.
        fx = []
        for mi, obj in enumerate(meshes):
            n = len(obj.data.vertices)
            fx_w = sum((arr for b, arr in weights[mi].items() if b.startswith("fx_")), np.zeros(n, dtype=np.float32))
            fx.append(fx_w > 0.5)
        self.fx = np.concatenate(fx)
        self.faces = faces
        # Faces as fan triangles, for the areas.
        fan = [(f[0], f[k], f[k + 1], fi) for fi, f in enumerate(faces) for k in range(1, len(f) - 1)]
        self.tris = np.array([t[:3] for t in fan], dtype=np.int64)
        self.tri_face = np.array([t[3] for t in fan], dtype=np.int64)
        self.face_mat = face_mat
        self.face_mesh = np.array(face_mesh)
        self.weights = weights

        rest = np.concatenate(rest_co)
        keys = np.round(rest / WELD).astype(np.int64)
        _, weld = np.unique(keys, axis=0, return_inverse=True)
        self.weld = weld.ravel()
        self.face_weld = [frozenset(self.weld[i] for i in f) for f in faces]

        # Islands by union-find over welded vertices, so a part split at its
        # UV seams by the exporter is still one part.
        parent = list(range(int(self.weld.max()) + 1))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        for fw in self.face_weld:
            it = iter(fw)
            r = find(next(it))
            for other in it:
                o = find(other)
                if o != r:
                    parent[o] = r
        self.face_island = [find(next(iter(fw))) for fw in self.face_weld]

        # An island's name, for pairs within one material: its dominant bone.
        bone_sum = defaultdict(lambda: defaultdict(float))
        for fi, f in enumerate(faces):
            mi = face_mesh[fi]
            for vi in f:
                local = vi - self.v_off[mi]
                for bone, arr in weights[mi].items():
                    bone_sum[self.face_island[fi]][bone] += float(arr[local])
        self.island_bone = {isl: max(b.items(), key=lambda kv: kv[1])[0] if b else "?"
                            for isl, b in bone_sum.items()}

    def world_coords(self, depsgraph):
        out = np.empty((self.nv, 3), dtype=np.float64)
        for obj, off in zip(self.meshes, self.v_off):
            ev = obj.evaluated_get(depsgraph)
            me = ev.to_mesh()
            n = len(me.vertices)
            if off + n > self.nv or n != len(obj.data.vertices):
                raise SystemExit(f"{obj.name}: evaluated mesh changed vertex count")
            co = np.empty(n * 3, dtype=np.float64)
            me.vertices.foreach_get("co", co)
            ev.to_mesh_clear()
            mw = np.array(ev.matrix_world)
            out[off:off + n] = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
        return out

    def face_areas(self, co):
        a, b, c = co[self.tris[:, 0]], co[self.tris[:, 1]], co[self.tris[:, 2]]
        tri = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
        areas = np.zeros(self.nf)
        np.add.at(areas, self.tri_face, tri)
        return areas

    def overlaps(self, co):
        """Intersecting face pairs (i < j) that share no welded vertex."""
        areas = self.face_areas(co)
        tree = BVHTree.FromPolygons(co.tolist(), self.faces, all_triangles=False)
        pairs = set()
        for i, j in tree.overlap(tree):
            if i == j:
                continue
            if i > j:
                i, j = j, i
            if areas[i] < DEGENERATE_AREA or areas[j] < DEGENERATE_AREA:
                continue
            if self.face_weld[i] & self.face_weld[j]:
                continue
            pairs.add((i, j))
        return pairs

    def part(self, i, j):
        """Report key for a pair of faces: material names, told apart by the
        island's dominant bone when both faces share a material."""
        a, b = self.face_mat[i], self.face_mat[j]
        if a != b:
            return " × ".join(sorted((a, b)))
        ia, ib = self.face_island[i], self.face_island[j]
        if ia == ib:
            return f"{a} (self, {self.island_bone[ia]})"
        na, nb = sorted((self.island_bone[ia], self.island_bone[ib]))
        return f"{a}[{na}] × {a}[{nb}]"


# --- Analysis ----------------------------------------------------------------------

def analyse_clip(scene, rig, topo, action, name, loose, bind_pairs, hit_time):
    set_action(rig, action)
    frames = clip_frames(action)
    rots, clips, points = [], [], []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for f in frames:
        scene.frame_set(f)
        rots.append(local_rotations(rig))
        co = topo.world_coords(depsgraph)
        points.append(co[~topo.fx][::FRAME_STRIDE])
        per_part = defaultdict(list)
        for i, j in topo.overlaps(co) - bind_pairs:
            per_part[topo.part(i, j)].append((i, j))
        clips.append(per_part)

    n = len(frames)
    loop = name in LOOPING
    # Sample sequence; a loop gets the first two samples again, so the seam
    # (last -> first) is one more step and the step after it closes the jitter
    # test across the wrap. Anything found there is reported on the last frame.
    seq = rots + ([rots[0], rots[1]] if loop and n > 1 else [])
    frame_of = frames + ([frames[-1], frames[-1]] if loop and n > 1 else [])
    steps = [None] + [{b: step(seq[k - 1][b], seq[k][b]) for b in seq[k]} for k in range(1, len(seq))]

    issues = defaultdict(list)       # frame -> list of issue dicts
    for k in range(1, len(seq)):
        seam = k >= n
        if loop and k == n + 1:
            break                       # that step is frames 0 -> 1 again
        for bone, (deg, _) in steps[k].items():
            warn = ROT_WARN_LOOSE if bone in loose else ROT_WARN
            if deg > warn:
                issues[frame_of[k]].append({
                    "type": "rotation", "bone": bone, "deg": round(deg, 1), "seam": seam,
                    "level": "ERROR" if deg > ROT_ERROR else "WARN", "loose": bone in loose})
    for k in range(1, len(seq) - 1):
        for bone in seq[k]:
            (d0, a0), (d1, a1) = steps[k][bone], steps[k + 1][bone]
            if d0 > JITTER_STEP and d1 > JITTER_STEP:
                between = math.degrees(math.acos(max(-1.0, min(1.0, a0.dot(a1)))))
                if between > JITTER_AXIS:
                    issues[frame_of[k]].append({
                        "type": "jitter", "bone": bone, "in": round(d0, 1), "out": round(d1, 1),
                        "axes": round(between, 1), "seam": k >= n - 1 and loop})
    flagged_in = defaultdict(int)
    for per_part in clips:
        for part, pairs in per_part.items():
            if len(pairs) >= CLIP_FACES:
                flagged_in[part] += 1
    for fi, per_part in enumerate(clips):
        for part, pairs in per_part.items():
            if len(pairs) >= CLIP_FACES:
                issues[frames[fi]].append({"type": "clipping", "parts": part, "faces": len(pairs),
                                           "layering": flagged_in[part] > LAYERING_SHARE * n})

    # Clipping faces per frame, kept only for the video.
    red = {}
    for fi, per_part in enumerate(clips):
        faces = {x for pairs in per_part.values() if len(pairs) >= CLIP_FACES for p in pairs for x in p}
        if faces:
            red[frames[fi]] = faces

    peaks = {}
    for k in range(1, min(len(seq), n + 1 if loop else n)):
        for bone, (deg, _) in steps[k].items():
            if deg > peaks.get(bone, (0.0,))[0]:
                peaks[bone] = (deg, frame_of[k], k >= n)
    hit_frame = hit_time * FPS if name == "Attack" else None
    return {
        "clip": name, "frames": frames, "loop": loop, "issues": dict(issues), "red": red,
        "peaks": peaks, "points": np.concatenate(points), "hit_frame": hit_frame,
    }


def bind_pose_pairs(scene, rig, topo):
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    pairs = topo.overlaps(topo.world_coords(bpy.context.evaluated_depsgraph_get()))
    rig.data.pose_position = "POSE"
    bpy.context.view_layer.update()
    return pairs


def glb_weights(topo):
    out = []
    for mi, obj in enumerate(topo.meshes):
        n = len(obj.data.vertices)
        total = np.zeros(n, dtype=np.float64)
        for arr in topo.weights[mi].values():
            total += arr
        none = int(np.count_nonzero(total == 0.0))
        off = total[(total > 0.0) & (np.abs(total - 1.0) > WEIGHT_TOL)]
        if none or len(off):
            out.append({"mesh": obj.name, "vertices": n, "unweighted": none, "sum_off": int(len(off)),
                        "worst_sum": round(float(off[np.argmax(np.abs(off - 1.0))]), 4) if len(off) else None})
    return out


def blend_weights(path):
    """Open the source .blend (never saved) and check what the exporter and
    three would do differently from the viewport."""
    bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)
    out = []
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.type != "MESH":
            continue
        for mod in obj.modifiers:
            if mod.type != "ARMATURE" or mod.object is None:
                continue
            deform = {b.name for b in mod.object.data.bones if b.use_deform}
            groups = {vg.index: vg.name for vg in obj.vertex_groups if vg.name in deform}
            over, off, worst = 0, 0, 0
            for v in obj.data.vertices:
                ws = [g.weight for g in v.groups if g.group in groups and g.weight > 0.0]
                worst = max(worst, len(ws))
                if len(ws) > MAX_INFLUENCES:
                    over += 1
                if ws and abs(sum(ws) - 1.0) > WEIGHT_TOL:
                    off += 1
            if over or off or mod.use_deform_preserve_volume:
                out.append({"mesh": obj.name, "scene": ",".join(s.name for s in obj.users_scene),
                            "rig": mod.object.name, "vertices": len(obj.data.vertices),
                            "over_4": over, "max_influences": worst, "sum_off": off,
                            "preserve_volume": bool(mod.use_deform_preserve_volume)})
    return out


# --- Video ---------------------------------------------------------------------------

def clay(material):
    rgb = (0.6, 0.6, 0.6)
    if material.use_nodes and material.node_tree:
        bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is not None:
            inp = bsdf.inputs["Base Color"]
            if inp.is_linked and inp.links[0].from_node.type == "TEX_IMAGE" and inp.links[0].from_node.image:
                img = inp.links[0].from_node.image
                px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
                img.pixels.foreach_get(px)
                rgb = tuple(px.reshape(-1, 4)[:, :3].mean(axis=0))
            elif not inp.is_linked:
                rgb = tuple(inp.default_value[:3])
    lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    return tuple(lum + (c - lum) * CLAY_SATURATION for c in rgb) + (1.0,)


def flag_materials(topo):
    orange = bpy.data.materials.new("flag_bone")
    orange.diffuse_color = ORANGE
    red = bpy.data.materials.new("flag_clip")
    red.diffuse_color = RED
    for mat in {m for obj in topo.meshes for m in obj.data.materials if m}:
        mat.diffuse_color = clay(mat)
    base = []
    for obj in topo.meshes:
        me = obj.data
        idx = np.empty(len(me.polygons), dtype=np.int32)
        me.polygons.foreach_get("material_index", idx)
        base.append((idx, len(me.materials)))
        me.materials.append(orange)
        me.materials.append(red)
    return base


def paint(topo, base, bones, red_faces):
    for mi, obj in enumerate(topo.meshes):
        me = obj.data
        idx, n_mats = base[mi]
        idx = idx.copy()
        if bones:
            hot = np.zeros(len(me.vertices), dtype=bool)
            for b in bones:
                if b in topo.weights[mi]:
                    hot |= topo.weights[mi][b] > HIGHLIGHT_WEIGHT
            if hot.any():
                for pi, p in enumerate(me.polygons):
                    if any(hot[v] for v in p.vertices):
                        idx[pi] = n_mats
        if red_faces:
            off = topo.f_off[mi]
            for g in red_faces:
                if topo.face_mesh[g] == mi:
                    idx[g - off] = n_mats + 1
        me.polygons.foreach_set("material_index", idx)
        me.update()


def describe(issue):
    if issue["type"] == "rotation":
        tail = " seam" if issue["seam"] else ""
        return f"{issue['bone']} {issue['deg']:.0f}°/f {issue['level']}{tail}"
    if issue["type"] == "jitter":
        return f"{issue['bone']} jitter {issue['in']:.0f}°/{issue['out']:.0f}° axes {issue['axes']:.0f}°"
    return f"{issue['parts']} {issue['faces']} faces"


def issue_rank(issue):
    if issue["type"] == "rotation":
        return (0 if issue["level"] == "ERROR" else 2, -issue["deg"])
    if issue["type"] == "jitter":
        return (1, -min(issue["in"], issue["out"]))
    return (4 if issue["layering"] else 3, -issue["faces"])


def is_pop(issue):
    return not (issue["type"] == "clipping" and issue["layering"])


def encode(files, out_path, w, h):
    """H.264 through Blender's own sequencer and FFMPEG output, so there is no
    dependency on a system ffmpeg."""
    sc = bpy.data.scenes.new("encode")
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.render.fps, sc.render.fps_base = VIDEO_FPS, 1.0
    sc.view_settings.view_transform = "Standard"
    ed = sc.sequence_editor_create()
    strips = ed.strips if hasattr(ed, "strips") else ed.sequences
    strip = strips.new_image("frames", files[0], channel=1, frame_start=1)
    for f in files[1:]:
        strip.elements.append(os.path.basename(f))
    sc.frame_start, sc.frame_end = 1, len(files)
    im = sc.render.image_settings
    if hasattr(im, "media_type"):
        im.media_type = "VIDEO"
    im.file_format = "FFMPEG"
    ff = sc.render.ffmpeg
    ff.format = "MPEG4"
    ff.codec = "H264"
    ff.constant_rate_factor = "HIGH"
    ff.ffmpeg_preset = "GOOD"
    ff.audio_codec = "NONE"
    sc.render.use_file_extension = False
    sc.render.use_sequencer = True
    sc.render.filepath = out_path
    bpy.ops.render.render(animation=True, scene=sc.name)
    bpy.data.scenes.remove(sc)


def film_clip(scene, rig, topo, base, action, res, hero, out_dir):
    set_action(rig, action)
    # Frame both views on where the body actually goes during the clip.
    pts = res["points"]
    pitch, az = math.radians(LANE_PITCH), math.radians(AZIMUTH)
    view = np.array([-math.sin(az) * math.cos(pitch), -math.cos(az) * math.cos(pitch), math.sin(pitch)])
    right = np.cross(view, [0.0, 0.0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, view)
    # Aim at the middle of the projected extents, then pull back just far
    # enough that every point is in frame at the lane camera's pitch and lens.
    pr, pu = pts @ right, pts @ up
    centre = ((pr.min() + pr.max()) / 2) * right + ((pu.min() + pu.max()) / 2) * up         + float((pts @ view).mean()) * view
    d = pts - centre
    t = math.tan(math.radians(LANE_FOV) / 2) * FRAME_FILL
    dist = float(np.max(np.maximum(np.abs(d @ right), np.abs(d @ up)) / t + d @ view))
    cam34 = add_camera(scene, "three_quarter", Vector((centre + view * dist).tolist()),
                       Vector(centre.tolist()), fov=LANE_FOV)
    # Side view from the hero's right (-X; the model faces -Y), where the
    # sword arm and the draw hand are.
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    mid = Vector(((lo + hi) / 2).tolist())
    ortho = max(hi[1] - lo[1], hi[2] - lo[2]) / FRAME_FILL
    side = add_camera(scene, "side", mid + Vector((-30.0, 0.0, 0.0)), mid, ortho=ortho)
    # The label gets a strip of its own under both views, so a long list of
    # issues never covers the hero. Its camera looks down at the text far from
    # the stage; the world colour is the strip's background.
    strip_w = LABEL_STRIP[0] / 100.0            # 1 cm per pixel
    text_cam = add_camera(scene, "label", (1000.0, 0.0, 10.0), (1000.0, 0.0, 0.0), ortho=strip_w)
    label = add_label(scene, text_cam, "", strip_w)
    label.data.size = LABEL_LINE_PX / 100.0 / 1.25
    label.location = (-strip_w / 2 + 0.2, LABEL_STRIP[1] / 200.0 - LABEL_LINE_PX / 100.0, -5.0)

    frames_dir = os.path.join(out_dir, f".frames_{hero}_{res['clip']}")
    shutil.rmtree(frames_dir, ignore_errors=True)
    os.makedirs(frames_dir)
    files = []
    total = res["frames"][-1]
    for f in res["frames"]:
        found = sorted(res["issues"].get(f, []), key=issue_rank)
        bones = {i["bone"] for i in found if i["type"] in ("rotation", "jitter")}
        paint(topo, base, bones, res["red"].get(f))
        scene.frame_set(f)
        head = f"{hero_title(hero)} · {res['clip']}   frame {f}/{total}   t={f / FPS:.3f}s"
        if res["hit_frame"] is not None and abs(f - res["hit_frame"]) < 0.5:
            head += "   CONTACT"
        pops = [i for i in found if is_pop(i)]
        layered = len(found) - len(pops)
        lines = [head] + [describe(i) for i in pops[:LABEL_LINES]]
        if len(pops) > LABEL_LINES:
            lines.append(f"+{len(pops) - LABEL_LINES} more")
        if layered:
            lines.append(f"(+{layered} layering pairs, see report)")
        label.data.body = "\n".join(lines)

        label.hide_render = True
        scene.render.resolution_x = scene.render.resolution_y = VIEW_PX
        scene.camera = cam34
        left = render_to_array(scene, os.path.join(frames_dir, "l.png"))
        scene.camera = side
        right = render_to_array(scene, os.path.join(frames_dir, "r.png"))
        label.hide_render = False
        scene.render.resolution_x, scene.render.resolution_y = LABEL_STRIP
        scene.camera = text_cam
        text = render_to_array(scene, os.path.join(frames_dir, "t.png"))
        path = os.path.join(frames_dir, f"{len(files):05d}.png")
        # Pixel rows run bottom-up, so the strip goes first to sit underneath.
        save_array(np.concatenate([text, np.concatenate([left, right], axis=1)], axis=0), path)
        files.append(path)
        for _ in range(HOLD if pops else 0):
            dup = os.path.join(frames_dir, f"{len(files):05d}.png")
            shutil.copyfile(path, dup)
            files.append(dup)

    out = os.path.join(out_dir, f"{hero}_{res['clip']}.mp4")
    encode(files, out, VIEW_PX * 2, VIEW_PX + LABEL_STRIP[1])
    shutil.rmtree(frames_dir, ignore_errors=True)
    for obj in (cam34, side, text_cam, label):
        bpy.data.objects.remove(obj, do_unlink=True)
    paint(topo, base, set(), None)
    return out


# --- Report ------------------------------------------------------------------------------

def summarise(hero, res):
    """Collapse per-frame issues into one row per bone or part pair."""
    rows = {}
    for f, found in res["issues"].items():
        for i in found:
            key = (i["type"], i.get("bone") or i.get("parts"))
            r = rows.setdefault(key, {"hero": hero, "clip": res["clip"], "type": i["type"],
                                      "what": key[1], "frames": [], "peak": None, "faces": []})
            r["frames"].append(f)
            if i["type"] == "clipping":
                r["faces"].append(i["faces"])
            if r["peak"] is None or issue_rank(i) < issue_rank(r["peak"]):
                r["peak"] = dict(i, frame=f)
    for r in rows.values():
        r["frames"].sort()
    return list(rows.values())


def frame_list(frames):
    out, start = [], None
    for k, f in enumerate(frames):
        if start is None:
            start = f
        if k + 1 == len(frames) or frames[k + 1] != f + 1:
            out.append(str(start) if start == f else f"{start}-{f}")
            start = None
    return ", ".join(out)


def peak_text(r):
    p = r["peak"]
    t = p["frame"] / FPS
    if p["type"] == "rotation":
        return f"{p['deg']:.1f}°/f {p['level']}{' (seam)' if p['seam'] else ''}", f"f{p['frame']} {t:.3f}s"
    if p["type"] == "jitter":
        return f"{p['in']:.0f}° then {p['out']:.0f}°, axes {p['axes']:.0f}° apart", f"f{p['frame']} {t:.3f}s"
    return f"{p['faces']} face pairs", f"f{p['frame']} {t:.3f}s"


def write_report(out_dir, heroes, blend_rows, blend_path, videos):
    rows = [r for h in heroes for res in h["clips"] for r in summarise(h["id"], res)]
    rows.sort(key=lambda r: issue_rank(r["peak"]))
    layering = [r for r in rows if not is_pop(r["peak"])]
    rows = [r for r in rows if is_pop(r["peak"])]
    md = ["# Hero animation check", "",
          f"Blender {bpy.app.version_string}; {FPS} fps samples; thresholds: rotation warn {ROT_WARN:.0f} "
          f"(loose chains {ROT_WARN_LOOSE:.0f}) / error {ROT_ERROR:.0f} deg/f, jitter {JITTER_STEP:.0f} deg "
          f"with axes > {JITTER_AXIS:.0f} deg apart, clipping from {CLIP_FACES} face pairs.", "",
          "## Worst issues", ""]
    if rows:
        md += ["| # | Hero | Clip | Kind | Bone / parts | Peak | At | Flagged frames |",
               "|---|---|---|---|---|---|---|---|"]
        for n, r in enumerate(rows[:WORST_ROWS], 1):
            peak, at = peak_text(r)
            md.append(f"| {n} | {hero_title(r['hero'])} | {r['clip']} | {r['type']} | {r['what']} | {peak} | "
                      f"{at} | {frame_list(r['frames'])} |")
        if len(rows) > WORST_ROWS:
            md += ["", f"{len(rows) - WORST_ROWS} more below, per clip."]
    else:
        md.append("Nothing flagged.")
    if layering:
        md += ["", "## Layering (clips in most of a clip)", "",
               f"These part pairs intersect by {CLIP_FACES}+ face pairs in more than "
               f"{LAYERING_SHARE:.0%} of the clip's frames, though not in the bind pose: one surface is "
               "skinned differently from the one it lies on. Red in the videos, not held.", "",
               "| Hero | Clip | Parts | Frames | Face pairs (peak) | Peak at |", "|---|---|---|---|---|---|"]
        for r in layering:
            n = next(len(res["frames"]) for h in heroes if h["id"] == r["hero"]
                     for res in h["clips"] if res["clip"] == r["clip"])
            md.append(f"| {hero_title(r['hero'])} | {r['clip']} | {r['what']} | {len(r['frames'])} of {n} | "
                      f"{max(r['faces'])} | f{r['peak']['frame']} |")

    for h in heroes:
        md += ["", f"## {hero_title(h['id'])}", "",
               f"`{h['file']}`, {h['faces']} faces, {h['bind_pairs']} face pairs already intersect in the bind "
               "pose (ignored).", ""]
        c = h["contact"]
        md.append(f"- **Contact:** hitTime {c['hitTime']:.4f} s = frame {c['frame']:.2f} of Attack's "
                  f"0-{c['last_frame']} ({'on a whole frame' if c['whole'] else 'between frames'}, "
                  f"{'inside' if c['inside'] else 'OUTSIDE'} the clip).")
        if h["weights"]:
            for w in h["weights"]:
                md.append(f"- **Weights:** {w['mesh']}: {w['unweighted']} unweighted, {w['sum_off']} not summing "
                          f"to 1 (worst {w['worst_sum']}) of {w['vertices']}.")
        else:
            md.append("- **Weights (GLB):** every vertex weighted, every sum 1 within "
                      f"{WEIGHT_TOL}.")
        for res in h["clips"]:
            n = res["frames"][-1]
            md += ["", f"### {res['clip']}: frames 0-{n}, {n / FPS:.3f} s{' (loops)' if res['loop'] else ''}", ""]
            top = sorted(res["peaks"].items(), key=lambda kv: -kv[1][0])[:6]
            md.append("Fastest bones: " + ", ".join(
                f"{b} {d:.1f}°/f @f{f}{' seam' if s else ''}" for b, (d, f, s) in top) + ".")
            if res["loop"]:
                worst = max(res["seam_steps"].items(), key=lambda kv: kv[1], default=("-", 0.0))
                md.append(f"Loop seam: largest last->first step {worst[1]:.1f}°/f ({worst[0]}).")
            mine = [r for r in rows if r["hero"] == h["id"] and r["clip"] == res["clip"]]
            n_layer = sum(1 for r in layering if r["hero"] == h["id"] and r["clip"] == res["clip"])
            if n_layer:
                md.append(f"Layering: {n_layer} part pairs (listed above).")
            if mine:
                md += ["", "| Kind | Bone / parts | Peak | At | Flagged frames |", "|---|---|---|---|---|"]
                for r in mine:
                    peak, at = peak_text(r)
                    md.append(f"| {r['type']} | {r['what']} | {peak} | {at} | {frame_list(r['frames'])} |")
            else:
                md.append("Nothing flagged.")

    if blend_path:
        md += ["", f"## Source weights (`{os.path.relpath(blend_path, REPO)}`)", ""]
        if blend_rows:
            md += ["| Mesh | Scene | Rig | > 4 influences | Most | Sum off | Preserve Volume |",
                   "|---|---|---|---|---|---|---|"]
            for b in blend_rows:
                md.append(f"| {b['mesh']} | {b['scene']} | {b['rig']} | {b['over_4']} of {b['vertices']} | "
                          f"{b['max_influences']} | {b['sum_off']} | {'ON' if b['preserve_volume'] else 'off'} |")
        else:
            md.append("Every skinned mesh: at most 4 deform influences, sums 1, Preserve Volume off.")
    if videos:
        md += ["", "## Videos", ""] + [f"- `{os.path.relpath(v, REPO)}`" for v in videos]
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")

    data = {
        "blender": bpy.app.version_string,
        "thresholds": {"rot_warn": ROT_WARN, "rot_warn_loose": ROT_WARN_LOOSE, "rot_error": ROT_ERROR,
                       "jitter_step": JITTER_STEP, "jitter_axis": JITTER_AXIS, "clip_faces": CLIP_FACES,
                       "weight_tol": WEIGHT_TOL},
        "heroes": [{
            "id": h["id"], "file": h["file"], "contact": h["contact"], "weights": h["weights"],
            "bind_pairs": h["bind_pairs"], "loose_bones": sorted(h["loose"]),
            "clips": [{
                "clip": res["clip"], "frames": len(res["frames"]), "loop": res["loop"],
                "flagged": [{"frame": f, "time": round(f / FPS, 4), "issues": sorted(res["issues"][f], key=issue_rank)}
                            for f in sorted(res["issues"])],
                "peaks": {b: {"deg": round(d, 2), "frame": f, "seam": s} for b, (d, f, s) in res["peaks"].items()},
            } for res in h["clips"]],
        } for h in heroes],
        "blend": blend_rows,
        "videos": [os.path.relpath(v, REPO) for v in videos],
    }
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
    return rows + layering


# --- Main ---------------------------------------------------------------------------------

def check_hero(path, clips, out_dir, video):
    scene = reset_scene()
    rig, meshes, acts, hero = load_hero(path)
    missing = [c for c in clips if c not in acts]
    if missing:
        raise SystemExit(f"{path}: no clip {missing}; has {sorted(acts)}")
    hit_time = float(rig["hitTime"])
    loose = loose_bones(rig)
    topo = Topology(rig, meshes)
    bind = bind_pose_pairs(scene, rig, topo)
    print(f"CHECK {hero}: {topo.nf} faces, {len(bind)} bind-pose pairs ignored, loose {sorted(loose)}")

    results = []
    for name in clips:
        res = analyse_clip(scene, rig, topo, acts[name], name, loose, bind, hit_time)
        if res["loop"]:
            # The seam step on its own, for the report.
            set_action(rig, acts[name])
            scene.frame_set(res["frames"][-1])
            last = local_rotations(rig)
            scene.frame_set(res["frames"][0])
            first = local_rotations(rig)
            res["seam_steps"] = {b: step(last[b], first[b])[0] for b in last}
        n_flag = sum(1 for found in res["issues"].values() if any(is_pop(i) for i in found))
        print(f"CHECK {hero} {name}: {len(res['frames'])} frames, {n_flag} flagged")
        results.append(res)

    last = int(round(acts["Attack"].frame_range[1]))
    frame = hit_time * FPS
    contact = {"hitTime": hit_time, "frame": round(frame, 3), "whole": abs(frame - round(frame)) < 1e-3,
               "inside": 0.0 <= frame <= last, "last_frame": last}

    videos = []
    if video:
        render_setup(scene, VIEW_PX, VIEW_PX)
        scene.display.shading.color_type = "MATERIAL"
        scene.world.color = BACKGROUND
        add_ground(scene, 40, GROUND)
        base = flag_materials(topo)
        for res in results:
            videos.append(film_clip(scene, rig, topo, base, acts[res["clip"]], res, hero, out_dir))
            print(f"VIDEO {videos[-1]}")

    return {"id": hero, "file": os.path.relpath(os.path.abspath(path), REPO), "clips": results,
            "contact": contact, "weights": glb_weights(topo), "faces": topo.nf, "bind_pairs": len(bind),
            "loose": loose}, videos


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="check_anim.py")
    ap.add_argument("--glb", action="append", required=True, help="hero GLB (repeatable)")
    ap.add_argument("--blend", help="source .blend to check weights in (opened, never saved)")
    ap.add_argument("--out", default=os.path.join(REPO, "shots", "anim"))
    ap.add_argument("--clips", default=",".join(CLIPS), help="comma-separated clip names")
    ap.add_argument("--no-video", action="store_true")
    args = ap.parse_args(argv)

    if bpy.app.version[:2] < (5, 2):
        raise SystemExit(f"Blender {bpy.app.version_string} is too old; use the 5.2 that "
                         "tools/fetch_assets.sh installs.")
    clips = [c for c in args.clips.split(",") if c]
    unknown = sorted(set(clips) - set(CLIPS))
    if unknown:
        raise SystemExit(f"unknown clips {unknown}; known: {list(CLIPS)}")
    if not args.no_video:
        check_gl()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    heroes, videos = [], []
    for path in args.glb:
        h, v = check_hero(path, clips, out_dir, not args.no_video)
        heroes.append(h)
        videos += v
    blend_rows = blend_weights(os.path.abspath(args.blend)) if args.blend else []
    rows = write_report(out_dir, heroes, blend_rows, args.blend and os.path.abspath(args.blend), videos)
    print(f"CHECK_DONE {len(rows)} flagged rows; report in {os.path.join(out_dir, 'report.md')}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Blender prints an uncaught exception from a --python script and then
        # exits 0, which would hide a failed check.
        import traceback
        traceback.print_exc()
        sys.exit(1)
