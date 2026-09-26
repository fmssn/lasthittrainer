# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Last Hit Trainer** — a browser drill for practising Dota 2 last hitting and denying.
No framework, no backend: TypeScript + Vite, a deterministic simulation, and a
hand-written renderer. Run history is kept in `localStorage`.

## Commands

```bash
npm run dev      # vite dev server on :5173 (drill at /, rig debug slice at /slice3d.html)
npm run build    # tsc --noEmit && vite build
npm run preview  # serve dist/
```

```bash
npm run check    # headless assertions against the simulation (needs npm run dev)
npm run shot     # screenshot the menu, a formed lane and results (needs npm run dev)
npm run balance  # difficulty calibration for the bot (needs npm run dev)
npm run model    # regenerate public/models/melee_creep.glb (needs Blender 4.0+)
```

The three browser harnesses drive the Chromium a Claude Code container ships at
`/opt/pw-browsers`; anywhere else they fall back to playwright's own, which
`npx playwright install chromium` fetches once. `CHROMIUM` overrides both
(`tools/chromium.mjs`). Node 20+ is required — playwright will not run on 18 —
and CI uses 24.

`npm run model` (`tools/blender/run.mjs`) finds Blender through `BLENDER`, then
the pinned build `tools/fetch_assets.sh` leaves in `tools/.cache`, then PATH,
then the default install folders, newest first, and skips anything before 4.0. `npm run model -- --ui` runs the same build and leaves Blender open on the
re-imported result. Reload the page afterwards; vite serves `public/` as is.

There is no linter. `npm run build` (i.e. `tsc --noEmit`) plus `npm run check`
are the automated checks — run both after every change.

`.github/workflows/ci.yml` runs the same two on every push to main and every
PR, and deploys a green main to GitHub Pages. The deploy job is skipped while
the repository is private, since Pages is only free on public repositories.

`npm run check` (`tools/simcheck.mjs`) is not a test runner: it drives a real
Chromium against the dev server and imports the actual sim modules through
vite, then asserts numbers. That is what lets it exist without dragging a
toolchain into a project whose only dependency is three. It covers the Dota
reference values, swing timing to the frame, creep targeting and aggro, contact
behaviour, and a fixed-seed replay. It finishes with a real right-click at a
real screen position, which is the only thing covering `pickUnit` ->
`orderAttack` end to end — picking is the renderer's job, so none of the sim
checks touch it. Exits non-zero on the first failure.

`npm run shot` (`tools/shot.mjs`) captures the menu and a lane 14 seconds in at
a fixed seed, so two runs frame the same moment and a renderer change can be
looked at rather than argued about. A visual change that is not screenshotted
is not reviewed.

`npm run balance` (`tools/balance.mjs`) drives *both* heroes with the same
laning AI and holds your side at level 3, so the only thing changing down the
table is the opponent. It is a measurement, not a pass/fail, and it catches the
one class of bug nothing else here can: a side bias. A lane where Radiant
quietly farms better than Dire would flatter you for three minutes and teach
you nothing, and staring at the code does not find it. Current reading, with
the Frost Archer on both sides — level 3 against level 3 comes out 4.3 to
10.3 last hits, gap 6.0, and the ladder runs 1.7 -> 6.0 -> 10.3 -> 13.0 ->
14.0. That gap is open, not accepted: three seeds exaggerate it, but over
twelve it is still 5.3 to 7.5 (Swordmaster mirror 4.1 to 5.5) with Dire ahead
in most seeds, so the lane leans Dire. Before the roster was cut the harness
mirrored a hero no longer in it, which read 0.0 on the same seeds. Re-run it
after touching creep AI, the bot, or anything in the combat path.

To preview in-session, use `preview_start` with the launch config named
`lasthittrainer` (`.claude/launch.json`); do not start the dev server via Bash.
Where `preview_start` is unavailable, both tools above expect a dev server on
:5173 and will need one started some other way.

## Architecture

The hard rule of this codebase: **the simulation knows nothing about rendering,
input, or the DOM.** `src/sim/` imports nothing from the other folders. Everything
else reads `World` and never mutates it outside `world.step()`.

```
src/sim/          Headless game simulation
  constants.ts    Dota 7.3x reference values + formulas (armor, BAT, attack point,
                  turn rate, attribute rules, acquisition range per kind)
  config.ts       DrillConfig (what the menu can change) + enemy bot profiles 1-5
  types.ts        Unit, Vec2, Projectile, KillEvent, DamageEvent — the data model
  units.ts        Creep/tower stat templates, spawnUnit, damage rolls
  heroes.ts       Hero base stats + attributes; level-1 stats are derived, not
                  hand-copied. Two heroes, ordered by attack-timing difficulty.
  items.ts        Starting items from items.txt, 600 gold / 6 slot / stacking
                  rules
  math.ts         Vec helpers, angles, seeded RNG (makeRng)
  world.ts        World.step() — the fixed-timestep core. Spawns waves, resolves
                  windup/backswing, projectiles, damage, bounty, stats.
  ai/creepAi.ts   Creep targeting in Dota's own priority order
  ai/enemyHeroAi.ts  The bot laner, driven by an EnemyProfile

src/render3d/     The renderer: three.js stage + screen-space overlay
  scene.ts        Stage: camera, lights. Sim (x,y) -> three (x,0,y)
  terrain.ts      Ground, lane path, rock ridges, treeline
  appearance.ts   Shared render-side facts about units: tint, scale, how tall a
                  rig is, how wide it is to click. The stage and the overlay
                  both read it so they cannot disagree.
  unitView.ts     One animated rig; picks a clip from sim state
  siegeView.ts    The catapult. Its own geometry, no skeleton, arm driven by
                  the sim's attack phases.
  weapons.ts      Procedural kit bolted onto the rig: swords, bows, helms,
                  hoods, crowns, shields, capes
  effects.ts      Pooled impact sprites, driven by World.damageLog
  projectileView.ts  Oriented bolts with trails; flat travel, no arc
  renderer3d.ts   Renderer3D: scene + views + ground rings, and unit picking
  annotations.ts  Screen-space layer: health bars, windup arc, floaters
  targetAids.ts   isPlayerTarget — the rule every training aid keys off
src/ui/           menu.ts, hud.ts, results.ts — plain DOM over the canvas
  inventory.ts    The six item slots, shared by the menu, HUD and results
  itemIcons.ts    Item icons as SVG, in the style of the WC3 buttons
src/input.ts      Dota-style mouse/keyboard mapping
src/stats.ts      RunRecord persistence in localStorage (key `lht.runs.v1`)
src/main.ts       Entry point: state machine (menu/playing/paused/results) + loop
src/slice3d.ts    Debug entry point: unattended sim, clip histogram, free look
tools/blender/    Headless Blender script that generates public/models/melee_creep.glb,
                  and heroes.blend, the hand-built hero models (exported by hand)
```

### Simulation rules

- Fixed timestep of **1/120 s**, accumulator-driven, capped at 0.25 s of catch-up.
  Never step the world from a render path or with a variable `dt`.
- Deterministic: all randomness goes through `world.rng` (seeded from
  `DrillConfig.seed`). Do not call `Math.random()` inside `src/sim/`.
- `constants.ts` is a **reference sheet of real Dota values**, not a tuning file.
  Training knobs belong in `config.ts`. If a value is a deliberate simplification,
  say so in a comment next to it — the existing comments follow that convention.
- Unit, hero and item numbers come from Valve's own `npc_units.txt`,
  `scripts/npc/heroes/*.txt` and `items.txt`. **Do not adjust them by feel.** If one looks wrong,
  check it against the scripts and change it with the source named in the
  comment. `npm run check` asserts the whole table, so a drive-by tweak fails.
- Hero level-1 stats are *derived* from base stats plus attributes (22 HP and
  0.1 regen per strength, 0.167 armor and 1 attack speed per agility, +1 damage
  per point of primary). Add a hero by writing its `HeroSource`, not by
  computing a stat block by hand. Copy `BaseAttackSpeed` too when the hero file
  overrides the base 100 — the Swordmaster's 110 went missing once and made
  its swing 0.018s slow.
- Starting items feed `derive()` as attributes, so they get the same rules.
  Quell is the one item effect outside that: `Unit.creepDamageBonus`, added in
  `World.applyModifiers` before armor, enemy creeps only. Only the player gets
  items; the bot starts empty-handed.
- Tango and Magic Stick carry no stats and cannot be used: they are there so a
  real opening buy fits the 600 gold. Tango stacks (`ItemStackable 1`), so a
  loadout is a list of *purchases* and `inventorySlots` folds it into slots.
  Count slots through that, never `items.length`.
- Attack speed divides the wind-up and the backswing as well as the interval.
  Anything that quotes a hero's timing to the player must quote the effective
  number, not the one authored in the hero file.
- Attack timing is the whole point of the app: `attackPoint` (windup) and
  `attackBackswing` are authored in seconds and scale with attack speed, melee is
  instant on windup completion, ranged spawns a projectile. Treat this path as
  load-bearing.
- A swing starts and is ticked in the **same** fixed step, and phase timers
  compare against `TIMER_EPSILON` rather than zero. Both matter: without them a
  0.25s attack point lands in 0.267s, because the countdown started a frame late
  and thirty subtractions of 1/120 finish just above zero. There is a check
  asserting the landing to within 2ms.
- Creeps are **sticky**. One that is standing and swinging does not re-check
  which enemy is nearest; it holds its target until that dies or leaves attack
  range, then prefers whatever is already in range over chasing. A swing already
  under way is never re-aimed, because the release reads `attackTargetId` at
  release time and would otherwise hand the damage to the new target.

### Performance

Measured over 45 seconds of a level-5 lane: peak 210 draw calls, 16k triangles,
10 rigs. That was before the hero models. A Swordmaster is about 14.8k triangles
in 29 primitives and a Frost Archer 9.8k in 40, and the shadow pass draws each
again, so a Swordmaster mirror comes to about 270 calls and 74k triangles. That is nothing for a real GPU, but
it is where the budget now goes. Rocks and trees are one instanced mesh each. The 220 impact sprites are
individual draw calls, which is the one thing here that could scale badly, but
it never gets near saturation in practice — so it stays simple.

Frame times from this project's own harness mean nothing: it renders through
SwiftShader. Draw-call and triangle counts are the only numbers worth trusting
from `__lht.renderStats()`; real performance needs a real GPU.

### Rendering

`Renderer3D` (`src/render3d/renderer3d.ts`) is the only renderer. There was a 2D
canvas painter and a `GameRenderer` interface to switch between the two; both
are gone, along with the menu's renderer picker. Reach for git history rather
than reintroducing the abstraction for a second implementation that does not
exist.

The drawing splits in two: ground-plane art (range rings, tower zones, the
killable pulse) is real geometry, while anything that must stay screen-sized and
legible mid-swing (health bars, the deny line, the damage preview, the windup
arc, floaters) is drawn by `annotations.ts` on a 2D canvas over the stage.
Sim→three mapping is fixed in `scene.ts`: sim `(x, y)` → three `(x, 0, y)`, +Y up.

`#game` is the pointer surface: it stays transparent and the stage canvases are
inserted underneath it, so `input.ts` owns every listener and never changes hands.

Picking is the renderer's job, not the sim's (`Renderer3D.pickUnit`). A rig
stands ~100 sim units tall, so the ground point under the cursor is not what the
cursor looks like it is over — aiming at a creep's chest resolves to a lane point
tens of units behind its feet. The cursor ray is tested against an upright
cylinder per unit instead, so the whole visible body is clickable.

`melee_creep.glb` is a hard startup dependency: `main.ts` loads it before
building the renderer and shows a fatal message if it fails, since there is no
longer a 2D path to fall back to. Hero models (`public/models/<heroId>.glb`,
listed in `HERO_MODEL_URLS` and in `tools/pack-artifact.mjs`) are just as fatal,
because falling back to the creep rig would show the wrong swing timing.

A hero model is *bespoke*: its armature carries `hitTime` (seconds into the
unscaled Attack clip where the blow lands) as a custom property, exported as
glTF extras. `loadRig` reads it, and the view rescales the swing so that instant
lands on the sim's damage tick, the same way the creep's constant does. A bespoke
model wears its own gear, so no kit goes on, and only its `Team` material takes
the team tint. The renderer finds a hero's model by matching `Unit.name` against
`HEROES`, since the sim carries no render-only hero id. Both heroes have one, so
the hero entries in `weapons.ts`'s kit are only a fallback now. A hero's arrow
leaves from `HERO_LAUNCH` in `projectileView.ts`, the height of the Frost
Archer's bow at full draw, not from a creep's shoulder.

Every other unit except the siege creep and the tower shares that one rig and is told
apart by procedural kit (`weapons.ts`) rather than by scale and tint alone. That
is a gameplay concern, not a cosmetic one: a ranged creep has 300 HP and a melee
one 550, so which is which decides whether a swing is a last hit. Headgear is
kept narrower than the skull — at a 57 degree camera pitch a cap sized to the
head becomes a plate covering the whole unit from above.

`World.damageLog` is simulation output, not a drawing instruction, and the
renderer follows it by `seq` to place impacts. The sim still owns `floaters`,
which is a layering smell inherited from the first version; new presentational
state should go in the renderer.

## Conventions

- Strict TypeScript, including `noUnusedLocals` / `noUnusedParameters`.
- Relative imports carry the **`.ts` extension** (`allowImportingTsExtensions`).
- ES modules, `type` imports for types.
- Comments explain *why* a number or branch exists (often citing Dota behaviour),
  not what the line does. Match that density — sparse but substantive.
- No dependencies beyond `three`. Keep it that way unless asked.
- Heroes go by names of our own (Swordmaster, Frost Archer), never Valve's,
  anywhere a player can see: menu, HUD, results, README. Comments may still
  name the script file a hero's numbers come from, since that is the source
  citation. `canonicalHeroId` maps the ids they had before the rename, which
  saved configs and run history still carry.
- Item icons are drawn in `itemIcons.ts`. Do not swap in art ripped from
  Warcraft III or Dota; avoiding that is why they are drawn by hand.

## Known gaps

- `vite build` only picks up `index.html`; `slice3d.html` is dev-only until it is
  added as a rollup input.
- There is no XP, no levels, no items beyond an optional starting buy, and no
  abilities: heroes are permanently level 1 and creeps permanently at their
  0:00 stats. Faerie Fire's heal is not modelled, only its +2 damage, and
  Tango and Magic Stick do nothing at all. Deliberate — this is a
  last-hit drill, not a laning simulator.
- No fog of war, no day/night, no runes, no neutral camps, no high ground and so
  no uphill miss chance.
- Creep waves are 3 melee + 1 ranged, siege every 5th. Flagbearer creeps, which
  modern waves carry, are not modelled.
- Towers are invulnerable, so creeps that reach one cannot trade with it. In
  practice the lane oscillates around the middle and never parks a wave on a
  tower; a five-minute headless run holds the frontline between 2320 and 3115
  around a lane centre of 3000.
- Attack backswing values are community-measured, not from the scripts — Dota
  reads them off the attack animation, which the scripts do not encode.
- The creep rig has four clips, so a ranged creep plays the same club swing a
  melee one does. The bow and hood carry the read instead.
- `public/models/melee_creep.glb` is generated by `tools/blender/make_creep.py`
  and committed. Regenerate with `npm run model`, which runs:
  `blender --background --python tools/blender/make_creep.py -- --out public/models/melee_creep.glb`
- `public/models/swordmaster.glb` and `frost_archer.glb` are not generated. Both
  were modelled by hand in `tools/blender/heroes.blend` and exported from there,
  so `npm run model` does not touch them.

  | Hero | Scene | Collection | Rig | Actions | Hit frame (`hitTime`) |
  |---|---|---|---|---|---|
  | Swordmaster | "Swordmaster" | `SM_Body` | `SM_Rig` | `Idle`/`Walk`/`Attack`/`Death` | contact 14 (0.2333) |
  | Frost Archer | "FrostArcher" | `FA_Body` | `FA_Rig` | `FA_Idle` etc. | release 24 (0.4) |

  Both scenes run at 60 fps. Move the hit frame and the rig's `hitTime` has to
  move with it. To re-export one hero:
  - Select its collection plus its rig. The rigs are hidden in the viewport, so
    unhide one first or it is silently left out.
  - Options: glTF binary, Selected Objects, Active Scene, animation mode
    Actions, Always Sample, Include > Custom Properties.
  - Turn **off** "Export all Armature Actions" (`export_anim_single_armature`)
    and give the rig one single-strip NLA track per clip instead. Otherwise the
    exporter hands the other hero's actions to this rig as well.
  - The runtime needs the clips named exactly Idle/Walk/Attack/Death. The
    archer's actions carry an `FA_` prefix only because Blender action names
    are file-global, so rename them around the export.
  - Without Active Scene the default scene's Cube comes along. Without Custom
    Properties `hitTime` is lost, and the loader then treats the model as a creep.
  - Key every bone in every clip. A channel a clip leaves unkeyed keeps
    whatever the last clip left there, and the exporter bakes that in.
