"""
Build the character sprite sources from Synty's POLYGON packs, heroes and creeps: one
.blend per character, and the sprite recipes that render it.

Run headless, with the Synty packs unpacked into art_src/synty/ (git-ignored, see
art_src/README.md):
    blender --background --factory-startup --python tools/blender/build_characters.py -- [--only swordmaster]

For each entry in CHARACTERS the script imports the character, gives it its attachments
and what it holds, retargets Synty clips onto it (synty.py) and bakes four actions,
Idle, Walk, Attack and Death, keyed on every sampled frame from frame 0. It writes,
under art_src/sprites/build/ (git-ignored, since it holds Synty's meshes):

    <id>.blend            the posed character, textures packed
    <id>/<clip>.toml      one sprite recipe per clip, for supplyline's make_sprite.py
    <id>.json             what the game needs to know about each clip

Then supplyline renders the recipes into sheets, on the render farm:
    ~/supplyline/tools/sprites/remote_render.cmd art_src/sprites/build/*/*.toml
and pack_sprites.py packs the sheets into public/sprites/.

Attack is retimed piecewise so its contact (or release) lands exactly on a sampled
frame at the unit's level-1 attack point, and the swing ends on the level-1 backswing.
The game still rescales it to the attack point it is playing at.

A hero's team colour is a palette swap: the faces the team colour replaces are moved
to a material that renders in a key colour, KEY, which palette.hex keeps a ramp of and
nothing else is near. See pack_sprites.py. A creep needs none: each team's is a
different character, as Dota's are.
"""

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synty  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SYNTY = os.path.join(REPO, "art_src", "synty")
OUT = os.path.join(REPO, "art_src", "sprites", "build")
PALETTE = os.path.join(REPO, "art_src", "sprites", "palette.hex")

SAMURAI = os.path.join(SYNTY, "samurai", "SourceFiles")
ELVEN = os.path.join(SYNTY, "elven")
KINGDOM = os.path.join(SYNTY, "kingdom")
FORTRESS = os.path.join(SYNTY, "fortress")
KINGDOM_TEX = os.path.join(KINGDOM, "Textures", "PolygonFantasyKingdom_Texture_01_A.png")
FORTRESS_TEX = os.path.join(FORTRESS, "Texture", "Alts", "PolygonDarkFortress_Texture_01_A.png")
ELVEN_ATTACH = os.path.join(ELVEN, "FBX", "Characters", "Attachments")
SWORD = os.path.join(SYNTY, "anim_sword", "SourceFiles", "Animations", "Polygon")
BOW = os.path.join(SYNTY, "anim_bow", "SourceFiles", "Animations", "Polygon")
LOCO = os.path.join(SYNTY, "anim_loco", "SourceFiles", "Animations", "Polygon")
REFERENCE = os.path.join(SYNTY, "anim_sword", "SourceFiles", "Models", "PolygonSyntyCharacter.fbx")
ELVEN_TEX = os.path.join(ELVEN, "Textures", "Alts", "PolygonElven_Texture_01_A.png")

# Synty clips are keyed at 30 fps.
SOURCE_FPS = 30
# The key colour the team colour replaces (linear RGB). Magenta: nothing on either hero
# is near it, which pack_sprites.py checks.
KEY = (1.0, 0.0, 1.0)

# Level-1 swing timing, as the sim computes it (src/sim/heroes.ts, attack speed from
# base attack speed + agility): attack point and backswing divided by attack speed.
SWORDMASTER_SWING = (0.33 / 1.42, 0.64 / 1.42)
FROST_ARCHER_SWING = (0.50 / 1.24, 0.55 / 1.24)
# Creeps have no attack speed bonus, so theirs is the template's (src/sim/units.ts).
MELEE_CREEP_SWING = (0.467, 0.3)
RANGED_CREEP_SWING = (0.5, 0.3)

# Sprite pixels per metre of model. A hero is drawn 145 sim units tall and a melee creep
# 100 (appearance.ts), so a creep's metre is 0.69 of a hero's on screen and needs that
# many fewer pixels to be as sharp. The ranged creep, drawn at 0.88, shares the melee's.
HERO_PIXELS_PER_METRE = 128.0
CREEP_PIXELS_PER_METRE = 88.0

LIGHT_SLASH = [
    (os.path.join(SWORD, "Attack", "LightCombo01", "A_Attack_LightCombo01A_Sword.fbx"), 2, 26),
    (os.path.join(SWORD, "Attack", "LightCombo01", "A_Attack_LightCombo01A_ReturnToIdle_Sword.fbx"), 26, 49),
]
# There is no Synty spell pack; the sword pack's thrust held with a staff reads as a
# cast pointed at the target, and the pointing is the moment the bolt leaves.
STAFF_THRUST = [
    (os.path.join(SWORD, "Attack", "HeavyStab01", "A_Attack_HeavyStab01_Sword.fbx"), 2, 34),
    (os.path.join(SWORD, "Attack", "HeavyStab01", "A_Attack_HeavyStab01_ReturnToIdle_Sword.fbx"), 43, 91),
]
SWORD_IDLE = os.path.join(SWORD, "Idle", "Base", "A_Idle_Base_Sword.fbx")
MASC_RUN = os.path.join(LOCO, "Masculine", "Locomotion", "Run", "A_Run_F_Masc.fbx")
MASC_RUN_ROOT = os.path.join(LOCO, "Masculine", "Locomotion", "Run", "A_Run_F_RootMotion_Masc.fbx")


def creep(body: str, texture: str, held: list, swing: tuple, attack: list, hit: tuple, death: str, keep=None, attachments=()) -> dict:
    """A lane creep: the sword pack's stance and swing, the forward run, one death."""
    return {
        "body": body,
        "keep": keep,
        "texture": texture,
        "attachments": list(attachments),
        "pixels_per_metre": CREEP_PIXELS_PER_METRE,
        "team_cells": [],
        "held": held,
        "clips": {
            "Idle": {"loop": True, "fps": 15, "chain": [(SWORD_IDLE, None, None)]},
            "Walk": {"loop": True, "fps": 30, "chain": [(MASC_RUN, None, None)], "root_motion": MASC_RUN_ROOT},
            "Attack": {"loop": False, "fps": 30, "chain": attack, "hit": hit, "swing": swing},
            "Death": {"loop": False, "fps": 15, "chain": [(os.path.join(SWORD, "Death", death), None, None)]},
        },
    }


def prop(path: str, texture: str, bone: str, rotation=(0, 0, 0)) -> dict:
    # Kingdom's and Dark Fortress's weapons are laid out as the sword pack's own
    # reference sword is: grip on the origin, blade up +Z, so a blade needs no turn.
    return {"file": path, "texture": texture, "bone": bone, "scale": 1.0, "rotation": rotation}


# A shield laid out that way would keep its T-pose facing and swing flat or edge-on with
# the free hand. This is the inverse of the left prop bone's turn in the sword idle
# (frame 8), so in the stance the shield stands upright on the forearm, facing forward.
SHIELD_TURN = (-61.3, -38.8, 79.0)


KINGDOM_FBX = os.path.join(KINGDOM, "FBX")
FORTRESS_FBX = os.path.join(FORTRESS, "FBX")

CHARACTERS = {
    "swordmaster": {
        "body": os.path.join(SAMURAI, "Characters", "SK_Character_Samurai_VillageMale_02.fbx"),
        "texture": os.path.join(SAMURAI, "Textures", "Characters_Texture_01.png"),
        "attachments": [],
        "pixels_per_metre": HERO_PIXELS_PER_METRE,
        # The trousers.
        "team_cells": ["5d6a36"],
        "held": [{
            "file": os.path.join(SAMURAI, "FBX", "SM_Wep_Odachi_01.fbx"),
            "texture": os.path.join(SAMURAI, "Textures", "PolygonSamurai_Tex_01.png"),
            "bone": "Prop_R",
            # The Samurai pack's static meshes are in centimetres under a 0.01 scale.
            "scale": 100.0,
            "rotation": (0, 0, 0),
            # Set by eye in Blender, over every clip: edge forward, blade up out of the fist.
            "local_rotation": (67.4, -20.628, -41.844),
        }],
        "clips": {
            "Idle": {"loop": True, "fps": 15, "chain": [(os.path.join(SWORD, "Idle", "Base", "A_Idle_Base_Sword.fbx"), None, None)]},
            "Walk": {
                "loop": True, "fps": 30,
                "chain": [(os.path.join(LOCO, "Masculine", "Locomotion", "Run", "A_Run_F_Masc.fbx"), None, None)],
                "root_motion": os.path.join(LOCO, "Masculine", "Locomotion", "Run", "A_Run_F_RootMotion_Masc.fbx"),
            },
            "Attack": {
                "loop": False, "fps": 30,
                # The light slash, then its own return to the sword idle, so a swing
                # that runs its full backswing ends in the Idle pose.
                "chain": [
                    (os.path.join(SWORD, "Attack", "LightCombo01", "A_Attack_LightCombo01A_Sword.fbx"), 2, 26),
                    (os.path.join(SWORD, "Attack", "LightCombo01", "A_Attack_LightCombo01A_ReturnToIdle_Sword.fbx"), 26, 49),
                ],
                # Blade level and forward, filmed side-on (source frame 13 of the slash).
                "hit": (0, 13),
                "swing": SWORDMASTER_SWING,
            },
            "Death": {"loop": False, "fps": 15, "chain": [(os.path.join(SWORD, "Death", "A_Death_B_01_Sword.fbx"), None, None)]},
        },
    },
    "frost_archer": {
        "body": os.path.join(ELVEN, "FBX", "Characters", "Individual", "SM_Chr_Queen_Female_01.fbx"),
        "texture": ELVEN_TEX,
        # The Queen's own hair, tiara and ears, from the pack's prefab list.
        "attachments": [os.path.join(ELVEN_ATTACH, n + ".fbx") for n in ("Chr_Hair_Short_Female_01", "Chr_Attach_Tiara_04", "Chr_Attach_Elf_Ear_Female_03")],
        "pixels_per_metre": HERO_PIXELS_PER_METRE,
        # The three greens of the robe.
        "team_cells": ["5c7d6b", "4a6757", "729381"],
        "held": [{
            "file": os.path.join(ELVEN, "FBX", "Weapons", "SM_Wep_Bow_02.fbx"),
            "texture": ELVEN_TEX,
            "bone": "Prop_L",
            "scale": 1.0,
            # The Elven bows are not laid out for the prop bone the way the Bow Combat
            # pack's are: this stands the bow upright, string toward the archer, when drawn.
            "rotation": (90, 0, 0),
        }],
        "arrow": {
            "file": os.path.join(ELVEN, "FBX", "Weapons", "SM_Wep_Arrow_01.fbx"),
            "texture": ELVEN_TEX,
            "bone": "Prop_R",
            "rotation": (90, 0, 0),
            # Then in its own axes: along the draw, head past the bow, fletching at the hand.
            "local_rotation": (-90, 0, 0),
        },
        "clips": {
            "Idle": {"loop": True, "fps": 15, "chain": [(os.path.join(BOW, "Neutral", "Standing", "Idle", "A_POLY_BOW_Stand_Idle_BowDown_Neut.fbx"), None, None)]},
            "Walk": {
                "loop": True, "fps": 30,
                "chain": [(os.path.join(LOCO, "Feminine", "Locomotion", "Run", "A_Run_F_Femn.fbx"), None, None)],
                "root_motion": os.path.join(LOCO, "Feminine", "Locomotion", "Run", "A_Run_F_RootMotion_Femn.fbx"),
            },
            "Attack": {
                "loop": False, "fps": 30,
                # Raise from the bow-down idle, draw, release and lower back to it.
                "chain": [
                    (os.path.join(BOW, "Neutral", "Standing", "Idle", "A_POLY_BOW_Stand_Idle_BowDown_ToAiming_Neut.fbx"), 2, 21),
                    (os.path.join(BOW, "Neutral", "Standing", "Aim", "A_POLY_BOW_Stand_Aiming_ToDrawn_Neut.fbx"), 2, 21),
                    (os.path.join(BOW, "Neutral", "Standing", "Shoot", "A_POLY_BOW_Stand_Shoot_ToBowDown_Neut.fbx"), 2, 33),
                ],
                # The drawing hand leaves the string on the Shoot clip's third frame.
                "hit": (2, 3),
                "swing": FROST_ARCHER_SWING,
                # The arrow is nocked for the draw and gone from the release on.
                "arrow": (1, 2),
            },
            "Death": {"loop": False, "fps": 15, "chain": [(os.path.join(BOW, "Feminine", "Death", "A_POLY_BOW_Death_Spine_B_Femn.fbx"), None, None)]},
        },
    },
    # Creeps: a blade and shield against a staff, so melee and ranged read apart, and
    # Kingdom's soldiers against Dark Fortress's dead, so the two sides do. The slash
    # lands with the blade level and forward (its frame 13, as the Swordmaster's); the
    # thrust points on frame 31, its tip nearly at full reach.
    "melee_creep_radiant": creep(
        os.path.join(KINGDOM_FBX, "Characters", "SK_Chr_Soldier_Male_01.fbx"), KINGDOM_TEX,
        [prop(os.path.join(KINGDOM_FBX, "SM_Wep_Sword_01.fbx"), KINGDOM_TEX, "Prop_R"),
         prop(os.path.join(KINGDOM_FBX, "SM_Wep_Shield_01.fbx"), KINGDOM_TEX, "Prop_L", SHIELD_TURN)],
        MELEE_CREEP_SWING, LIGHT_SLASH, (0, 13), "A_Death_B_01_Sword.fbx"),
    "melee_creep_dire": creep(
        os.path.join(FORTRESS_FBX, "Characters.fbx"), FORTRESS_TEX,
        [prop(os.path.join(FORTRESS_FBX, "SM_Wep_Sword_01.fbx"), FORTRESS_TEX, "Prop_R"),
         prop(os.path.join(FORTRESS_FBX, "SM_Wep_Shield_02.fbx"), FORTRESS_TEX, "Prop_L", SHIELD_TURN)],
        MELEE_CREEP_SWING, LIGHT_SLASH, (0, 13), "A_Death_L_01_Sword.fbx",
        keep="SM_Chr_Undead_01", attachments=[os.path.join(FORTRESS_FBX, "SM_Chr_Attach_Helmet_01.fbx")]),
    "ranged_creep_radiant": creep(
        os.path.join(KINGDOM_FBX, "Characters", "SK_Chr_Mage_01.fbx"), KINGDOM_TEX,
        [prop(os.path.join(KINGDOM_FBX, "SM_Wep_Staff_02.fbx"), KINGDOM_TEX, "Prop_R")],
        RANGED_CREEP_SWING, STAFF_THRUST, (0, 31), "A_Death_F_01_Sword.fbx"),
    "ranged_creep_dire": creep(
        os.path.join(FORTRESS_FBX, "Characters.fbx"), FORTRESS_TEX,
        [prop(os.path.join(FORTRESS_FBX, "SM_Wep_Staff_01.fbx"), FORTRESS_TEX, "Prop_R")],
        RANGED_CREEP_SWING, STAFF_THRUST, (0, 31), "A_Death_R_01_Sword.fbx",
        keep="SM_Chr_Wraith_01", attachments=[os.path.join(FORTRESS_FBX, "SM_Chr_Attach_Mask_03.fbx")]),
}

# Sprite scale and camera, shared by every recipe. The lane camera looks down at 57 degrees
# (scene.ts CAMERA_PITCH); its sun sits at (-700, 1500, 650) in three's axes, which from the
# camera's side (yaw -28) is 19 degrees to the left of the viewer and 57.5 degrees up.
ELEVATION = 57.0
SUN_AZIMUTH = -19.0
SUN_ELEVATION = 57.5
# Transparent pixels kept round the widest pose of a clip, so no frame touches an edge.
MARGIN = 6


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="build_characters.py")
    parser.add_argument("--only", choices=sorted(CHARACTERS))
    args = parser.parse_args(argv)
    if not os.path.isdir(SYNTY):
        fail(f"{SYNTY} is missing: unpack the Synty packs there (art_src/README.md)")
    os.makedirs(OUT, exist_ok=True)
    write_palette()
    for char_id, spec in CHARACTERS.items():
        if args.only and char_id != args.only:
            continue
        build(char_id, spec)


def build(char_id: str, spec: dict) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = SOURCE_FPS
    ref = synty.load_reference(REFERENCE)

    objs = synty.imp(spec["body"])
    char = synty.armature(objs)
    char.name = "Hero"
    # Every character file carries a stray take of its own.
    char.animation_data_clear()
    body = [o for o in objs if o.type == "MESH"]
    if spec.get("keep"):
        # Dark Fortress ships every character as one file on one skeleton.
        others = [o for o in body if o.name.split(".")[0] != spec["keep"]]
        body = [o for o in body if o not in others]
        for o in others:
            bpy.data.objects.remove(o)
        if not body:
            fail(f"{char_id}: no mesh {spec['keep']} in {spec['body']}")
    skin = texture_material("Skin", spec["texture"])
    for o in body:
        retexture(o, skin)
        team_faces(o, spec["texture"], spec["team_cells"])
    synty.add_props(char, ref)
    rt = synty.Retarget(ref, char)

    head_bone = rt.bone("Head")
    head = char.matrix_world @ char.data.bones[head_bone].matrix_local
    for path in spec["attachments"]:
        parts = synty.imp(path)
        for o in parts:
            retexture(o, skin)
        # The packs model attachments round the head joint.
        synty.attach(parts, char, head_bone, lambda o: Matrix.Translation(head.translation) @ o.matrix_world)

    arrow = []
    for i, item in enumerate(spec["held"] + ([spec["arrow"]] if spec.get("arrow") else [])):
        is_arrow = item is spec.get("arrow")
        parts = synty.imp(item["file"])
        material = texture_material("Arrow" if is_arrow else f"Held{i}", item["texture"])
        for o in parts:
            retexture(o, material)
        at = char.matrix_world @ char.data.bones[item["bone"]].matrix_local
        turn = Euler([math.radians(v) for v in item["rotation"]]).to_matrix().to_4x4()
        local = Euler([math.radians(v) for v in item.get("local_rotation", (0, 0, 0))]).to_matrix().to_4x4()
        scale = Matrix.Scale(item.get("scale", 1.0), 4)
        synty.attach(parts, char, item["bone"], lambda o: Matrix.Translation(at.translation) @ turn @ o.matrix_world @ local @ scale)
        if is_arrow:
            arrow = [o for o in parts if o.type == "MESH"]

    meta = {"id": char_id, "pixelsPerMetre": spec["pixels_per_metre"], "clips": {}}
    for clip_name, clip in spec["clips"].items():
        meta["clips"][clip_name] = bake(scene, char, rt, arrow, clip_name, clip)
    for o in list(scene.objects):
        if o.type == "ARMATURE" and o is not char:
            bpy.data.objects.remove(o)

    extents = {name: measure(scene, char, name, info["frames"]) for name, info in meta["clips"].items()}
    # What make_sprite.py appends: this armature, its meshes and the held props. The
    # arrow is shown at save time, since hidden objects are not appended.
    for o in arrow:
        o.hide_render = False
    play(scene, "Idle")
    # The imports' own materials point at the artists' folders; nothing uses them now.
    bpy.data.orphans_purge(do_recursive=True)
    bpy.ops.file.pack_all()
    blend = os.path.join(OUT, f"{char_id}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True, copy=True)
    for name, info in meta["clips"].items():
        info["sprite"] = write_recipe(char_id, name, info, extents[name], spec["pixels_per_metre"])
    with open(os.path.join(OUT, f"{char_id}.json"), "w", newline="\n") as f:
        json.dump(meta, f, indent=1)
    log(f"{char_id}: {blend}")


# --- Palette ------------------------------------------------------------------------------------

# supplyline's copy of DawnBringer's Aurora, the palette every sprite there snaps to.
AURORA = os.path.join(os.environ.get("SUPPLYLINE", os.path.expanduser("~/supplyline")), "tools", "sprites", "palettes", "aurora.hex")
# Shades of the key colour the team colour is swapped into, darkest first (sRGB).
KEY_RAMP = 12
# Aurora's colours nearest the ramp make room for it. One more than the ramp, so the
# palette is 255 colours and a sprite pixel's index fits a byte with 0 left for "empty".
DROPPED = KEY_RAMP + 1


def write_palette() -> None:
    """palette.hex: Aurora without the colours nearest the key, then the key ramp."""
    with open(AURORA) as f:
        aurora = [line.strip().lstrip("#") for line in f if line.strip()]
    rgb = np.array([[int(h[i : i + 2], 16) for i in (0, 2, 4)] for h in aurora]) / 255.0
    ramp = np.array([[v * KEY[0], v * KEY[1], v * KEY[2]] for v in np.linspace(0.14, 1.0, KEY_RAMP)])
    distance = ((oklab(rgb)[:, None, :] - oklab(ramp)[None, :, :]) ** 2).sum(axis=2).min(axis=1)
    dropped = set(np.argsort(distance, kind="stable")[:DROPPED].tolist())
    keep = [h for i, h in enumerate(aurora) if i not in dropped]
    keys = ["%02x%02x%02x" % tuple(int(round(c * 255)) for c in shade) for shade in ramp]
    os.makedirs(os.path.dirname(PALETTE), exist_ok=True)
    with open(PALETTE, "w", newline="\n") as f:
        f.write("\n".join(keep + keys) + "\n")


def oklab(srgb_rgb: np.ndarray) -> np.ndarray:
    # Björn Ottosson's OKLab, as make_sprite.py matches colours in it.
    c = np.where(srgb_rgb <= 0.04045, srgb_rgb / 12.92, ((srgb_rgb + 0.055) / 1.055) ** 2.4)
    lms = c @ np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]]).T
    return np.cbrt(lms) @ np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]]).T


# --- Materials ----------------------------------------------------------------------------------


def texture_material(name: str, path: str):
    """The atlas, sampled without filtering: Synty atlases are grids of flat swatches,
    and a filtered lookup bleeds the neighbouring swatch in at the edges."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.8
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(path, check_existing=True)
    tex.interpolation = "Closest"
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return m


def retexture(obj, material) -> None:
    if obj.type == "MESH":
        obj.data.materials.clear()
        obj.data.materials.append(material)


def team_faces(obj, texture: str, cells: list) -> None:
    """Moves the faces that sample one of `cells` (atlas swatch colours) to a Team material,
    which renders the swatch's brightness in the key colour."""
    image = bpy.data.images.load(texture, check_existing=True)
    w, h = image.size
    pixels = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(h, w, 4)
    wanted = {tuple(int(c[i : i + 2], 16) for i in (0, 2, 4)) for c in cells}
    mesh = obj.data
    uv = mesh.uv_layers.active.data
    team = []
    for poly in mesh.polygons:
        u = sum(uv[i].uv[0] for i in poly.loop_indices) / poly.loop_total
        v = sum(uv[i].uv[1] for i in poly.loop_indices) / poly.loop_total
        x, y = min(w - 1, int(u % 1.0 * w)), min(h - 1, int(v % 1.0 * h))
        if tuple(int(round(c * 255)) for c in pixels[y, x, :3]) in wanted:
            team.append(poly.index)
    if not team:
        return
    material = bpy.data.materials.get("Team") or key_material(texture, wanted)
    mesh.materials.append(material)
    index = len(mesh.materials) - 1
    for i in team:
        mesh.polygons[i].material_index = index
    log(f"{obj.name}: {len(team)} faces take the team colour")


def key_material(texture: str, cells: set):
    """The swatch's brightness, scaled so the brightest team swatch is full key colour."""
    m = texture_material("Team", texture)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    tex = next(n for n in nodes if n.type == "TEX_IMAGE")
    bright = max(0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b) for r, g, b in cells)
    grey = nodes.new("ShaderNodeRGBToBW")
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    scale.inputs[0].default_value = tuple(c / bright for c in KEY)
    links.new(tex.outputs["Color"], grey.inputs["Color"])
    links.new(grey.outputs["Val"], scale.inputs["Scale"])
    links.new(scale.outputs["Vector"], nodes["Principled BSDF"].inputs["Base Color"])
    return m


def srgb(c: int) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# --- Clips --------------------------------------------------------------------------------------


def bake(scene, char, rt, arrow: list, name: str, clip: dict) -> dict:
    """Keys `name` on the character at every sampled frame, from frame 0."""
    segments = []
    for path, start, end in clip["chain"]:
        src = synty.load_clip(path)
        f0, f1 = src.animation_data.action.frame_range
        segments.append((src, start if start is not None else f0, end if end is not None else f1))
    lengths = [(e - s) / SOURCE_FPS for _, s, e in segments]
    total = sum(lengths)
    fps = clip["fps"]

    # Knots from output time to chain time: straight through, or for an attack, the
    # windup squeezed onto the attack point and the rest onto the backswing.
    if "hit" in clip:
        seg, frame = clip["hit"]
        hit = sum(lengths[:seg]) + (frame - segments[seg][1]) / SOURCE_FPS
        point, backswing = clip["swing"]
        hit_out = round(point * fps) / fps
        end_out = round((point + backswing) * fps) / fps
        knots = [(0.0, 0.0), (hit_out, hit), (end_out, total)]
    else:
        end_out = total
        knots = [(0.0, 0.0), (total, total)]
    count = round(end_out * fps) + (0 if clip["loop"] else 1)

    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    char.animation_data_create()
    char.animation_data.action = action
    for o in arrow:
        o.animation_data_create()
        o.animation_data.action = action
    shown = None
    if "arrow" in clip:
        a, b = clip["arrow"]
        shown = (sum(lengths[:a]) + 0.0, sum(lengths[:b]) + (clip["hit"][1] - segments[b][1]) / SOURCE_FPS)

    for k in range(count):
        t = np.interp(k / fps, [p for p, _ in knots], [c for _, c in knots])
        seg = next((i for i in range(len(segments)) if t < sum(lengths[: i + 1]) - 1e-9), len(segments) - 1)
        src, start, _ = segments[seg]
        f = start + (t - sum(lengths[:seg])) * SOURCE_FPS
        scene.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
        rt.pose(char, src)
        for pb in char.pose.bones:
            for path in ("location", "rotation_quaternion", "scale"):
                pb.keyframe_insert(path, frame=k)
        for o in arrow:
            o.hide_render = not (shown and shown[0] - 1e-9 <= t < shown[1] - 1e-9)
            o.hide_viewport = o.hide_render
            o.keyframe_insert("hide_render", frame=k)
            o.keyframe_insert("hide_viewport", frame=k)
    for fcurve in all_fcurves(action):
        for point in fcurve.keyframe_points:
            point.interpolation = "CONSTANT"
    action.use_frame_range = True
    action.frame_start, action.frame_end = 0, count - 1

    info = {"frames": count, "fps": fps, "loop": clip["loop"]}
    if "hit" in clip:
        info["hitFrame"] = round(knots[1][0] * fps)
        info["hitTime"] = info["hitFrame"] / fps
    if "root_motion" in clip:
        info["groundSpeed"] = ground_speed(clip["root_motion"])
    log(f"{name}: {count} frames at {fps} fps" + (f", hit on {info['hitFrame']}" if "hitFrame" in info else ""))
    return info


def all_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves


def ground_speed(path: str) -> float:
    """Metres per second the root-motion copy of a clip travels at its authored rate."""
    src = synty.load_clip(path)
    f0, f1 = src.animation_data.action.frame_range
    scene = bpy.context.scene
    at = []
    for f in (f0, f1):
        scene.frame_set(int(f))
        at.append((src.matrix_world @ src.pose.bones["Root"].matrix).translation.copy())
    bpy.data.objects.remove(src)
    return round((at[1] - at[0]).length / ((f1 - f0) / SOURCE_FPS), 4)


# --- Sprite recipes -----------------------------------------------------------------------------


def measure(scene, char, name, frames: int) -> tuple:
    """The furthest any rendered vertex gets over a clip, for every facing: its distance
    from the vertical through the feet, and how far above and below the feet it can land
    on screen at the lane camera's elevation (metres). `name` None measures the scene as
    it stands."""
    if name is not None:
        play(scene, name)
    el = math.radians(ELEVATION)
    reach = up = down = 0.0
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for k in range(frames):
        scene.frame_set(k)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in scene.objects:
            if obj.type != "MESH" or obj.hide_render:
                continue
            ev = obj.evaluated_get(depsgraph)
            mesh = ev.to_mesh()
            co = np.empty(len(mesh.vertices) * 3)
            mesh.vertices.foreach_get("co", co)
            ev.to_mesh_clear()
            m = np.array(ev.matrix_world)
            p = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
            r = np.hypot(p[:, 0], p[:, 1])
            reach = max(reach, r.max())
            up = max(up, (p[:, 2] * math.cos(el) + r * math.sin(el)).max())
            down = max(down, (r * math.sin(el) - p[:, 2] * math.cos(el)).max())
    return reach, up, down


def play(scene, name: str) -> None:
    """Every object the action animates plays it (the hero and the arrow it holds), as
    make_sprite.py will play it."""
    action = bpy.data.actions[name]
    for obj in scene.objects:
        slot = next((s for s in action.slots if s.target_id_type == "OBJECT" and s.name_display == obj.name), None)
        if slot is not None:
            obj.animation_data.action = action
            obj.animation_data.action_slot = slot


def write_recipe(char_id: str, name: str, info: dict, extent: tuple, ppm: float) -> dict:
    return recipe(char_id, name.lower(), name, info["frames"], extent, ppm, 16)


def recipe(folder_id: str, clip: str, action, frames: int, extent: tuple, ppm: float, directions: int) -> dict:
    """Writes <folder_id>/<clip>.toml: the lane camera and sun, a frame just big enough
    for the widest pose in any facing, and every frame of `action` (none: a still)."""
    reach, up, down = extent
    width = 2 * math.ceil(reach * ppm + MARGIN)
    ground = math.ceil(down * ppm + MARGIN)
    height = ground + math.ceil(up * ppm + MARGIN)
    folder = os.path.join(OUT, folder_id)
    os.makedirs(folder, exist_ok=True)
    animation = f"""
[animation]
action = "{action}"
start = 0
end = {frames - 1}
""" if action else ""
    text = f"""# Written by tools/blender/build_characters.py or build_props.py; rebuild instead of editing.
name = "{folder_id}_{clip}"

[source]
file = "../{folder_id}.blend"
scale = 1.0
front = "-y"
{animation}
[camera]
elevation = {ELEVATION}

[light]
azimuth = {SUN_AZIMUTH}
elevation = {SUN_ELEVATION}

[render]
size = {2 * width}
directions = {directions}

[sprite]
size = {width}
height = {height}
ground = {ground}
pixels_per_metre = {ppm}
palette = "../../palette.hex"

[output]
pxo = "{clip}.pxo"
sheet = "{clip}.png"
"""
    with open(os.path.join(folder, f"{clip}.toml"), "w", newline="\n") as f:
        f.write(text)
    return {"width": width, "height": height, "ground": ground}


def log(message: str) -> None:
    print(f"[build_characters] {message}", flush=True)


def fail(message: str) -> None:
    raise SystemExit(f"[build_characters] error: {message}")


if __name__ == "__main__":
    main()
