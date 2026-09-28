# Art sources

Everything drawn in the lane — heroes, creeps, catapults, towers, trees, rocks
and the ground — is rendered from Synty's POLYGON packs. Synty's licence lets a
game ship renders of its models but not the packs themselves, so the packs are
not in this repo: `art_src/synty/` and `art_src/sprites/build/` are
git-ignored, and only what the game loads, in `public/sprites/`, is committed.

## The packs

Unpack these from Synty's "Source Files" downloads into `art_src/synty/`,
keeping each zip's own folders:

| Folder | Zip | What comes from it |
|---|---|---|
| `samurai/` | `POLYGON_Samurai_SourceFiles_v2.zip` (`SourceFiles/Characters`, `FBX`, `Textures`) | Swordmaster: `VillageMale_02`, the Odachi; ridge rocks |
| `elven/` | `POLYGON_ElvenRealm_SourceFiles_v5.zip` (`FBX`, `Textures`) | Frost Archer: the Queen with her hair, tiara and ears, Bow 2, Arrow 1 |
| `kingdom/` | `POLYGON_Fantasy_Kingdom_SourceFiles_v6.zip` (`FBX`, `Textures`) | Radiant's creeps (Soldier, Mage), catapult and tower; living trees, bushes, rocks; grass, flower, sand and mud ground |
| `fortress/` | `POLYGON_Dark_Fortress_SourceFiles_v4.zip` (`FBX`, `Texture`) | Dire's creeps (Undead, Wraith), catapult and tower; dead trees and bushes |
| `nature/` | `POLYGON_Nature_Source_Files_v2.zip` (`Source Files/FBX`, `Source Files/Textures`) | Trees, dead trees, bushes and rocks; mud and moss ground |
| `starter/` | `POLYGON_Starter_SourceFiles_v2.zip` | Nothing yet |
| `anim_sword/` | `ANIMATION_Sword_Combat_SourceFiles_v5.zip` (`SourceFiles/Animations/Polygon`, `SourceFiles/Models`) | Swordmaster's and every creep's Idle, Attack and Death; the reference character every clip is retargeted through |
| `anim_bow/` | `ANIMATION_Bow_Combat_SourceFiles_v1.zip` (`SourceFiles/Animations/Polygon`, `SourceFiles/Models`) | Frost Archer's Idle, Attack and Death |
| `anim_loco/` | `ANIMATION_Base_Locomotion_SourceFiles_v3.zip` (`SourceFiles/Animations/Polygon`) | Every character's Walk (the forward run) and its ground speed |

## Rebuilding the sprites

Four steps, each checked by the next:

```
blender --background --factory-startup --python tools/blender/build_characters.py
blender --background --factory-startup --python tools/blender/build_props.py
~/supplyline/tools/sprites/remote_render.cmd art_src/sprites/build/*/*.toml
blender --background --factory-startup --python tools/blender/pack_sprites.py
```

1. `build_characters.py` dresses each hero and creep, retargets the clips onto
   it, bakes Idle, Walk, Attack and Death into `art_src/sprites/build/<id>.blend`,
   and writes one sprite recipe per clip beside it. It also writes
   `art_src/sprites/palette.hex`: Aurora with a ramp of the key colour a hero's
   cloth renders in. `--only <id>` rebuilds one.
2. `build_props.py` does the same for the catapults (arm, crank and wheels keyed
   about their pivots), the two towers and the scenery (a still per model, in
   eight facings), and writes the ground's tiles straight into
   `public/sprites/ground/`. `--only siege_creep_radiant`, `tower_dire`,
   `scenery` or `ground` rebuilds one.
3. supplyline's sprite pipeline (`~/supplyline/tools/sprites`, see its README)
   renders every recipe on the GPU server, snaps the pixels to the palette and
   exports a sheet per clip. `make_sprite.cmd` on a recipe does the same on this
   PC, much more slowly.
4. `pack_sprites.py` crops the frames, packs them into palette-index pages and
   writes the manifests the game loads (`src/render3d/spriteView.ts`,
   `assets.ts`).
