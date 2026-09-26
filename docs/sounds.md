# Sound list

Sounds to generate for the drill, modelled on what Dota itself plays in lane.
Nothing is wired up yet; this is the shopping list.

The rule is the same one the renderer follows: **the drill should sound like
the game.** Dota gives you no audio cue for "this creep is killable", so none is
listed here. What it does give you is an attack sound at the moment of contact
and a coin clink on a last hit, and that is what a player's ear is trained on.

Format: mono WAV or OGG, 44.1 kHz, trimmed tight (no silence before the
transient: a late onset shifts where the hit seems to land). Sounds that play
every second need 2–3 variations so the lane does not machine-gun; the loader
can pick one at random render-side (never through `world.rng`).

## Must have

| File | When it plays | Sim hook | Var. | Prompt idea |
|---|---|---|---|---|
| `last_hit_gold` | You get a last hit | `KillEvent`, killer is you, `gold > 0` | 1 | small bright coin clink, two coins, short, clean |
| `deny` | You deny one of your creeps | `KillEvent`, killer is you, `denied` | 1 | soft muted thud with a short dry click, understated |
| `sword_swing` | Swordmaster's windup starts | hero enters windup | 2 | fast blade whoosh, light, short |
| `sword_hit` | Swordmaster's blow lands | `DamageEvent`, hero, melee | 3 | sword slicing into leather armor, sharp, short |
| `bow_release` | Frost Archer's arrow leaves | projectile spawned by hero | 2 | bowstring twang with an icy shimmer |
| `frost_arrow_hit` | Arrow lands | `DamageEvent`, hero, ranged | 2 | arrow thunk into flesh with a small ice crackle |
| `melee_creep_hit` | Melee creep's swing lands | `DamageEvent`, creep, melee | 3 | crude club or short sword hitting armor, dull, short |
| `ranged_creep_cast` | Ranged creep fires | projectile spawned by creep | 2 | small magic bolt whoosh, soft |
| `ranged_creep_hit` | Its bolt lands | `DamageEvent`, creep, ranged | 2 | small magic impact, fizzle pop |
| `creep_death` | Any creep dies | `KillEvent`, victim is a creep | 3 | short creature death grunt, not gory |

`sword_swing` is the one sound that starts at the *beginning* of the attack
rather than its end. Dota has it too (the `PreAttack` sound many melee heroes
carry), and it is what lets you hear that you started a swing too early.

The hit sounds matter more than they look: in Dota you time a last hit partly
by ear, listening to the creeps' own hits on the target. Keep them short and
with a hard transient so each one is clearly placed in time.

## Nice to have

| File | When it plays | Sim hook | Var. | Prompt idea |
|---|---|---|---|---|
| `siege_launch` | Catapult fires | siege attack release | 1 | wooden catapult arm thump and creak |
| `siege_hit` | Boulder lands | `DamageEvent`, siege | 1 | heavy rock impact, low, crunchy |
| `tower_attack` | Tower fires | tower attack release | 1 | deep arcane bolt launch, resonant |
| `tower_hit` | Tower bolt lands | `DamageEvent`, tower | 1 | heavy energy impact, short |
| `hero_death` | A hero dies | `KillEvent`, victim is a hero | 1 | low heavy fall with armor clatter |
| `horn` | Run starts (Dota's 0:00 horn) | `start()` in `main.ts` | 1 | distant war horn, one long note |
| `lane_ambience` | Loops under the whole run | — | 1 | outdoor forest ambience, light wind, distant birds, seamless loop, 30–60 s |
| `ui_click` | Menu buttons | DOM | 1 | soft wooden UI click |
| `run_end` | Results screen | `finish()` in `main.ts` | 1 | short low gong or drum hit |

## Deliberately left out

- **Voice lines** (hero responses on orders, "denied!" taunts). Dota has them,
  but they are the most repetitive part and add nothing to the timing.
- **Footsteps.** Ten rigs walking is noise, not information.
- **Anything Dota does not play:** a "killable now" ping, a wave-spawn chime,
  a miss sound. Same reason the overlay aids were removed.
