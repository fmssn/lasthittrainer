"""
Build the sprite sources for everything in the lane that is not a character: the siege
creeps' catapults, the towers, the scenery, and the ground's texture tiles.

Run headless after build_characters.py (it shares its palette, camera and recipe
writer), with the Synty packs unpacked into art_src/synty/:
    blender --background --factory-startup --python tools/blender/build_props.py -- [--only siege_creep_radiant]

Each prop becomes art_src/sprites/build/<id>.blend with its recipes beside it, rendered
by supplyline and packed by pack_sprites.py like a character. Every model is baked into
game metres first (54 sim units each, appearance.ts), with its origin on the ground in
the middle of its footprint and its front toward -Y, so every recipe renders it at
`scale = 1` and the game places a sprite by its feet with no per-model numbers.

- A catapult has no skeleton: its arm, crank and wheels are separate meshes in the
  packs, keyed here about their own pivots. Attack cocks the arm over the wind-up and
  throws it on the frame the sim releases the shot (the siege creep's 0.7 s attack
  point), Walk rolls the wheels, Death tips it over its axle. The game plays these by
  the same rules as a creep's clips.
- A tower is one still, facing the camera.
- Scenery is a still per model in eight facings, so the treeline can turn each one
  and no two neighbours are the same picture. Radiant's side is living trees, Dire's
  dead ones; rocks and bushes fill in along both ridges.
- The ground tiles are the packs' seamless ground textures, scaled down. terrain.ts
  mixes them, so the tiles never repeat one-for-one.
"""

import argparse
import glob
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_characters as bc  # noqa: E402

SYNTY = bc.SYNTY
OUT = bc.OUT
GROUND_OUT = os.path.join(bc.REPO, "public", "sprites", "ground")
NATURE = os.path.join(SYNTY, "nature", "Source Files")
KINGDOM_FBX = bc.KINGDOM_FBX
FORTRESS_FBX = bc.FORTRESS_FBX
NATURE_FBX = os.path.join(NATURE, "FBX")
NATURE_TEX = os.path.join(NATURE, "Textures", "PolygonNature_01.png")
SAMURAI_FBX = os.path.join(bc.SAMURAI, "FBX")
SAMURAI_TEX = os.path.join(bc.SAMURAI, "Textures", "PolygonSamurai_Tex_01.png")
ELVEN_FBX = os.path.join(bc.ELVEN, "FBX")

SOURCE_FPS = 30
# The catapult's clips play at 15 fps: its every frame is several times a creep's,
# and a machine swinging one arm reads as well at half the rate.
SIEGE_FPS = 15
# The siege creep's timing (src/sim/units.ts): no attack speed, so this is what plays.
SIEGE_SWING = (0.7, 0.5)
# A creep's density for the tower; the catapult, several times a creep's size in every
# frame, at a softer one (it is the creep that never enters a drill of ten waves).
SIEGE_PIXELS_PER_METRE = 56.0
TOWER_PIXELS_PER_METRE = 88.0
# Scenery stands behind the ridges, out of the fight: a little softer is fine.
SCENERY_PIXELS_PER_METRE = 72.0
SCENERY_DIRECTIONS = 8

SIEGE = {
    "siege_creep_radiant": {
        "file": os.path.join(KINGDOM_FBX, "SK_Wep_Catapult_01.fbx"),
        "texture": bc.KINGDOM_TEX,
        "front": "+x",
        "scale": 0.72,
        # A mangonel: the bucket lies back on the ground and the arm swings up over its
        # axle until it is nearly upright, which is when the stone leaves.
        "arm": {"part": "SK_Wep_Catapult_Arm_01", "pivot": None, "axis": (0, 1, 0), "cock": -2.0, "throw": 125.0},
        "crank": {"part": "SK_Wep_Catapult_Crank_01", "pivot": None, "axis": (0, 1, 0), "turns": 1.0},
        "wheels": {"parts": ["SK_Wep_Catapult_Wheel_fl", "SK_Wep_Catapult_Wheel_fr", "SK_Wep_Catapult_Wheel_rl", "SK_Wep_Catapult_Wheel_rr"], "pivot": "origin", "axis": (0, 1, 0)},
    },
    "siege_creep_dire": {
        "file": os.path.join(FORTRESS_FBX, "SM_Veh_Catapult_01.fbx"),
        "texture": bc.FORTRESS_TEX,
        "front": "-y",
        "scale": 0.6,
        # A trebuchet: the spiked counterweight drops and the cage swings up and over
        # the top of the frame. Its pivot is the crescent at the frame's apex.
        "arm": {"part": "SM_Veh_Catapult_01_Arm_01", "pivot": (0.0, 0.3, 3.3), "axis": (1, 0, 0), "cock": -22.0, "throw": 100.0},
        "wheels": {"parts": ["SM_Veh_Catapult_01_Wheel_B_01", "SM_Veh_Catapult_01_Wheel_F_01", "SM_Veh_Catapult_01_Wheel_M_01"], "pivot": "centre", "axis": (1, 0, 0)},
    },
}

TOWERS = {
    # Kingdom's watchtower, and Dark Fortress's spiked corner tower, at a tier 1 tower's
    # drawn height (appearance.ts TOWER_HEIGHT, 260 sim units).
    "tower_radiant": {"file": os.path.join(KINGDOM_FBX, "SM_Bld_Preset_Tower_01_Optimized.fbx"), "texture": bc.KINGDOM_TEX, "front": "-y", "height": 4.8},
    "tower_dire": {"file": os.path.join(FORTRESS_FBX, "SM_Bld_Corner_Tower_03.fbx"), "texture": bc.FORTRESS_TEX, "front": "-y", "height": 4.8},
}


def _scenery(folder, texture, names, height, side, kind):
    pack = {NATURE_FBX: "nature", KINGDOM_FBX: "kingdom", FORTRESS_FBX: "fortress", SAMURAI_FBX: "samurai"}[folder]
    short = lambda name: name.replace("SM_", "").replace("Env_", "").replace("Plant_", "").lower()  # noqa: E731
    return [(f"{pack}_{short(name)}", os.path.join(folder, name + ".fbx"), texture, height, side, kind) for name in names]


# (variant, file, texture, height in game metres, side, kind). Heights are the tallest
# a model is drawn at; terrain.ts scales each placement down a little from there.
SCENERY = (
    _scenery(NATURE_FBX, NATURE_TEX, ["SM_Tree_01", "SM_Tree_02", "SM_Tree_03", "SM_Tree_04"], 4.8, "radiant", "tree")
    + _scenery(KINGDOM_FBX, bc.KINGDOM_TEX, ["SM_Env_Tree_Round_01", "SM_Env_Tree_Round_02", "SM_Env_Tree_Round_03", "SM_Env_Tree_Round_04"], 5.2, "radiant", "tree")
    + _scenery(NATURE_FBX, NATURE_TEX, ["SM_Tree_Large_01"], 5.6, "radiant", "tree")
    + _scenery(FORTRESS_FBX, bc.FORTRESS_TEX, ["SM_Env_Tree_Dead_01", "SM_Env_Tree_Dead_02"], 5.4, "dire", "tree")
    # Kingdom's other dead trees are bare poles, and Nature's carry leaves off a texture
    # of their own that the atlas cannot stand in for.
    + _scenery(KINGDOM_FBX, bc.KINGDOM_TEX, ["SM_Env_Tree_Dead_04"], 4.6, "dire", "tree")
    + _scenery(NATURE_FBX, NATURE_TEX, ["SM_Rock_01", "SM_Rock_02", "SM_Rock_03", "SM_Rock_04"], 1.6, "both", "rock")
    + _scenery(KINGDOM_FBX, bc.KINGDOM_TEX, ["SM_Env_Rock_01", "SM_Env_Rock_02", "SM_Env_Rock_03", "SM_Env_Rock_04"], 1.8, "both", "rock")
    + _scenery(SAMURAI_FBX, SAMURAI_TEX, ["SM_Env_Rock_Large_01", "SM_Env_Rock_Large_02", "SM_Env_Rock_Large_03"], 2.2, "both", "rock")
    + _scenery(NATURE_FBX, NATURE_TEX, ["SM_Plant_Bush_01", "SM_Plant_Bush_02", "SM_Plant_Bush_03"], 1.1, "radiant", "bush")
    + _scenery(KINGDOM_FBX, bc.KINGDOM_TEX, ["SM_Env_Bush_01", "SM_Env_Bush_02", "SM_Env_Bush_03"], 1.2, "radiant", "bush")
    + _scenery(FORTRESS_FBX, bc.FORTRESS_TEX, ["SM_Env_Bush_Dead_01", "SM_Env_Bush_Dead_02", "SM_Env_Bush_Dead_03", "SM_Env_Bush_Dead_04"], 1.2, "dire", "bush")
)

# The ground tiles: seamless textures from the packs, by the name terrain.ts loads them as.
KINGDOM = os.path.join(SYNTY, "kingdom", "Textures")
GROUND = {
    "grass": os.path.join(KINGDOM, "PFK_Texture_Ground_Grass_01.png"),
    "grass_dark": os.path.join(KINGDOM, "PFK_Texture_Ground_Grass_01_Dark.png"),
    "flowers": os.path.join(KINGDOM, "PFK_Texture_Ground_Grass_03.png"),
    "path": os.path.join(KINGDOM, "PFK_Texture_Ground_Sand_01.png"),
    "mud": os.path.join(NATURE, "Textures", "Ground_Textures", "Mud.png"),
    "mud_stones": os.path.join(KINGDOM, "PFK_Texture_Ground_Mud_02.png"),
    "path_dire": os.path.join(KINGDOM, "PFK_Texture_Ground_Mud_01.png"),
    "moss": os.path.join(NATURE, "Textures", "Ground_Textures", "Moss.png"),
}
GROUND_TILE = 1024


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="build_props.py")
    parser.add_argument("--only", choices=sorted([*SIEGE, *TOWERS, "scenery", "ground"]))
    args = parser.parse_args(argv)
    if not os.path.isdir(SYNTY):
        bc.fail(f"{SYNTY} is missing: unpack the Synty packs there (art_src/README.md)")
    os.makedirs(OUT, exist_ok=True)
    if not os.path.isfile(bc.PALETTE):
        bc.write_palette()
    for prop_id, spec in SIEGE.items():
        if not args.only or args.only == prop_id:
            build_siege(prop_id, spec)
    for prop_id, spec in TOWERS.items():
        if not args.only or args.only == prop_id:
            build_still(prop_id, [("Idle", spec["file"], spec["texture"], spec["front"], spec["height"])], TOWER_PIXELS_PER_METRE, 1)
    if not args.only or args.only == "scenery":
        build_still("scenery", [(v, f, t, "-y", h) for v, f, t, h, _, _ in SCENERY], SCENERY_PIXELS_PER_METRE, SCENERY_DIRECTIONS,
                    {v: {"side": s, "kind": k} for v, _, _, _, s, k in SCENERY})
    if not args.only or args.only == "ground":
        build_ground()


# --- Importing ----------------------------------------------------------------------------------

_TEXTURES = {}


def pack_textures() -> dict:
    """Every texture the packs ship, by lower-case file name. A building's walls sample a
    tiling brick texture rather than the atlas, and its FBX names that file."""
    if not _TEXTURES:
        for path in glob.glob(os.path.join(SYNTY, "**", "*.*"), recursive=True):
            name = os.path.basename(path).lower()
            if name.endswith((".png", ".tga")) and "normal" not in name:
                _TEXTURES.setdefault(name, path)
    return _TEXTURES


def load(path: str, atlas: str) -> list:
    """Imports a model and gives it unfiltered materials: the atlas, except where the
    model's own material names a tiling texture the packs ship."""
    objs = bc.synty.imp(path)
    materials = {}
    for o in objs:
        if o.type != "MESH":
            continue
        for i, slot in enumerate(o.data.materials):
            texture = atlas
            if slot and slot.node_tree:
                for node in slot.node_tree.nodes:
                    if node.type == "TEX_IMAGE" and node.image:
                        name = os.path.basename(node.image.filepath.replace("\\", "/")).lower()
                        # The atlases go by several names across the packs' own files.
                        if name in pack_textures() and not name.startswith("polygon"):
                            texture = pack_textures()[name]
                        break
            if texture not in materials:
                materials[texture] = bc.texture_material(os.path.basename(texture), texture)
            o.data.materials[i] = materials[texture]
    meshes = [o for o in objs if o.type == "MESH"]
    for o in objs:
        if o not in meshes:
            bpy.data.objects.remove(o)
    return meshes


FRONTS = {"-y": 0.0, "+x": -90.0, "+y": 180.0, "-x": 90.0}


def bake(meshes: list, front: str, scale=None, height=None) -> Matrix:
    """Bakes every transform into the meshes and puts the model in game metres, front toward
    -Y, standing on the origin. Returns the matrix from the file's axes to the baked ones."""
    for o in meshes:
        if o.data.users > 1:
            o.data = o.data.copy()
        world = o.matrix_world.copy()
        o.parent = None
        o.data.transform(world)
        o.matrix_world = Matrix()
    turn = Matrix.Rotation(math.radians(FRONTS[front]), 4, "Z")
    points = np.concatenate([vertices(o) for o in meshes]) @ np.array(turn.to_3x3()).T
    lo, hi = points.min(axis=0), points.max(axis=0)
    k = scale if scale is not None else height / (hi[2] - lo[2])
    centre = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]))
    m = Matrix.Scale(k, 4) @ Matrix.Translation(-centre) @ turn
    for o in meshes:
        o.data.transform(m)
    return m


def vertices(o) -> np.ndarray:
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def set_pivot(o, pivot: Vector) -> None:
    """Moves an object's origin to `pivot` without moving its mesh."""
    o.data.transform(Matrix.Translation(-pivot))
    o.location = pivot


def bounds(o):
    co = vertices(o) + np.array(o.location)
    return co.min(axis=0), co.max(axis=0)


# --- Catapults ----------------------------------------------------------------------------------


def build_siege(prop_id: str, spec: dict) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = SOURCE_FPS
    meshes = load(spec["file"], spec["texture"])
    by_name = {o.name.split(".")[0]: o for o in meshes}
    # The arm's pivot, if the file puts its origin elsewhere, is in the file's own axes.
    native = {}
    for key in ("arm", "crank"):
        part = spec.get(key)
        if part:
            o = by_name[part["part"]]
            native[key] = Vector(part["pivot"]) if part["pivot"] is not None else o.matrix_world.translation.copy()
    wheel_origins = {n: by_name[n].matrix_world.translation.copy() for n in spec["wheels"]["parts"]}
    m = bake(meshes, spec["front"], scale=spec["scale"])
    rot = m.to_3x3().normalized()

    def axis(v):
        return (rot @ Vector(v)).normalized()

    moving = {}
    for key in ("arm", "crank"):
        if key in native:
            o = by_name[spec[key]["part"]]
            set_pivot(o, m @ native[key])
            moving[key] = (o, axis(spec[key]["axis"]))
    wheels = []
    for name in spec["wheels"]["parts"]:
        o = by_name[name]
        if spec["wheels"]["pivot"] == "origin":
            set_pivot(o, m @ wheel_origins[name])
        else:
            lo, hi = bounds(o)
            set_pivot(o, Vector((lo + hi) / 2))
        lo, hi = bounds(o)
        wheels.append((o, axis(spec["wheels"]["axis"]), (hi[2] - lo[2]) / 2))
    moved = {o for o, _ in moving.values()} | {o for o, _, _ in wheels}
    chassis = [o for o in meshes if o not in moved]
    body = chassis[0]
    # Everything hangs off the chassis, so Death can tip the whole machine by one object.
    for o in meshes:
        if o is not body:
            world = o.matrix_world.copy()
            o.parent = body
            o.matrix_parent_inverse = Matrix()
            o.matrix_world = world
    for o in meshes:
        o.rotation_mode = "QUATERNION"

    arm, arm_axis = moving["arm"]
    arm_spec = spec["arm"]
    point, backswing = SIEGE_SWING
    hit = round(point * SIEGE_FPS)
    end = round((point + backswing) * SIEGE_FPS)
    throw_frames = 2

    def arm_angle(k):
        if k <= hit - throw_frames:
            return arm_spec["cock"] * ease(k / (hit - throw_frames))
        if k <= hit:
            u = (k - (hit - throw_frames)) / throw_frames
            return arm_spec["cock"] + (arm_spec["throw"] - arm_spec["cock"]) * u * u
        return arm_spec["throw"] * (1 - ease((k - hit) / (end - hit)))

    # A loop's roll is half a turn of the first wheel, 22.5 degrees a frame: a whole turn
    # in eight frames would step an eight-spoked wheel one spoke a frame, and it would
    # look stopped. Every other wheel turns by the nearest eighth of a turn to its own
    # share of that distance, so the loop joins up.
    loop = 8
    distance = math.pi * wheels[0][2]
    turns = [round(distance / r / (math.pi / 4)) * (math.pi / 4) for _, _, r in wheels]

    def pose(k, clip):
        a = arm_angle(k) if clip == "Attack" else (arm_spec["cock"] * ease(min(1, k / 5)) if clip == "Death" else 0.0)
        arm.rotation_quaternion = Quaternion(arm_axis, math.radians(a))
        if "crank" in moving:
            crank, crank_axis = moving["crank"]
            c = spec["crank"]["turns"] * 2 * math.pi * min(1.0, k / (hit - throw_frames)) if clip == "Attack" else 0.0
            crank.rotation_quaternion = Quaternion(crank_axis, -c)
        for (o, ax, _), turn in zip(wheels, turns):
            o.rotation_quaternion = Quaternion(ax, turn * k / loop if clip == "Walk" else 0.0)
        if clip == "Death":
            u = ease(min(1.0, k / 6))
            body.rotation_quaternion = Quaternion(Vector((0, 1, 0)), math.radians(24 * u))
            body.location = (0, 0, -0.18 * u)
        else:
            body.rotation_quaternion = Quaternion()
            body.location = (0, 0, 0)

    clips = {
        "Idle": {"frames": 1, "fps": 15, "loop": True},
        "Walk": {"frames": loop, "fps": SIEGE_FPS, "loop": True, "groundSpeed": round(distance / (loop / SIEGE_FPS), 4)},
        "Attack": {"frames": end + 1, "fps": SIEGE_FPS, "loop": False, "hitFrame": hit, "hitTime": hit / SIEGE_FPS},
        "Death": {"frames": 8, "fps": SIEGE_FPS, "loop": False},
    }
    for name, info in clips.items():
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        for o in meshes:
            o.animation_data_create()
            o.animation_data.action = action
        for k in range(info["frames"]):
            pose(k, name)
            for o in meshes:
                o.keyframe_insert("location", frame=k)
                o.keyframe_insert("rotation_quaternion", frame=k)
        for fcurve in bc.all_fcurves(action):
            for p in fcurve.keyframe_points:
                p.interpolation = "CONSTANT"
        action.use_frame_range = True
        action.frame_start, action.frame_end = 0, info["frames"] - 1
        bc.log(f"{prop_id} {name}: {info['frames']} frames" + (f", released on {hit}" if name == "Attack" else ""))
    finish(prop_id, clips, SIEGE_PIXELS_PER_METRE, 16, action_clips=True)


def ease(u: float) -> float:
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


# --- Stills -------------------------------------------------------------------------------------


def build_still(prop_id: str, items: list, ppm: float, directions: int, extra=None) -> None:
    """One .blend holding every still of a sheet, each in its own collection, and a recipe
    per still that renders only that one."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    groups = {}
    for name, path, texture, front, height in items:
        meshes = load(path, texture)
        if not meshes:
            bc.fail(f"{path} has no meshes")
        bake(meshes, front, height=height)
        coll = bpy.data.collections.new(name)
        scene.collection.children.link(coll)
        for o in meshes:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            coll.objects.link(o)
            o.name = f"{name}__{o.name}"
        groups[name] = meshes
    clips = {}
    extents = {}
    for name, meshes in groups.items():
        for other, ms in groups.items():
            for o in ms:
                o.hide_render = other != name
        extents[name] = bc.measure(scene, None, None, 1)
        clips[name] = {"frames": 1, "fps": 1, "loop": True, **(extra or {}).get(name, {})}
    for ms in groups.values():
        for o in ms:
            o.hide_render = False
    finish(prop_id, clips, ppm, directions, extents=extents, objects={n: [o.name for o in ms] for n, ms in groups.items()})


def finish(prop_id: str, clips: dict, ppm: float, directions: int, action_clips=False, extents=None, objects=None) -> None:
    scene = bpy.context.scene
    if extents is None:
        extents = {name: bc.measure(scene, None, name, info["frames"]) for name, info in clips.items()}
    if action_clips:
        bc.play(scene, "Idle")
        scene.frame_set(0)
    bpy.data.orphans_purge(do_recursive=True)
    bpy.ops.file.pack_all()
    blend = os.path.join(OUT, f"{prop_id}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True, copy=True)
    for name, info in clips.items():
        clip = name.lower()
        info["sprite"] = bc.recipe(prop_id, clip, name if action_clips else None, info["frames"], extents[name], ppm, directions)
        if objects:
            add_objects(os.path.join(OUT, prop_id, f"{clip}.toml"), objects[name])
    meta = {"id": prop_id, "pixelsPerMetre": ppm, "directions": directions, "clips": clips}
    with open(os.path.join(OUT, f"{prop_id}.json"), "w", newline="\n") as f:
        json.dump(meta, f, indent=1)
    bc.log(f"{prop_id}: {blend}")


def add_objects(path: str, names: list) -> None:
    """A still's recipe renders only its own objects from the shared .blend."""
    with open(path) as f:
        text = f.read()
    listed = ", ".join(json.dumps(n) for n in names)
    text = text.replace("front = \"-y\"\n", f"front = \"-y\"\nobjects = [{listed}]\n", 1)
    with open(path, "w", newline="\n") as f:
        f.write(text)


# --- Ground -------------------------------------------------------------------------------------


def build_ground() -> None:
    """Each ground texture, box-filtered in linear light to GROUND_TILE square. Not snapped
    to the palette: the textures' shading is a few percent across a whole tile, and
    snapping flattens it into two or three blotches of one colour."""
    os.makedirs(GROUND_OUT, exist_ok=True)
    for name, path in GROUND.items():
        image = bpy.data.images.load(path, check_existing=False)
        w, h = image.size
        px = np.empty(w * h * 4, dtype=np.float32)
        image.pixels.foreach_get(px)
        bpy.data.images.remove(image)
        rgb = px.reshape(h, w, 4)[..., :3].astype(np.float64)
        if w % GROUND_TILE or h % GROUND_TILE:
            bc.fail(f"{path} is {w}x{h}, not a multiple of {GROUND_TILE}")
        lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
        fx, fy = w // GROUND_TILE, h // GROUND_TILE
        lin = lin.reshape(GROUND_TILE, fy, GROUND_TILE, fx, 3).mean(axis=(1, 3))
        srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
        write_rgb(os.path.join(GROUND_OUT, f"{name}.png"), (np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8))
        bc.log(f"ground {name}: {w}x{h} -> {GROUND_TILE}")


def write_rgb(path: str, rgb: np.ndarray) -> None:
    import struct
    import zlib

    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[h - 1 - y].tobytes() for y in range(h))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    header = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    main()
