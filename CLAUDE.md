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
npm run shot     # screenshot the menu and a formed lane (needs npm run dev)
```

There is no linter. `npm run build` (i.e. `tsc --noEmit`) plus `npm run check`
are the automated checks — run both after every change.

`npm run check` (`tools/simcheck.mjs`) is not a test runner: it drives a real
Chromium against the dev server and imports the actual sim modules through
vite, then asserts numbers. That is what lets it exist without dragging a
toolchain into a project whose only dependency is three. It covers the Dota
reference values, swing timing to the frame, creep targeting and aggro, contact
behaviour, and a fixed-seed replay. Exits non-zero on the first failure.

`npm run shot` (`tools/shot.mjs`) captures the menu and a lane 14 seconds in at
a fixed seed, so two runs frame the same moment and a renderer change can be
looked at rather than argued about. A visual change that is not screenshotted
is not reviewed.

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
                  hand-copied. Ordered by attack-timing difficulty.
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
src/input.ts      Dota-style mouse/keyboard mapping
src/stats.ts      RunRecord persistence in localStorage (key `lht.runs.v1`)
src/main.ts       Entry point: state machine (menu/playing/paused/results) + loop
src/slice3d.ts    Debug entry point: unattended sim, clip histogram, free look
tools/blender/    Headless Blender script that generates public/models/melee_creep.glb
```

### Simulation rules

- Fixed timestep of **1/120 s**, accumulator-driven, capped at 0.25 s of catch-up.
  Never step the world from a render path or with a variable `dt`.
- Deterministic: all randomness goes through `world.rng` (seeded from
  `DrillConfig.seed`). Do not call `Math.random()` inside `src/sim/`.
- `constants.ts` is a **reference sheet of real Dota values**, not a tuning file.
  Training knobs belong in `config.ts`. If a value is a deliberate simplification,
  say so in a comment next to it — the existing comments follow that convention.
- Unit and hero numbers come from Valve's own `npc_units.txt` and
  `scripts/npc/heroes/*.txt`. **Do not adjust them by feel.** If one looks wrong,
  check it against the scripts and change it with the source named in the
  comment. `npm run check` asserts the whole table, so a drive-by tweak fails.
- Hero level-1 stats are *derived* from base stats plus attributes (22 HP and
  0.1 regen per strength, 0.167 armor and 1 attack speed per agility, +1 damage
  per point of primary). Add a hero by writing its `HeroSource`, not by
  computing a stat block by hand.
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
longer a 2D path to fall back to.

Every unit except the siege creep and the tower shares that one rig and is told
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

## Known gaps

- `vite build` only picks up `index.html`; `slice3d.html` is dev-only until it is
  added as a rollup input.
- There is no XP, no levels, no items and no abilities: heroes are permanently
  level 1 and creeps permanently at their 0:00 stats. Deliberate — this is a
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
- The rig has four clips, so a ranged creep plays the same club swing a melee
  one does. The bow and hood carry the read instead.
- `public/models/melee_creep.glb` is generated by `tools/blender/make_creep.py`
  and committed. Regenerate with:
  `blender --background --python tools/blender/make_creep.py -- --out public/models/melee_creep.glb`
