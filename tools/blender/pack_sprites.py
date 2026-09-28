"""
Pack the sprite sheets into the atlases the game loads: heroes, creeps, catapults,
towers and scenery alike.

Run after build_characters.py, build_props.py and supplyline's render (see
build_characters.py):
    blender --background --factory-startup --python tools/blender/pack_sprites.py

The sheets supplyline exports are RGBA, a column per direction and a row per frame,
every opaque pixel already one of palette.hex's colours. Most of each frame is empty,
so every frame is cropped to its pixels and the crops are shelf-packed into pages. A
page stores palette indices, not colours: one byte per pixel, 0 for empty and i for
palette.hex's line i. That is a quarter of the memory of RGBA, and it is what makes
the team colour a palette swap: the last KEY_RAMP colours are shades of the key
colour build_characters.py renders the team's cloth in, and the game draws those indices
in the team's colour instead (spriteView.ts).

It writes, into public/sprites/:
    palette.json          the colours by index, and where the key ramp sits
    <id>_<n>.png          the pages, 8-bit greyscale PNGs of indices
    <id>.json             per clip: timing, and per direction and frame the page,
                          rectangle and foot point of its crop. A scenery sheet's
                          clips are its models, one frame each.
Two runs on the same sheets give the same bytes.
"""

import json
import os
import struct
import sys
import zlib

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_characters as build  # noqa: E402

REPO = build.REPO
BUILD = build.OUT
OUT = os.path.join(REPO, "public", "sprites")
# Every sheet build_characters.py and build_props.py write, in the order the game lists them.
SHEETS = [*build.CHARACTERS, "siege_creep_radiant", "siege_creep_dire", "tower_radiant", "tower_dire", "scenery"]
# Pages stay inside what every WebGL2 implementation must support (MAX_TEXTURE_SIZE 2048
# is the floor; 4096 is universal on desktop and SwiftShader, which the harness uses).
PAGE = 4096
# Empty pixels between crops. Sampling is nearest-texel, so one is plenty.
GAP = 1


def main() -> None:
    palette = load_palette(build.PALETTE)
    os.makedirs(OUT, exist_ok=True)
    ramp_first = len(palette) - build.KEY_RAMP + 1
    write_json(
        os.path.join(OUT, "palette.json"),
        {
            "colors": ["%02x%02x%02x" % tuple(c) for c in palette.tolist()],
            # 1-based, as the pages store them: index i is colors[i - 1].
            "teamRamp": {"first": ramp_first, "count": build.KEY_RAMP},
        },
    )
    lookup = {int(r) << 16 | int(g) << 8 | int(b): i + 1 for i, (r, g, b) in enumerate(palette.tolist())}
    for sheet_id in SHEETS:
        meta_path = os.path.join(BUILD, f"{sheet_id}.json")
        if not os.path.isfile(meta_path):
            fail(f"missing {meta_path}: run build_characters.py and build_props.py")
        with open(meta_path) as f:
            meta = json.load(f)
        pack(sheet_id, meta, lookup, ramp_first)


def pack(sheet_id: str, meta: dict, lookup: dict, ramp_first: int) -> None:
    directions = meta.get("directions", 16)
    crops = []  # (clip, direction, frame, indices, ox, oy)
    team = total = 0
    for clip, info in meta["clips"].items():
        sheet_path = os.path.join(BUILD, sheet_id, f"{clip.lower()}.png")
        if not os.path.isfile(sheet_path):
            fail(f"missing {sheet_path}: render {sheet_id}'s recipes first")
        sheet = read_png(sheet_path)
        w, h = info["sprite"]["width"], info["sprite"]["height"]
        if sheet.shape[:2] != (h * info["frames"], w * directions):
            fail(f"{sheet_path} is {sheet.shape[1]}x{sheet.shape[0]}, expected {w * directions}x{h * info['frames']}")
        indices = to_indices(sheet, lookup, sheet_path)
        for frame in range(info["frames"]):
            for d in range(directions):
                cell = indices[frame * h : (frame + 1) * h, d * w : (d + 1) * w]
                ys, xs = np.nonzero(cell)
                if len(xs) == 0:
                    crops.append((clip, d, frame, np.zeros((0, 0), np.uint8), 0, 0))
                    continue
                x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
                crop = cell[y0:y1, x0:x1]
                team += int((crop >= ramp_first).sum())
                total += int((crop > 0).sum())
                # The feet: the middle of the frame, `ground` pixels above its bottom edge.
                crops.append((clip, d, frame, crop, w // 2 - int(x0), h - info["sprite"]["ground"] - int(y0)))

    pages, places = shelf_pack([c[3].shape for c in crops])
    images = [np.zeros((ph, pw), np.uint8) for pw, ph in pages]
    clips = {}
    for (clip, d, frame, crop, ox, oy), (page, x, y) in zip(crops, places):
        ch, cw = crop.shape
        if cw:
            images[page][y : y + ch, x : x + cw] = crop
        info = meta["clips"][clip]
        entry = clips.setdefault(clip, {k: info[k] for k in ("fps", "loop", "frames", "hitTime", "groundSpeed", "side", "kind") if k in info})
        entry.setdefault("cells", [[None] * info["frames"] for _ in range(directions)])
        entry["cells"][d][frame] = [page, x, y, cw, ch, ox, oy]

    names = []
    for i, image in enumerate(images):
        name = f"{sheet_id}_{i}.png"
        write_bytes(os.path.join(OUT, name), png_grey(image))
        names.append(name)
    write_json(
        os.path.join(OUT, f"{sheet_id}.json"),
        {"pixelsPerMetre": meta["pixelsPerMetre"], "directions": directions, "pages": names, "clips": clips},
    )
    area = sum(p[0] * p[1] for p in pages)
    log(f"{sheet_id}: {len(crops)} frames on {len(pages)} pages, {area / 1e6:.1f} Mpx; team colour on {team / max(total, 1):.1%} of the pixels")


def to_indices(sheet: np.ndarray, lookup: dict, path: str) -> np.ndarray:
    opaque = sheet[..., 3] > 0
    if np.any((sheet[..., 3] != 0) & (sheet[..., 3] != 255)):
        fail(f"{path} has partly transparent pixels")
    key = sheet[..., 0].astype(np.int64) << 16 | sheet[..., 1].astype(np.int64) << 8 | sheet[..., 2]
    out = np.zeros(sheet.shape[:2], np.uint8)
    colours = np.unique(key[opaque])
    for c in colours.tolist():
        if c not in lookup:
            fail(f"{path} uses #{c:06x}, which is not in palette.hex")
    table = np.array(sorted(lookup)), np.array([lookup[c] for c in sorted(lookup)], np.uint8)
    out[opaque] = table[1][np.searchsorted(table[0], key[opaque])]
    return out


def shelf_pack(sizes: list) -> tuple:
    """Places (h, w) rectangles, tallest first, in rows across PAGE-wide pages. Returns the
    pages' (width, height) and each rectangle's (page, x, y), in the order given."""
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][0], -sizes[i][1], i))
    places = [None] * len(sizes)
    pages = []  # [width used, height used]
    page = x = y = shelf = 0
    pages.append([0, 0])
    for i in order:
        h, w = sizes[i]
        if w == 0:
            places[i] = (0, 0, 0)
            continue
        if w > PAGE or h > PAGE:
            fail(f"a {w}x{h} frame does not fit a {PAGE} page")
        if x + w > PAGE:
            x, y, shelf = 0, y + shelf + GAP, 0
        if y + h > PAGE:
            pages.append([0, 0])
            page, x, y, shelf = page + 1, 0, 0, 0
        places[i] = (page, x, y)
        pages[page][0] = max(pages[page][0], x + w)
        pages[page][1] = max(pages[page][1], y + h)
        x += w + GAP
        shelf = max(shelf, h)
    # Whole multiples of 4 keep every row of a one-byte texture aligned for upload.
    return [(-(-w // 4) * 4, -(-h // 4) * 4) for w, h in pages], places


def load_palette(path: str) -> np.ndarray:
    with open(path) as f:
        lines = [line.strip().lstrip("#") for line in f if line.strip()]
    if len(lines) != 255:
        fail(f"{path} has {len(lines)} colours; a page byte holds 255 and empty")
    return np.array([[int(h[i : i + 2], 16) for i in (0, 2, 4)] for h in lines], dtype=np.uint8)


def read_png(path: str) -> np.ndarray:
    """8-bit RGBA, top row first, as make_sprite.py reads it."""
    image = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = image.size
        pixels = np.empty(w * h * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
    finally:
        bpy.data.images.remove(image)
    return np.rint(pixels.reshape(h, w, 4)[::-1] * 255.0).astype(np.uint8)


def png_grey(image: np.ndarray) -> bytes:
    h, w = image.shape
    raw = b"".join(b"\x00" + image[y].tobytes() for y in range(h))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    header = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def write_bytes(path: str, data: bytes) -> None:
    with open(path, "wb") as f:
        f.write(data)


def write_json(path: str, data: dict) -> None:
    with open(path, "w", newline="\n") as f:
        json.dump(data, f, separators=(",", ":"))
        f.write("\n")


def log(message: str) -> None:
    print(f"[pack_sprites] {message}", flush=True)


def fail(message: str) -> None:
    raise SystemExit(f"[pack_sprites] error: {message}")


if __name__ == "__main__":
    main()
