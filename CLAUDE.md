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

The sounds in `public/audio/` were generated with Stable Audio 3 Medium on a
ComfyUI (`tools/audio/generate.py`, then `process.py` to rank and clean the
takes) and picked by ear. `tools/audio/keepers.json` names the prompt and take
behind every file, and `docs/sounds.md` says why each prompt reads as it does
and why it is Medium and not Medium Base.

Everything drawn in the lane — heroes, creeps, catapults, towers, scenery and
the ground's tiles — is in `public/sprites/`, rendered from Synty's POLYGON
packs, which are licensed and so not in the repo: `art_src/README.md` lists
the zips, where they unpack, and the four steps that rebuild the sprites
(`tools/blender/build_characters.py` and `build_props.py`, supplyline's sprite
pipeline on the render farm, `tools/blender/pack_sprites.py`). Each step
refuses input the next one would choke on: a clip without its contact frame, a
frame touching its sprite's edge, a pixel outside the palette.

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

`npm run shot` (`tools/shot.mjs`) captures the menu and a lane at 0:14 on the
game clock at a fixed seed, with the hero walked up from its tower, so two runs frame the same moment and a renderer change can be
looked at rather than argued about. A visual change that is not screenshotted
is not reviewed.

`npm run balance` (`tools/balance.mjs`) drives *both* heroes with the same
laning AI and holds your side at bot profile 3, so the only thing changing
down the table is the opponent. It runs to 3:00 on the game clock. It is a measurement, not a pass/fail, and it
catches the one class of bug nothing else here can: a side bias. A lane where
Radiant quietly farms better than Dire would flatter you for three minutes and
teach you nothing, and staring at the code does not find it. Current reading,
with the Frost Archer on both sides, heroes levelling and the lane opening on
the countdown from behind the towers — profile 3 against profile 3 comes out
3.7 to 8.0 last hits, gap 4.3, and the ladder runs 1.7 -> 3.0 -> 3.7 -> 9.0 ->
10.3. Before the countdown, when the drill opened on a formed lane, it read
4.0 to 7.7, gap 3.7, over the same three seeds. Three seeds swing that gap badly: over twelve the
mirror is 5.0 to 7.7, over another 24 it is 7.1 to 8.1 and over 60 more (seeds
200-259) it is 7.1 to 7.8, with the ladder monotonic throughout (2.8 -> 5.0 ->
8.1 -> 9.9 -> 13.7 over the 24). So Dire still edges the lane, by under a last
hit. That gap is open, not accepted; it read 1.3 to 1.9 on the 12 and 24
before creeps stopped taking whatever was already in attack range. Re-run it
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
  heroes.ts       Hero base stats, attributes and per-level gains; stats at every
                  level are derived, not hand-copied. Two heroes, ordered by
                  attack-timing difficulty.
  items.ts        Starting items from items.txt, 600 gold / 6 slot / stacking
                  rules
  math.ts         Vec helpers, angles, seeded RNG (makeRng)
  world.ts        World.step() — the fixed-timestep core. Spawns waves, resolves
                  windup/backswing, projectiles, damage, bounty, experience,
                  levels, stats.
  ai/creepAi.ts   Creep targeting in Dota's own priority order
  ai/enemyHeroAi.ts  The bot laner, driven by an EnemyProfile

src/render3d/     The renderer: three.js stage + screen-space overlay
  scene.ts        Stage: camera, lights. Sim (x,y) -> three (x,0,y)
  terrain.ts      Ground (the packs' tiles mixed in a shader), lane path, and
                  the rock ridges and treeline as instanced sprite cards
  assets.ts       Loads every sprite sheet and ground tile before the renderer
  appearance.ts   Shared render-side facts about units: tint, scale, how tall a
                  rig is, how wide it is to click. The stage and the overlay
                  both read it so they cannot disagree.
  spriteView.ts   Every unit: pre-rendered sprite frames on a camera-facing
                  quad, the clip picked from sim state, a hero's team colour
                  by palette swap
  effects.ts      Pooled impact sprites, driven by World.damageLog
  projectileView.ts  Oriented bolts with trails; flat travel, no arc
  renderer3d.ts   Renderer3D: scene + views + ground rings, and unit picking
  outline.ts      The hover outline: a screen-space pass over the stage
  annotations.ts  Screen-space layer: health bars (heroes with their level plate),
                  aggro timer, floaters
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
tools/blender/    build_characters.py (heroes, creeps) and build_props.py
                  (catapults, towers, scenery, ground tiles) build the sprite
                  sources; pack_sprites.py packs the rendered sheets
art_src/          Where the Synty packs unpack (git-ignored) and palette.hex
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
- Hero stats are *derived* from base stats plus attributes, at every level (22
  HP and 0.1 regen per strength, exactly 1/6 armor and 1 attack speed per
  agility, +1 damage per point of primary; each level past the first adds the
  hero file's `Attribute*Gain`, unrounded). Add a hero by writing its
  `HeroSource`, gains included, not by computing a stat block by hand. Copy
  `BaseAttackSpeed` too when the hero file overrides the base 100 — the
  Swordmaster's 110 went missing once and made its swing 0.018s slow.
- A drill opens with `START_COUNTDOWN` (5 s, `config.ts`) of empty lane, both
  heroes behind their tier 1s. `World.time` is the game clock and starts at
  minus that, so the first wave leaves the bases at 0:00 and anything keyed to
  the clock (the 5:00 early-aggro block) keeps its Dota time. The horn plays at
  0:00. `npm run check` wraps `World` so every check starts at the first creep
  swing, the moment the old formed-lane start dropped you into.
- The drill's camera is fixed at Dota's framing (`ZOOM_DEFAULT` in `scene.ts`);
  the wheel does nothing in a drill. Only the debug page zooms.
- Heroes level, the bot included. A death pays its `bountyXp` (a hero: 100 +
  13% of its experience) to the living enemy heroes within 1500, split and
  truncated, whoever landed the blow; a denied creep pays the enemy half and
  the denier nothing. A level-up rebuilds the hero's stats from its
  `HeroSource` and items (`World.loadouts`), keeps the health fraction, and the
  level sets the respawn time. The table, range and factors are not in the
  scripts, so each cites the patch note that set it in `constants.ts`.
- Attack classes come from Valve's creep passives (`creep_irresolute`,
  `creep_piercing`, `creep_siege` in `npc_abilities.txt`), composed in
  `ATTACK_CLASS` and applied in `World.applyModifiers` after Quell and armor:
  melee creeps deal 75% to heroes, ranged creeps 50% to heroes and 150% to
  creeps, and siege creeps and towers take 50% from heroes. The bot's estimate
  goes through the same function, so it can never disagree with the hit.
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
  range. Then it picks from everything in acquisition range by unit type
  (heroes and creeps are one tier, per Valve's glossary), then threat (hitting
  it, hitting its allies, idle, hitting its own side), then distance. Being in
  attack range already earns nothing: ranking that first is what had creeps
  turning on an idle hero beside a fighting wave. With nothing in range it
  keeps chasing what it had, however far: there is no leash, and no fog to
  lose a target in. A swing already under way is never re-aimed, because the
  release reads `attackTargetId` at release time and would otherwise hand the
  damage to the new target.
- Aggro reaches `AGGRO_RADIUS` (500) from the hero, for every creep kind and
  for towers. An attack *order* on an enemy hero pulls (a forced 2.3 s chase)
  and starts the hero's 3 s cooldown whether or not anything came. Every swing
  at a hero that reaches its wind-up, auto-attacks included, draws nearby
  creeps again while the cooldown is ready, with no chase and no cooldown of
  its own. An attack order on your own unit hands aggro back only while the
  cooldown is ready, and starts it: whatever was hitting you picks again with
  you ranked last (`Unit.shunnedId`) until it settles. A tower lets go only for
  a nearer unit of yours, on its own 2.5 s cooldown. Before 5:00 a lane creep
  with no enemy creep in acquisition range and more than 1550 from its own
  tier 1 ignores all of it (7.27).
- Nothing shoves anything. A unit walking into another slides round it or
  stops against it, and the one standing there never moves: that is what
  makes bodyblocking possible. Bodies meet at `bodyRadius(kind)`, which
  follows the drawn rigs and is wider than Valve's hulls; `Unit.radius` stays
  the hull, because attack range is measured from it: the authored range plus
  both hulls, edge to edge. A tower's 700 reaches a hero 868 from its centre,
  and a melee creep's 100 is 140.
- A slide runs along a body but never back: a step deflected off two bodies
  can point away from the goal, and taking it made a creep shudder in the
  back of its own wave, forward into the pocket and out again every frame.
  A unit walking into range heads for a free spot on the ring round its
  target (`World.standSpot`), preferring one it can walk to in a line, and
  keeps it in `Unit.chaseSpot` until a body takes it. Choosing afresh every
  frame flip-flopped between spots in the same way. Both are covered by a
  stride-reversal count in `npm run check`.

### Performance

Measured over 40 seconds of the slice page's lane: peak 61 draw calls, 4.6k
triangles, 12 units. Every unit is one quad and a shadow capsule, and the
scenery one instanced quad for its whole page, so drawing costs next to
nothing; what the sprites cost is texture memory, one byte of palette index
per pixel: about 46 Mpx per hero, 19 to 27 per creep, 21 per catapult and 12 for
the scenery, some 250 Mpx in all on pages of up to 4096 square. The catapults
are rendered at 56 px/m and 15 fps rather than a creep's 88 and 30 to keep them
there. The 220 impact sprites are individual draw calls, which is the one thing
here that could scale badly, but it never gets near saturation in practice —
so it stays simple.

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

The sprites are a hard startup dependency: `main.ts` loads every sheet and
ground tile (`assets.ts`) before building the renderer, and shows a fatal
message if any fails, since there is nothing to fall back to: no stand-in
swings on a unit's timing. The procedural box rig (`make_creep.py`,
`weapons.ts`), the KayKit creeps (`build_units.py`, `unitView.ts`), the
catapult's own geometry (`siegeView.ts`), the hand-built 3D heroes
(`heroes.blend`, `check_anim.py`) and the procedural tower, rocks and trees all
went as sprites replaced them; git history has every one.

Every unit is a sprite (`spriteView.ts`), loaded from
`public/sprites/<id>.json` and its pages: a hero's by its id in `HEROES`,
everything else's by kind and team (`appearance.ts` `sheetId`). They are
Synty POLYGON models, rendered from the lane camera's 57 degrees and sun, in 16
facings (a tower in one) and every frame, and snapped to
`art_src/sprites/palette.hex` (Aurora plus a key ramp). Characters wear Synty
weapons and play Synty's own clips, retargeted in `tools/blender/synty.py`; a
catapult has no skeleton, and `build_props.py` keys its arm, crank and wheels
about their own pivots. What the game draws is a quad facing the camera with
the frame for the unit's clip, time and facing on it.

The creeps read apart by weapon, a blade and shield against a staff, and by
side, Fantasy Kingdom's soldier and mage against Dark Fortress's undead and
wraith. That is a gameplay concern, not a cosmetic one: a ranged creep has 300
HP and a melee one 550, so which is which decides whether a swing is a last
hit. There is no Synty spell pack, so the ranged creep casts with the sword
pack's thrust, held with a staff; the bolt leaves as it points.

- Attack starts on the phase turning to windup and is rescaled so its
  `hitTime` (the contact, the arrow or bolt leaving, the catapult's release)
  lands on the sim's attack point. Walk plays at its authored rate at full
  move speed (`WALK_CADENCE_MAX` in `spriteView.ts`), not foot-locked to its
  measured `groundSpeed`, which read as frantic legs.
  The clip is baked so the hit is a whole frame at the level-1 attack point, and
  a sheet missing its hitTime is refused at load.
- Direction 0 faces the camera and each next one is a step clockwise from
  above, which is a step up in sim angle.
- A page holds palette indices, a byte per pixel. A hero's team colour is a
  palette swap: the team's cloth renders in a key colour whose ramp the
  palette keeps, and each team's palette has its colour there instead. Creeps,
  catapults and towers are a different model per team and need none.
- The quad writes the depth of the unit's feet (lifted a little toward the
  camera, further for a tower or catapult) across its whole height, so it
  sorts against every other sprite as a card standing where the unit stands. It keeps its own material in the outline's
  mask passes (`allowOverride = false`) and draws itself flat there, so the
  outline follows its pixels. An invisible capsule casts its shadow.

The renderer finds a hero's sprites by matching `Unit.name` against `HEROES`,
since the sim carries no render-only hero id. A hero's arrow leaves from
`HERO_LAUNCH` in `projectileView.ts`, about the height of the Frost Archer's
bow at full draw, a tower's bolt from its top and a catapult's stone from the
top of its throw, not from a creep's shoulder.

The ground is the packs' seamless ground textures, scaled down into
`public/sprites/ground/` and mixed in `terrain.ts`'s shader so no tile repeats
one-for-one: each is sampled at two scales turned against each other, noise
fields lay a second ground and flowers or moss over the first, Radiant's grass
gives way to Dire's mud along a line that wanders across the middle, and the
path is worn down the corridor. The tiles are not snapped to the palette:
their shading is a few percent across a whole tile, and snapping flattened it
into two or three blotches. Trees, rocks and bushes are sprite cards like the
units, each a random model in a random one of eight facings, never the same
model as the one before it; the rocks are drawn at half brightness, since a
pale rock at full strength was the brightest thing on screen.

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
- There are no abilities, so no skill points, talents or innates, and no items
  beyond an optional starting buy; creeps stay at their 0:00 stats. The innates
  matter: in game both heroes gain agility from one (the Frost Archer's
  Precision Aura from level 1, the Swordmaster's Bladeform while untouched), so
  their damage here is a little under the real thing. Faerie Fire's heal is not
  modelled, only its +2 damage, and Tango and Magic Stick do nothing at all.
  Deliberate — this is a last-hit drill, not a laning simulator.
- No fog of war, no day/night, no runes, no neutral camps, no high ground and so
  no uphill miss chance.
- Creep waves are 3 melee + 1 ranged, with a siege creep every 10th wave from
  5:00 as in Dota. That is the 11th wave and the menu stops at ten, so none
  ever enters a drill, and the early-aggro block covers all of every drill but
  the tail of a ten-wave one. Flagbearer creeps, which modern waves carry, are
  not modelled.
- Towers are invulnerable, so creeps that reach one cannot trade with it. In
  practice the lane oscillates around the middle and never parks a wave on a
  tower; a five-minute headless run holds the frontline between 2320 and 3115
  around a lane centre of 3000.
- Attack backswing values are community-measured, not from the scripts — Dota
  reads them off the attack animation, which the scripts do not encode.
- The sprites are rendered, not drawn: nothing has been hand-cleaned in
  Pixelorama yet, and the `.pxo` files the pipeline writes stay in the
  git-ignored build folder. The Synty clips are stock ones (a light sword combo
  and its return to idle; the bow pack's raise, draw and release chained; the
  sword pack's thrust standing in for a cast), so a swing is Synty's timing
  squeezed onto Dota's, not a swing authored for it. A creep's 0.3 s backswing
  plays the return to idle four to six times as fast as authored.
- The single-file build (`npm run pack`) is well over the 16 MB a publishing
  host accepts, now that every unit is a sprite sheet.
