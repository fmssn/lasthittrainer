# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Last Hit Trainer** — a browser drill for practising Dota 2 last hitting and denying.
No framework, no backend: TypeScript + Vite, a deterministic simulation, and a
hand-written renderer. Run history is kept in `localStorage`.

## Commands

```bash
npm run dev      # vite dev server on :5173 (2D game at /, 3D slice at /slice3d.html)
npm run build    # tsc --noEmit && vite build
npm run preview  # serve dist/
```

There is no test runner and no linter. `npm run build` (i.e. `tsc --noEmit`) is the
only automated check — run it after every change.

To preview in-session, use `preview_start` with the launch config named
`lasthittrainer` (`.claude/launch.json`); do not start the dev server via Bash.

## Architecture

The hard rule of this codebase: **the simulation knows nothing about rendering,
input, or the DOM.** `src/sim/` imports nothing from the other folders. Everything
else reads `World` and never mutates it outside `world.step()`.

```
src/sim/          Headless game simulation
  constants.ts    Dota 7.3x reference values + formulas (armor, BAT, attack point)
  config.ts       DrillConfig (what the menu can change) + enemy bot profiles 1-5
  types.ts        Unit, Vec2, Projectile, KillEvent — the whole data model
  units.ts        Creep/tower stat templates, spawnUnit, damage rolls
  heroes.ts       Level-1 hero templates, ordered by attack-timing difficulty
  math.ts         Vec helpers, angles, seeded RNG (makeRng)
  world.ts        World.step() — the fixed-timestep core. Spawns waves, resolves
                  windup/backswing, projectiles, damage, bounty, stats.
  ai/creepAi.ts   Creep targeting in Dota's own priority order
  ai/enemyHeroAi.ts  The bot laner, driven by an EnemyProfile

src/render/       2D canvas renderer + follow camera
  gameRenderer.ts The GameRenderer interface both renderers implement
  renderer.ts     2D canvas painter
  targetAids.ts   isPlayerTarget — the rule every training aid keys off
src/render3d/     three.js renderer, selectable from the menu
  scene.ts        Stage: camera, lights, ground. Sim (x,y) -> three (x,0,y)
  unitView.ts     One animated rig; picks a clip from sim state
  renderer3d.ts   GameRenderer on top of scene + rigs + ground rings
  annotations.ts  Screen-space layer: health bars, windup arc, floaters
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
- Attack timing is the whole point of the app: `attackPoint` (windup) and
  `attackBackswing` are authored in seconds and scale with attack speed, melee is
  instant on windup completion, ranged spawns a projectile. Treat this path as
  load-bearing.

### Rendering

Both renderers implement `GameRenderer` (`src/render/gameRenderer.ts`), and the
menu switches between them at runtime — `main.ts` and `input.ts` know nothing
else about either. The 2D path is the default and must keep working; 3D is still
marked experimental in the menu.

`src/render/renderer.ts` is a 2D canvas painter — it reads `World` and draws.
`src/render3d/renderer3d.ts` splits the same job in two: ground-plane art
(range rings, tower zones, the killable pulse) is real geometry, while anything
that must stay screen-sized and legible mid-swing (health bars, the deny line,
the damage preview, the windup arc, floaters) is drawn by `annotations.ts` on a
2D canvas over the stage. Sim→three mapping is fixed in `scene.ts`: sim
`(x, y)` → three `(x, 0, y)`, +Y up.

`#game` is always the pointer surface. In 3D it stays transparent and the stage
canvases are inserted underneath it, so `input.ts` never changes hands.

## Conventions

- Strict TypeScript, including `noUnusedLocals` / `noUnusedParameters`.
- Relative imports carry the **`.ts` extension** (`allowImportingTsExtensions`).
- ES modules, `type` imports for types.
- Comments explain *why* a number or branch exists (often citing Dota behaviour),
  not what the line does. Match that density — sparse but substantive.
- No dependencies beyond `three`. Keep it that way unless asked.

## Known gaps

- `vite build` only picks up `index.html`; `slice3d.html` is dev-only until it is
  added as a rollup input. The 3D renderer itself does ship, via the menu.
- Every unit reuses the one melee creep rig, tinted per team and scaled per kind.
- `public/models/melee_creep.glb` is generated by `tools/blender/make_creep.py`
  and committed. Regenerate with:
  `blender --background --python tools/blender/make_creep.py -- --out public/models/melee_creep.glb`
