# Last Hit Trainer

A browser drill for Dota 2 last hitting and denying. Real 7.3x creep values, real
hero attack animations, a lane that behaves like a lane. Pick a hero, run a timed
drill, get a score you can actually compare week to week.

Two heroes for now, one melee and one ranged, because the feel of each has to be
right before a third is worth adding: the **Swordmaster** and the **Frost
Archer**. The names are this project's own; the numbers behind them are real.

```bash
npm install
npm run dev
```

## What it trains, in four layers

1. **Last hits** — always on. Land the killing blow on enemy creeps.
2. **Denies** — A-click your own creeps at or under 50% HP.
3. **Contested lane** — an enemy hero goes for the same creeps, with a reaction delay and an HP-estimate error band set by difficulty. It does not read the simulation state perfectly.
4. **Creep aggro** — right-clicking the enemy hero pulls every enemy creep within 500 range onto you for 2.3 seconds, and pulls the tower if you are inside its range. Harass is not free.

Each layer is a toggle in the menu, so you can drill one thing at a time.

## Controls

| Input | Action |
| --- | --- |
| Right click | Move, or attack an enemy under the cursor |
| `A` | Attack or deny whatever the cursor is over; over empty lane, attack-move there. The only way to deny your own creep |
| `S` | Stop. Cancels the backswing and frees the next order |
| Scroll | Zoom |
| `Space` / `Esc` | Pause |

Right-clicking never attacks your own units, same as the real game.

## The one idea worth knowing

The window where a creep is exactly one hero hit from death is roughly half a
second. The Frost Archer's attack takes 0.4s of wind-up plus arrow travel — so
by the time a creep *looks* killable, it is already too late to click.

There are no training aids to lean on: no killable highlight, no damage
preview, no deny line, no wind-up arc. The health bars look like they do in
game, so the timing you build here is the timing you take back there.

## Fidelity notes

Values live in [`src/sim/constants.ts`](src/sim/constants.ts),
[`src/sim/units.ts`](src/sim/units.ts) and [`src/sim/heroes.ts`](src/sim/heroes.ts).

Every unit and hero number comes from Valve's own `npc_units.txt` and
`scripts/npc/heroes/*.txt`, not from memory or from a wiki summary. `npm run
check` asserts the whole table, so they cannot drift.

- Creeps use 7.3x base stats with no per-minute scaling — a drill is always minute zero, which is also the hardest timing to learn. Siege creeps come every 10th wave from 5:00, as in Dota: the 11th wave, one more than the longest drill here.
- Armor uses the real formula, `1 - 0.06a / (1 + 0.06|a|)`.
- Attack point and attack interval both scale with attack speed, and heroes carry attack speed from agility on top of their `BaseAttackSpeed`. The Swordmaster's is 110 rather than 100, so its authored 0.33s attack point is really 0.23s in lane.
- Attack points are the real ones: 0.467s for a melee creep, 0.5s for a ranged one, 0.7s for siege. The wind-up roots you; the backswing is cancellable and never delays your next swing.
- Lane creeps carry the attack-class passives from `npc_abilities.txt`. Melee creeps deal 75% to heroes (`creep_irresolute`). Ranged creeps deal 50% to heroes and 150% to creeps (`creep_piercing`), so they are what kills a wave and the softest thing in it to be hit by. Siege creeps take half damage from heroes (`creep_siege`), so a catapult needs twice the swings its health bar suggests.
- Creeps are sticky: one that is standing and swinging holds its target until it dies or leaves attack range. When it picks again, it goes by unit type first (heroes and creeps are one tier, as Valve's own glossary has it, then siege creeps, then buildings), then by threat (whatever is hitting it, then whatever is hitting its allies, then the idle), then by distance. That is why you can stand idle beside an engaged wave untouched, and why last hitting at the front of it draws hits. With nothing better in range a creep chases what it had for as long as it can: there is no leash. Siege creeps go for buildings first.
- Aggro reaches 500 from the hero, whatever the creep. An attack order on the enemy hero pulls the creeps near you for 2.3s and starts a 3s cooldown; after that, every swing you take at a hero draws them again. Clicking one of your own units hands aggro back, but only once that cooldown is up, so a pull cannot be taken back. Before 5:00 a wave with no enemy creeps near it, and far from its own tower, ignores all of this, as in Dota since 7.27.
- Attack range runs edge to edge, from the hull of the attacker to the hull of the target: a melee creep reaches a hero 140 away, and a tower 868.
- A target that dies during your wind-up costs you the swing, and the run counts those.
- Heroes level. Every death pays its experience to the enemy heroes within 1500, shared, whoever landed the blow; a denied creep pays the enemy half and the denier nothing. Levels follow Dota's table (one wave is level 2), and each adds the hero file's attribute gains. Damage is base plus the primary attribute, and HP, armor and attack speed come from attributes the same way. A level-up keeps your health fraction rather than healing, and respawn time follows your level (12s at level 1).
- Starting items are optional and come from `items.txt`: Quelling Blade, Iron Branch, Faerie Fire, Tango, Magic Stick, Slippers, Mantle, Gauntlets and Circlet, within 600 starting gold and six slots. Stat items go through the attribute rules, so Slippers speed up the swing. Quelling Blade is +8 damage for melee and +4 for ranged, against enemy creeps only — not on denies. Tangos stack into one slot, three charges a purchase, as they do in game. Tango and Magic Stick cannot be used; they are in the shop so a real opening buy fits the 600 gold. Only your hero carries items, and they show in an inventory in the HUD.
- The item icons are drawn for this project in the style of the original mod's Warcraft III buttons. They are not the game's own art.
- Tier 1 towers are present and **invulnerable on purpose**: they anchor the lane so a run cannot death-spiral, and they punish diving, but a tower falling would make every run a different game.
- Turn rate is radians per 0.03s, so a 180° turn at 0.6 takes 0.157s. You have to be facing a creep before the swing starts.

What is deliberately not here: abilities (innates, skill points and talents
included), items beyond a starting buy, fog of war, runes, neutral camps and
high ground. This is a last-hit drill, not a laning
simulator.

## Layout

```
src/sim/        headless simulation: units, combat, waves, creep and hero AI
src/render3d/   three.js stage, unit views, effects, screen-space overlay
src/ui/         menu, HUD, results
src/stats.ts    run history in localStorage
tools/          screenshot and simulation-check harnesses
```

`src/sim` imports nothing from the other folders, which is what makes the
checks possible:

```bash
npm run dev      # in one shell
npm run check    # assert the sim; exits non-zero on the first failure
npm run shot     # screenshot the menu, a formed lane and results
npm run balance  # difficulty calibration for the enemy laner
```

`npm run balance` drives both heroes with the same laning AI and holds your
side at bot profile 3. Profile 3 against profile 3 should come out even, and that is the
check that matters: a lane where one side quietly farms better would flatter
you and teach you nothing.

`npm run check` drives a real Chromium against the dev server and imports the
sim modules through vite, then asserts numbers — the reference values, swing
timing to the frame, creep targeting and aggro, contact behaviour, and a
fixed-seed replay. That is how it exists at all in a project whose only runtime
dependency is three.

## Credits

The melee and ranged creeps are from Kay Lousberg's
[KayKit Character Pack: Skeletons](https://kaylousberg.itch.io/kaykit-skeletons)
(CC0), recoloured per team by `tools/blender/build_units.py`.
