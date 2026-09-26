# Plan: lane audio

Working plan for wiring the sounds in `docs/sounds.md` into the drill. The
files are in `public/audio/`, one take per sound, picked by ear. One commit per
phase. Remove this file in the last phase once CLAUDE.md covers it.

## Decisions

- **Render side only.** `src/sim/` stays silent and imports nothing new. Audio
  reads `World` the way `effects.ts` does, following `damageLog` by `seq`, and
  never mutates it. Its random pitch and gain jitter uses `Math.random()`,
  which is fine outside the sim and must never touch `world.rng`.
- **Plain Web Audio, no dependency.** An `AudioContext`, one
  `AudioBufferSourceNode` per playback, and gain nodes as mix groups. Howler
  and similar libraries would be the second dependency next to three, and
  they would buy nothing this needs.
- **WAV files, decoded up front** with `decodeAudioData`. There is no
  streaming, since the whole set is a few MB.
- **Audio is not a startup dependency**, unlike the models. A missing or
  undecodable file logs one warning and that sound stays silent. A drill
  without a coin clink is worse, but a drill that refuses to start over one is
  worse still.
- **Silent behind the menu.** The menu's backdrop lane (`main.ts`) runs a real
  `World`, and it must not play combat sounds. Only `ui_click` plays in the
  menu. Ambience starts with the run.

## The sim change

This is the only sim change, and it is needed first. `DamageEvent` carries
`sourceKind` and `sourceTeam` but not *who* hit, so a Swordmaster blow from
you cannot be told from one by the bot, and the renderer cannot tell which
hero is swinging.

- Add `sourceId: number` to `DamageEvent` (`types.ts`) and fill it in the one
  place that pushes to `damageLog` (`world.ts`). It is simulation output, the
  same as the rest of the event.
- Then every combat sound comes from a lethal or non-lethal `DamageEvent`:
  - a lethal hit by the player on an enemy creep plays `last_hit_gold`;
  - a lethal hit by the player on their own creep plays `deny`;
  - any lethal hit on a creep plays `creep_death`.

  `killLog` is not needed. It has no `seq` and no position, and the lethal
  damage event already has both.
- Add one `npm run check` assertion: `sourceId` names the unit that swung.

## Where each sound comes from

| Sound | Detected by |
|---|---|
| hit sounds (`*_hit`) | new `DamageEvent`s: `sourceKind`, `ranged`, and `units.get(sourceId).name` for which hero |
| `last_hit_gold`, `deny`, `creep_death` | lethal `DamageEvent`, as above |
| `hero_death` | lethal `DamageEvent` whose target is a hero |
| `bow_release`, `ranged_creep_cast`, `siege_launch`, `tower_attack` | a projectile id in `world.projectiles` not seen last frame, with the source looked up by `sourceId` |
| `sword_swing`, `bow_draw` | a hero's `phase` going from `idle` to `windup` since last frame |
| `horn`, `run_end`, `ui_click`, `lane_ambience` | `main.ts` state changes and DOM clicks |

`sword_swing` and `bow_draw` are stopped if the windup ends without a hit or a
release, such as a move or stop order mid-windup. A swish for a swing that
never landed would teach the wrong rhythm. `bow_draw` is 0.45 s long and peaks
at its end, full draw, so it starts that far into the file that its end lands
on the release: an offset of 0.45 s minus the effective attack point, never
below zero. Attack speed shortens the windup, and the draw still peaks on the
release instead of being cut off before it.

The siege creep's attack has to be checked while wiring it up: if its boulder
is a sim projectile it goes through the projectile row, and otherwise through
its attack phase, like `sword_swing`.

## Code layout

```
src/audio/
  sounds.ts     The manifest: per sound its files, group, gain in dB, voice cap,
                and whether it is positional. The mix lives here and nowhere else.
  mixer.ts      AudioContext, groups, limiter, loading, play(name, {pan, gainDb}).
                Knows nothing about World.
  laneAudio.ts  Reads World each frame and calls the mixer. The only file that
                knows what a DamageEvent is.
```

`main.ts` owns one `Mixer` and one `LaneAudio`, and it calls
`laneAudio.update(world)` next to `renderer.draw`, only while the state is
`playing`. The screen position used for panning comes from
`renderer.toScreen`, which already exists.

## The mix

The signal path: every sound goes into one gain node per group (own hero,
lane, rewards, ambience, UI), then into a master gain, then into a
`DynamicsCompressorNode` set up as a limiter (threshold −6 dB, ratio 20,
attack 1 ms, release 100 ms), then to the output.

Starting levels, with the coin as the reference. These are starting values to
tune by ear, and they live in `sounds.ts`:

| Group | Sounds | Level |
|---|---|---|
| rewards | `last_hit_gold`, `deny` | 0 dB |
| own hero | the player's swing, hit, release | −4 dB |
| lane | the bot hero's attack sounds | −8 dB |
| lane | tower, siege | −8 dB |
| lane | creep hits and casts | −10 dB |
| lane | `creep_death` | −12 dB |
| lane | `hero_death` | −6 dB |
| UI | `ui_click`, `horn`, `run_end` | −8 dB |
| ambience | `lane_ambience` | −24 dB |

If the lane is muddy, turn the lane group down, never the rewards up.

What keeps a busy lane clean:

- **Voice caps.** At most 4 copies of each lane sound at once. A new copy
  steals the oldest one, with a 5 ms fade so the steal does not click. There
  is no cap on the rewards or the own-hero group.
- **Same-frame merge.** Several creep hits landing in one frame play as one
  copy, +2 dB louder. In a wave collision that is the common case, and three
  identical transients in the same millisecond only phase against each other.
- **Variation.** Each play picks a random variation (never the one it picked
  last time), shifts pitch by ±4% through `playbackRate`, and shifts the gain
  by ±1.5 dB.
- **Position.** Lane sounds pan with a `StereoPannerNode` from the unit's
  screen x, clamped to ±0.6. They drop by up to 6 dB with distance from the
  player's hero, and anything off-screen gets a further −6 dB. Own-hero
  sounds and the rewards stay centred at full level. No HRTF `PannerNode`:
  a fixed top-down camera gains nothing from it.
- **Ducking:** `lane_ambience` dips 3 dB for 400 ms on `last_hit_gold`.
  Nothing else ducks, since Dota does not.

## Lifecycle

- Create the `AudioContext` on load and `resume()` it on the menu's Start
  click. Browsers keep audio blocked until a user gesture.
- `suspend()` on pause, and on a hidden tab (the same place `main.ts` already
  handles throttling), then `resume()` on return. A pending sound must not
  play over the pause screen.
- On `finish()`, fade the ambience out over 1 s and play `run_end`. On
  `toMenu()`, stop everything.
- Latency: a sound is started the frame its event is seen, with
  `start(ctx.currentTime)`. Frame quantisation plus `ctx.baseLatency` comes to
  about 10–30 ms. That is inside what reads as "on the hit", and it is not
  compensated for.

## Settings

The menu gets three sliders: master, lane/effects, ambience. They go in
`localStorage` under `lht.audio.v1`, which is a per-player convenience, wrapped
in try/catch like the run history. The M key mutes all sound. Mute and the
sliders act on the mixer's gains only, so they can never change what the sim
does.

## Phases

1. **Sim field.** Add `DamageEvent.sourceId` and its check. Run
   `npm run build`, `npm run check` and `npm run balance`. The balance reading
   must not move, since nothing reads the field yet.
2. **Mixer and manifest.** `mixer.ts` and `sounds.ts` with loading, groups,
   the limiter and the missing-file warning. Wire `ui_click` only, so the path
   can be heard end to end.
3. **Lane events.** `laneAudio.ts`: hits, launches, deaths, rewards, the
   windup swish. Add caps, merge, jitter and pan.
4. **Run lifecycle.** Horn, ambience, pause and suspend, `run_end`, the volume
   sliders and mute.
5. **Tuning with the user.** I cannot listen. The user plays a 3-minute run
   on laptop speakers and on headphones, and says what to change. The two
   acceptance tests: every last hit is audible without watching the screen,
   and a creep's hits on the target can be told apart from the rest of the
   lane. Changes go in `sounds.ts` only.
6. **Docs.** Add `src/audio/` to the CLAUDE.md architecture, a line in
   Rendering on "audio is render-side and follows damageLog", and the audio
   files to the startup section as *optional*. Then delete this plan.

## Verification

- `npm run build` and `npm run check` on every phase, as always.
- `__lht.audioStats()` returns a count of plays per sound. It goes in
  `main.ts` next to `renderStats`. `simcheck.mjs` runs its page part with
  `--autoplay-policy=no-user-gesture-required` and asserts:
  - after 14 s of lane, the creep hit sounds have played;
  - `last_hit_gold` has played exactly as many times as `stats.lastHits`, and
    `deny` as many times as `stats.denies`;
  - no lane sound played while the menu backdrop was running.

  This is the audio counterpart of the right-click check: it proves the
  events are wired, and nothing but a person proves the mix.
- `npm run shot` is unaffected. Audio adds nothing to the frame.

## Known risks

- **Generated one-shots may have a soft or smeared onset**, which blurs the
  timing cue. `docs/sounds.md` covers trimming. If a hit sound still reads
  late, the fix is a new generation, not an offset in code.
- **Headless Chromium may refuse an `AudioContext`** even with the flag. The
  fallback is to assert on the event counter that feeds the mixer rather than
  on real playback.
