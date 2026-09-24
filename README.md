# Last Hit Trainer

A browser drill for Dota 2 last hitting and denying. Real 7.3x creep values, real
hero attack animations, a lane that behaves like a lane. Pick a hero, run a timed
drill, get a score you can actually compare week to week.

```bash
npm install
npm run dev
```

## What it trains, in four layers

1. **Last hits** — always on. Land the killing blow on enemy creeps.
2. **Denies** — A-click your own creeps at or under 50% HP. The deny line is drawn on every health bar.
3. **Contested lane** — an enemy hero goes for the same creeps, with a reaction delay and an HP-estimate error band set by difficulty. It does not read the simulation state perfectly.
4. **Creep aggro** — right-clicking the enemy hero pulls every enemy creep within 500 range onto you for 2.3 seconds, and pulls the tower if you are inside its range. Harass is not free.

Each layer is a toggle in the menu, so you can drill one thing at a time.

## Controls

| Input | Action |
| --- | --- |
| Right click | Move, or attack an enemy under the cursor |
| `A` + left click | Attack-move — and the only way to deny your own creep |
| `S` | Stop. Cancels the backswing and frees the next order |
| Scroll | Zoom |
| `Space` / `Esc` | Pause |

Right-clicking never attacks your own units, same as the real game.

## The one idea worth knowing

The window where a creep is exactly one hero hit from death is roughly half a
second. Shadow Fiend's attack takes 0.47s of wind-up plus projectile travel — so
by the time a creep *looks* killable, it is already too late to click.

That is why the "swing now" highlight in this trainer is predictive. It projects
the creep's HP forward to the instant your attack would actually land, counting
every projectile already in the air and every scheduled swing from everything
else hitting it, and lights up when starting a swing *right now* would finish it.
That is the timing your hands need to learn.

Turn the training aids off once it clicks. That is the graduation.

## Fidelity notes

Values live in [`src/sim/constants.ts`](src/sim/constants.ts),
[`src/sim/units.ts`](src/sim/units.ts) and [`src/sim/heroes.ts`](src/sim/heroes.ts).

- Creeps use 7.3x base stats with no per-minute scaling — a drill is always minute zero, which is also the hardest timing to learn.
- Armor uses the real formula, `1 - 0.06a / (1 + 0.06|a|)`.
- Attack point and attack interval both scale with attack speed. The wind-up roots you; the backswing is cancellable.
- A target that dies during your wind-up costs you the swing, and the run counts those.
- Hero damage is base plus the level 1 primary attribute contribution.
- Tier 1 towers are present and **invulnerable on purpose**: they anchor the lane so a run cannot death-spiral, and they punish diving, but a tower falling would make every run a different game.
- Turn rate is calibrated by feel — the engine's per-frame turn formula is not public.

## Layout

```
src/sim/        headless simulation: units, combat, waves, creep and hero AI
src/render/     canvas renderer and camera
src/ui/         menu, HUD, results
src/stats.ts    run history in localStorage
```

`src/sim` has no DOM dependency, so it runs headless:

```bash
node --experimental-strip-types yourscript.ts
```

That is how the lane was balanced — driving both sides with the same laning AI
and checking that last hits per minute, creep lifetimes and death counts land
where a real lane puts them.
