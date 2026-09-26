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
```

The KayKit creep models in `public/models/units/` are built with the pinned
Blender and packs from `tools/fetch_assets.sh`:
`<blender> --background --python tools/blender/build_units.py` (`--only
melee_creep` for one look, `--renders DIR` for contact sheets under `xvfb-run`).
It checks every file it writes and two builds are byte-identical.

The sounds in `public/audio/` were generated with Stable Audio 3 Medium on a
ComfyUI (`tools/audio/generate.py`, then `process.py` to rank and clean the
takes) and picked by ear. `tools/audio/keepers.json` names the prompt and take
behind every file, and `docs/sounds.md` says why each prompt reads as it does
and why it is Medium and not Medium Base.

`tools/blender/check_anim.py` checks the hero clips the way three.js plays
them and films what it finds: `<blender> --background --python
tools/blender/check_anim.py -- --glb public/models/heroes/swordmaster.glb
--glb public/models/heroes/frost_archer.glb [--blend tools/blender/heroes.blend]
[--clips Attack,Walk] [--no-video]` (under `xvfb-run -a` without a display).
Per bone and 60 fps sample it measures the parent-relative turn (short path),
jitter and the Idle/Walk loop seams; it also measures clipping between the
deformed meshes (bind-pose intersections excluded), GLB weights, and with
`--blend` influences past four and Preserve Volume. Thresholds are constants at
the top. It writes `shots/anim/report.md`, `report.json`, and one MP4 per hero
and clip: clay 3/4 and side views, 4x slow, flagged frames held, flagged bones
orange and clipping faces red. It reads the models and never writes them.

The three browser harnesses drive the Chromium a Claude Code container ships at
`/opt/pw-browsers`; anywhere else they fall back to playwright's own, which
`npx playwright install chromium` fetches once. `CHROMIUM` overrides both
(`tools/chromium.mjs`). Node 20+ is required — playwright will not run on 18 —
and CI uses 24.

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
the Frost Archer on both sides — level 3 against level 3 comes out 7.0 to
9.0 last hits, gap 2.0, and the ladder runs 1.7 -> 5.0 -> 9.0 -> 12.7 ->
14.0. That gap is open, not accepted: over seeds 1-12 it is 5.3 to 8.8, gap
3.4, exactly what those seeds gave before creeps learned to walk round their
own wave (an earlier twelve-seed Swordmaster mirror read 4.1 to 5.5), with
Dire ahead in most seeds, so the lane leans Dire. Before the roster was cut the harness
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
  effects.ts      Pooled impact sprites, driven by World.damageLog
  projectileView.ts  Oriented bolts with trails; flat travel, no arc
  renderer3d.ts   Renderer3D: scene + views + ground rings, and unit picking
  outline.ts      The hover outline: a screen-space pass over the stage
  annotations.ts  Screen-space layer: health bars, aggro timer, floaters
src/audio/        Lane sound, render-side like the effects
  sounds.ts       The manifest and the whole mix: file, group, level, voice cap
  mixer.ts        Web Audio: groups, limiter, loading, voice stealing, jitter.
                  Knows nothing about World.
  laneAudio.ts    Reads World each frame and calls the mixer. The only file
                  that knows what a DamageEvent is.
  settings.ts     Mute (the M key), in localStorage (key `lht.audio.v1`). No
                  volume controls in the menu, by request.
src/ui/           menu.ts, hud.ts, results.ts — plain DOM over the canvas
  inventory.ts    The six item slots, shared by the menu, HUD and results
  itemIcons.ts    Item icons as SVG, in the style of the WC3 buttons
src/input.ts      Dota-style mouse/keyboard mapping
src/stats.ts      RunRecord persistence in localStorage (key `lht.runs.v1`)
src/main.ts       Entry point: state machine (menu/playing/paused/results) + loop
src/slice3d.ts    Debug entry point: unattended sim, clip histogram, free look
tools/blender/    build_units.py builds the KayKit creeps in public/models/units/;
                  heroes.blend holds the hand-built heroes in public/models/heroes/
tools/audio/      generate.py, process.py and the record of every sound's take
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
- Nothing shoves anything. A unit walking into another slides round it or
  stops against it, and the one standing there never moves: that is what
  makes bodyblocking possible. Bodies meet at `bodyRadius(kind)`, which
  follows the drawn rigs and is wider than Valve's hulls; `Unit.radius` stays
  the hull, because attack range is measured to it.
- A slide runs along a body but never back: a step deflected off two bodies
  can point away from the goal, and taking it made a creep shudder in the
  back of its own wave, forward into the pocket and out again every frame.
  A unit walking into range heads for a free spot on the ring round its
  target (`World.standSpot`), preferring one it can walk to in a line, and
  keeps it in `Unit.chaseSpot` until a body takes it. Choosing afresh every
  frame flip-flopped between spots in the same way. Both are covered by a
  stride-reversal count in `npm run check`.

### Performance

Measured over 45 seconds of a level-5 lane: peak 210 draw calls, 16k triangles,
10 rigs. That was before the hero models. A Swordmaster is about 14.8k triangles
in 29 primitives and a Frost Archer 9.8k in 40, and the shadow pass draws each
again, so a Swordmaster mirror comes to about 270 calls and 74k triangles.
That is nothing for a real GPU, but it is where the budget now goes. Rocks and trees are one instanced mesh each. The 220 impact sprites are
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

The drawing splits in two: ground-plane art (the selection ring, tower zones)
is real geometry, while anything that must stay screen-sized and legible
mid-swing (health bars, floaters) is drawn by `annotations.ts` on a 2D canvas
over the stage. The unit under the cursor is outlined by a screen-space pass
(`outline.ts`): it is drawn flat into a mask and the pixels just outside it are
lit, except where another unit stands in front. Every unit view is on
`OCCLUDER_LAYER` for that depth test; the lane is not, or it would eat the
bottom of every outline. There is no cursor ring on the ground.

There are no training aids. A killable highlight, damage preview, deny line on
the bars, an in-flight damage chunk, wind-up arc, range ring, a dashed line to
your attack target and an A-key hint that lit up over a denyable creep all existed and were removed as distracting: the drill should
look like the game, so the timing is read off the creep and not the overlay.
Do not add them back without being asked.
Sim→three mapping is fixed in `scene.ts`: sim `(x, y)` → three `(x, 0, y)`, +Y up.

`#game` is the pointer surface: it stays transparent and the stage canvases are
inserted underneath it, so `input.ts` owns every listener and never changes hands.

Picking is the renderer's job, not the sim's (`Renderer3D.pickUnit`). A rig
stands ~100 sim units tall, so the ground point under the cursor is not what the
cursor looks like it is over — aiming at a creep's chest resolves to a lane point
tens of units behind its feet. The cursor ray is tested against an upright
cylinder per unit instead, so the whole visible body is clickable.

The models are a hard startup dependency: `main.ts` loads the four KayKit
creep files and one model per hero before building the renderer, and shows a
fatal message if any fails, since there is no 2D path to fall back to. A
missing hero model is as fatal as a creep: there is no stand-in that swings on
the hero's timing. The procedural box rig that once was one (`make_creep.py`,
`weapons.ts`) went once every unit kind had a model; git history has it.

Melee and ranged creeps are KayKit skeletons (CC0), one file per kind and team,
built by `tools/blender/build_units.py` with the team colour in the atlas. They
read apart by weapon (blade and shield against a staff and a caster's hat),
which is a gameplay concern, not a cosmetic one: a ranged creep has 300 HP and
a melee one 550, so which is which decides whether a swing is a last hit. Their
Attack clip carries its contact time and their Walk clip its stride in glTF
extras (`hitTime`, `groundSpeed`), which `loadKayKitCreep` refuses to load
without.

Each hero has a model of its own, `public/models/heroes/<heroId>.glb`, loaded
for every id in `HEROES`. The armature carries `hitTime` (seconds into the
unscaled Attack clip where the blow lands, or the arrow leaves) as a custom
property, exported as node extras, and `loadHero` refuses a file without it.
A hero model wears its own gear, and only its `Team` material takes the team
tint. The renderer finds a hero's model by matching `Unit.name` against
`HEROES`, since the sim carries no render-only hero id. A hero's arrow leaves from `HERO_LAUNCH` in `projectileView.ts`, the height
of the Frost Archer's bow at full draw, not from a creep's shoulder.

`World.damageLog` is simulation output, not a drawing instruction, and the
renderer follows it by `seq` to place impacts. The sim still owns `floaters`,
which is a layering smell inherited from the first version; new presentational
state should go in the renderer.

### Audio

Audio is render-side too, and follows `damageLog` by `seq` the same way:
`laneAudio.ts` turns new damage events into hits, deaths and the coin or deny,
new projectile ids into launches, and a hero's phase turning to `windup` into
`sword_swing` or `bow_draw`. `DamageEvent.sourceId` exists for it, so your blow
can be told from the bot's. It runs only while a drill plays; the menu
backdrop is a real World and stays silent. Its jitter uses `Math.random()`,
which is fine outside the sim and must never touch `world.rng`.

The same rule as the overlay: the drill should sound like the game. Dota plays
an attack sound on contact and a coin on a last hit, and nothing that says a
creep is killable, so neither does this. The coin and deny are yours alone and
centred; your hero plays centred, the bot's 4 dB lower where it happens.

The sounds are **not** a startup dependency, unlike the models: they load
beside them, and a file that fails warns once and stays silent. The context
starts suspended, as browsers keep it until a gesture, and is resumed from the
first overlay click. Pause and a hidden tab suspend it, which freezes what was
mid-air as well. `__lht.audioStats()` counts the plays requested per sound,
audible or not; `npm run check` holds it to a coin per last hit and a deny per
deny over three minutes of lane, with a counting mixer standing in for Web
Audio. Nothing but a person checks the mix. Levels live in `sounds.ts` and
nowhere else; if the lane is muddy, turn the lane down, never the rewards up.

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

- Only the creep level in `sounds.ts` has been tuned by ear (`CREEP_DB`, from
  -10 down to -22); the rest is the plan's starting levels. The two tests for
  it: every last hit is audible without watching the screen, and a creep's
  hits on your target can be told from the rest of the lane, on laptop
  speakers and on headphones.
- One take per sound. Where docs/sounds.md asks for two or three variations,
  the pitch and level jitter on every play stands in for them.
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
- `public/models/heroes/swordmaster.glb` and `frost_archer.glb` are not generated. Both
  were modelled by hand in `tools/blender/heroes.blend` and exported from there,
  so no build script touches them.

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
    That includes location: the Swordmaster's `weapon` location was keyed
    only in Death, which floated the sword 80 cm off the hand in the other
    three clips depending on which clip Blender had evaluated last.
  - Hide a bone at scale 0.001, not 0. The exporter samples whole matrices,
    and a zero-scale matrix has no rotation, so the file gets an arbitrary
    one (the arrow spun 82 degrees on the frame it was hidden).
  - Run `tools/blender/check_anim.py` on the exported files afterwards: no
    rotation or jitter flags is the bar.
