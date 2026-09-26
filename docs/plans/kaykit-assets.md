# Plan: KayKit characters in place of the box placeholders

Working plan for an unattended run on `claude/gracious-archimedes-ljj627`. One
commit per phase, pushed as it lands, one PR at the end. Remove this file in
phase 6 once the CLAUDE.md sections cover it.

## Decisions (made by the user)

- **Creeps:** KayKit Skeletons for both teams. Team identity comes from two
  build-time recolours of the atlas (Radiant green, Dire red) plus the eye
  `Glow` material, not from `material.color` multiplies.
- **Heroes:**

  | Hero           | Character                 | Attack clip                    |
  |----------------|---------------------------|--------------------------------|
  | Sniper         | Rogue + 2H crossbow       | `2H_Ranged_Shoot`              |
  | Juggernaut     | Knight + 2H sword         | `2H_Melee_Attack_Slice`        |
  | Anti-Mage      | Barbarian, dual axes      | `Dualwield_Melee_Attack_Slice` |
  | Crystal Maiden | Mage + staff              | `Spellcast_Shoot`              |
  | Shadow Fiend   | Skeleton_Mage (dark tint) | `Spellcast_Shoot`              |
  | Drow Ranger    | Rogue_Hooded + 1H crossbow| `1H_Ranged_Shoot`              |

  The free packs have no bow, so Drow gets a crossbow.
- **Scope:** phases 0-5 below, plus the phase 6 cleanup.
- **Free tiers only.** Nothing from the paid Extra/Source tiers.

## Source assets (verified 2026-09-26)

- `github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0` and
  `-Adventures-1.0`. Both are CC0 (their LICENSE files) and clone through
  the session proxy. The GitHub web and API return 403, but git works.
- All 9 characters share one 41-joint rig: `root, hips, spine, chest,
  upperarm/lowerarm/wrist/hand/handslot.{l,r}, head, upperleg/lowerleg/foot/toes.{l,r}`
  plus IK/control bones. Three.js sanitises the dots away (`handslot.r` becomes `handslotr`).
- Each character GLB embeds all of its clips: 95 for Skeletons, 76 for
  Adventurers, 3.6-4.8 MB per file. Weapons are separate meshes inside each
  character file (e.g. Knight: `1H_Sword`, `2H_Sword`, 4 shields), and
  Skeletons also ship `Assets/gltf/Skeleton_{Blade,Axe,Staff,Crossbow,Shield_*}.gltf`.
- Clips used: `Idle`, `Walking_A` (or `Walking_D_Skeletons`), `Death_A`, and
  the attack clips above; creeps use `1H_Melee_Attack_Chop` (melee),
  `Spellcast_Shoot` (ranged) and `2H_Melee_Attack_Chop` (siege).

## Scouting facts (measured in Blender 5.2.2, 2026-09-26)

- `tools/fetch_assets.sh` puts Blender at
  `tools/.cache/blender-5.2.2-linux-x64/blender` and the packs at
  `tools/.cache/kaykit-{Skeletons,Adventures}/addons/kaykit_character_pack_*/`.
- **Facing:** KayKit toes point Blender -Y, the same as the box creep, so
  `rotation.y = PI/2 - facing` in `UnitView.sync` still holds.
- **Import quirk:** Blender's glTF importer adds a stray `Icosphere` object on
  every import. Ignore it for bounds and never export it.
- **fps:** the import runs at 24 fps. Clip times below are in seconds
  (frame / 24), sampled every 0.25 frame.
- **Weapons:** Adventurers character GLBs contain every weapon as a mesh
  parented (object `parent_bone`) to `handslot.r` or `handslot.l`, and the
  build keeps only the ones listed. Skeletons character GLBs contain no
  weapons; attach `Assets/gltf/Skeleton_{Blade,Staff,Axe,Shield_Large_A}.gltf`
  to `handslot.r` or `handslot.l` in the build.
  - Knight: 1H_Sword, 1H_Sword_Offhand, 2H_Sword, and 4 shields on `.l`
  - Rogue and Rogue_Hooded: 1H_Crossbow, 2H_Crossbow, Knife, Knife_Offhand, Throwable
  - Barbarian: 1H_Axe, 1H_Axe_Offhand, 2H_Axe, Barbarian_Round_Shield, Mug
  - Mage: 1H_Wand, 2H_Staff, Spellbook, Spellbook_open
  - Hats, capes and helmets are parented to `head` or `chest`. Keep them.
- **Custom properties export natively:** with `export_extras=True`, Blender
  5.2's exporter writes action custom properties to glTF `animations[i].extras`,
  which GLTFLoader copies onto `AnimationClip.userData`. So
  `act["hitTime"] = t` arrives as `clip.userData.hitTime`, and no JSON
  patching is needed.
- **Contact detector** (verified against trajectory tables): take whichever
  of `handslot.r` or `handslot.l` has the higher peak speed. The contact is
  the first sample after that peak where the speed drops below 40% of the
  peak, i.e. the end of the fast stroke.

  | Clip | Length | Hand | Contact |
  |---|---|---|---|
  | 1H_Melee_Attack_Chop | 1.067 | .r | 0.615 |
  | 2H_Melee_Attack_Chop | 1.633 | .l | 0.875 |
  | 2H_Melee_Attack_Slice | 1.100 | .l | 0.438 |
  | Dualwield_Melee_Attack_Slice | 1.167 | .r | 0.646 |
  | Spellcast_Shoot | 0.933 | .r | 0.271 (thrust ends ~0.29) |
  | 2H_Ranged_Shoot | 1.067 | .l | 0.240 (recoil starts at 0.25) |
  | 1H_Ranged_Shoot | 1.067 | .r | 0.240 (recoil starts at 0.25) |

  The Skeleton rig gives identical times for the clips they share.
- Other clips: Idle 1.083 s; Walking_A 1.083 s; Walking_D_Skeletons 1.583 s
  (a shamble, with almost no arm swing); Death_A 0.792 s.
- Sizes: the Skeletons atlas is `skeleton_texture.png`, 17 KB. Each
  character's Adventurers atlas is `<name>_texture.png`. The eyes use a
  separate material named `Glow`.

## Phases

### 0. Tooling
`tools/fetch_assets.sh` downloads Blender 5.2 (download.blender.org is
reachable) and clones both packs at pinned SHAs into a git-ignored
`tools/.cache/`. Only built GLBs and textures are committed.

### 1. Runtime prep on the box creep (no visual change)
- Each attack clip's contact time comes from the file
  (`clip.userData.hitTime`, from glTF animation `extras`). The loader
  throws if it is missing. `make_creep.py` writes it so the box creep
  keeps loading until phase 3.
- The attack plays in two parts: before contact, at the speed that lands
  the hit on the sim's damage tick; after contact, at the speed that makes
  the follow-through last exactly `attackBackswing`.
- `MODEL_SCALE` and `MODEL_HEIGHT` are measured from each model's bounds,
  and picking and health bars read the per-model values.
- A table picks a model per unit kind, team and hero id. It replaces
  `loadCreep` and the `TEAM_TINT`/`KIND_SHIFT` multiply.

### 2. `tools/blender/build_units.py`
- Imports a KayKit GLB and keeps only the listed body and weapon meshes.
- Keeps the chosen clips, renames them to `Idle`/`Walk`/`Attack`/`Death`,
  and deletes the rest.
- Finds the contact frame from the weapon hand's peak speed
  (`handslot.r`, or `handslot.l` for off-hand clips), with an override table
  for clips it gets wrong. The frame is written into the animation `extras`
  (patching the GLB JSON after export if the exporter drops action custom
  properties).
- Writes the team versions of each atlas and the eye glow colour.
- Exports to `public/models/units/<id>[_<team>].glb`.
- The self-check after export (`GLB_REPORT`) must pass: 4 clips, a hit time
  on the attack, 41 joints, and a size limit per file (300 KB target).

### 3. Creeps
melee: Skeleton_Warrior + blade. ranged: Skeleton_Mage + staff. siege:
Skeleton_Warrior at 1.25x with axe and large shield. Remove `weapons.ts`
and the colour tint.

### 4. Heroes
Per the table above. The enemy bot uses the same model as its hero, in
Dire colours.

### 5. Ground and lane
Tiling CC0 grass and lane textures from ambientCG / Poly Haven, 1K, JPG,
committed. Use `RepeatWrapping`, `SRGBColorSpace` and anisotropy, with a
mask-blended lane edge. Towers stay procedural.

### 6. Cleanup and docs
Delete `make_creep.py`. Update the Architecture and Known gaps sections of
CLAUDE.md. Add an optional credit line for Kay Lousberg in the README.
Delete this file.

## Verification (every phase)
- `npm run build`.
- The `build_units.py` self-check.
- Headless Chromium screenshots of `/` and `/slice3d.html`, using the
  global Playwright install from outside the repo, since Playwright is not
  a repo dependency.
- A frame-step check that the attack contact lands on the sim damage tick.

## Known risks
- The automatic contact frame can be wrong on some clips; the override
  table covers that.
- The walk cadence divisor (`/240` in `unitView.ts`) needs re-tuning for the
  new stride length.
- The KayKit models may face a different forward axis. Check the rotation
  in `UnitView.sync`.
- The `Glow` emissive may need tuning under the current sun and hemisphere
  lights.
