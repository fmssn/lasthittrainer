"""Synty POLYGON characters in Blender: import, dress, and pose from Synty's animation packs.

Used by build_heroes.py. Two things about the packs make this more than an import:

- The FBX importer gives an animation file's bones other rest frames than a skinned
  character's (a character's come from its bind pose, a clip's from its own first pose),
  so copying channel values from a clip onto a character does nothing sensible. The
  packs' reference character (Models/PolygonSyntyCharacter.fbx) is in the clips'
  convention and stands in the bind T-pose every POLYGON character shares, so per bone
  C = clip_rest^-1 @ char_rest turns a clip's armature-space frame into the character's.
- The Samurai pack names the same skeleton differently (Pelvis/spine_01 against
  Hips/Spine_01). Bones are matched by where their joints sit in that shared bind
  pose, not by name.
"""

import bpy
from mathutils import Matrix

# Joints of two rigs further apart than this in the bind pose are different joints (cm).
JOINT_TOLERANCE = 0.6


def imp(path: str) -> list:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def armature(objs: list):
    return next(o for o in objs if o.type == "ARMATURE")


def load_reference(path: str):
    """The animation packs' reference character, armature only, hidden."""
    objs = imp(path)
    ref = armature(objs)
    for o in objs:
        if o is not ref:
            bpy.data.objects.remove(o)
    ref.hide_render = True
    ref.hide_set(True)
    return ref


def load_clip(path: str):
    """An animation file's armature, hidden. Its action plays on the scene frame."""
    objs = imp(path)
    src = armature(objs)
    for o in objs:
        if o is not src:
            bpy.data.objects.remove(o)
    src.hide_render = True
    src.hide_set(True)
    return src


def add_props(char, ref) -> None:
    """Gives the character the packs' Prop_R / Prop_L hand bones, which carry the weapon in
    every clip. Their rest is the reference's, so they need no conversion of their own."""
    bpy.context.view_layer.objects.active = char
    bpy.ops.object.mode_set(mode="EDIT")
    bones = char.data.edit_bones
    for prop, hand in (("Prop_R", "Hand_R"), ("Prop_L", "Hand_L")):
        rest = ref.data.bones[prop]
        hand_at = ref.data.bones[hand].head_local
        parent = next(b for b in bones if (b.head - hand_at).length < JOINT_TOLERANCE)
        bone = bones.new(prop)
        bone.head, bone.tail = rest.head_local, rest.tail_local
        bone.matrix = rest.matrix_local
        bone.length = rest.length
        bone.parent = parent
    bpy.ops.object.mode_set(mode="OBJECT")


class Retarget:
    def __init__(self, ref, char):
        self.names = {}  # character bone -> clip bone
        for b in char.data.bones:
            best = min(ref.data.bones, key=lambda a: (a.head_local - b.head_local).length)
            if (best.head_local - b.head_local).length < JOINT_TOLERANCE and best.name not in self.names.values():
                self.names[b.name] = best.name
        self.conv = {
            c: ref.data.bones[a].matrix_local.to_quaternion().inverted() @ char.data.bones[c].matrix_local.to_quaternion()
            for c, a in self.names.items()
        }
        self.hips = self.bone("Hips")

    def bone(self, clip_name: str) -> str:
        """The character's name for a clip's bone."""
        return next(c for c, a in self.names.items() if a == clip_name)

    def pose(self, dst, src) -> None:
        """Sets dst's pose (matrix_basis) from src's evaluated pose. Bones keep the
        character's lengths: only the hips take the clip's translation."""
        P = {}
        for b in dst.data.bones:  # parents come before children
            a = self.names.get(b.name)
            spb = src.pose.bones.get(a) if a else None
            if b.parent:
                place = P[b.parent.name] @ b.parent.matrix_local.inverted() @ b.matrix_local
            else:
                place = b.matrix_local.copy()
            if spb is None:
                pose = place
            elif a.startswith("Prop_"):
                # A prop moves against its hand in some clips; carry that offset over.
                hand = P[b.parent.name] @ self.conv[b.parent.name].inverted().to_matrix().to_4x4()
                pose = hand @ spb.parent.matrix.inverted() @ spb.matrix
            else:
                loc = spb.matrix.translation if b.name == self.hips else place.translation
                pose = Matrix.LocRotScale(loc, spb.matrix.to_quaternion() @ self.conv[b.name], None)
            P[b.name] = pose
            rel = (b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local
            parent = P[b.parent.name] if b.parent else Matrix()
            dst.pose.bones[b.name].matrix_basis = rel.inverted() @ parent.inverted() @ pose


def attach(objs: list, char, bone: str, rest_world) -> None:
    """Parents static meshes to a bone, placed where rest_world(obj) puts them in the bind pose."""
    char.data.pose_position = "REST"
    bpy.context.view_layer.update()
    for o in objs:
        world = rest_world(o)
        o.parent = char
        o.parent_type = "BONE"
        o.parent_bone = bone
        bpy.context.view_layer.update()
        o.matrix_world = world
    char.data.pose_position = "POSE"
