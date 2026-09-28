# Sounds

The sounds to generate for the drill, and the prompts to generate them with.
Modelled on what Dota itself plays in lane. How the game plays them is in
the Audio section of CLAUDE.md, and the levels are in `src/audio/sounds.ts`.

The rule is the same one the renderer follows: **the drill should sound like
the game.** Dota gives you no audio cue for "this creep is killable", so none is
listed here. What it does give you is an attack sound at the moment of contact
and a coin clink on a last hit, and that is what a player's ear is trained on.

## The list

**Must have**

| File | When it plays | Var. | Length |
|---|---|---|---|
| `last_hit_gold` | You get a last hit | 1 | 0.5 s |
| `deny` | You deny one of your creeps | 1 | 0.4 s |
| `sword_swing` | Swordmaster's windup starts | 2 | 0.3 s |
| `sword_hit` | Swordmaster's blow lands | 3 | 0.4 s |
| `bow_draw` | Frost Archer's windup starts | 2 | 0.45 s |
| `bow_release` | Frost Archer's arrow leaves | 2 | 0.4 s |
| `frost_arrow_hit` | The arrow lands | 2 | 0.4 s |
| `melee_creep_hit` | A melee creep's swing lands | 3 | 0.3 s |
| `ranged_creep_cast` | A ranged creep fires | 2 | 0.4 s |
| `ranged_creep_hit` | Its bolt lands | 2 | 0.3 s |
| `creep_death` | Any creep dies | 3 | 0.8 s |

**Nice to have**

| File | When it plays | Var. | Length |
|---|---|---|---|
| `siege_launch` | The catapult fires | 1 | 0.8 s |
| `siege_hit` | Its boulder lands | 1 | 0.8 s |
| `tower_attack` | The tower fires | 1 | 0.6 s |
| `tower_hit` | The tower's bolt lands | 1 | 0.5 s |
| `hero_death` | A hero dies | 1 | 1.5 s |
| `horn` | The run starts (Dota's 0:00 horn) | 1 | 3 s |
| `lane_ambience` | Loops under the whole run | 1 | 45 s |
| `ui_click` | Menu buttons | 1 | 0.1 s |
| `run_end` | The results screen opens | 1 | 2 s |

"Length" is what the file should be after trimming, not what to generate (see
below). Name variations `melee_creep_hit_1.wav`, `_2`, `_3`.

`sword_swing` and `bow_draw` are the two sounds that start at the *beginning*
of an attack rather than at its end. Dota has them too (the `PreAttack` sound
many heroes carry), and it is how you hear that you started a swing too early.
`bow_draw` is cut to end at its loudest moment, full draw, so it hands straight
over to `bow_release` at the Frost Archer's 0.5 s attack point. Without it the
bow had no build-up at all, which read as wrong next to the sword.

The files in `public/audio/` were picked by ear from 32 takes each. Which take
of which prompt each one is, and the model settings, are in
`tools/audio/keepers.json`, so any of them can be rendered again.

**Deliberately left out:**
- **Voice lines**, such as hero responses to orders and "denied!" taunts.
  Dota has them, but they are the most repetitive part and add nothing to the
  timing.
- **Footsteps.** Ten rigs walking is noise, not information.
- **Anything Dota does not play:** a "killable now" ping, a wave-spawn chime,
  a miss sound. The same reason the overlay aids were removed.

## The model: Stable Audio 3 Medium

Researched 2026-09-26, for generating on an H100. Use **Stable Audio 3
Medium**, natively supported in ComfyUI since v0.22.0 (its templates are under
Audio in the template browser).

- **Use `stable_audio_3_medium.safetensors`, not Medium Base.** Base is the
  checkpoint before post-training and follows a one-shot prompt badly: the
  first full batch was made with it, and a single coin came back as a dozen
  clicks, a single knock as four, a sword hit as a second of noisy smear, while
  the same checkpoint made passable music. Medium gives one clean transient.
  Small-SFX was tried as well and has soft onsets, which blurs a timing cue.
- **Skip the templates.** Both SA3 templates can run your text through Qwen to
  "expand" it, which is the opposite of what a tightly written one-shot prompt
  wants, and the Base template's category picker fails validation on ComfyUI
  0.37. `tools/audio/generate.py` builds the plain graph instead: checkpoint,
  T5Gemma text encoder, KSampler, decode, save.
- It needs `t5gemma_b_b_ul2.safetensors` in `models/text_encoders/`. The
  checkpoint goes in `models/checkpoints/`. Comfy-Org's repackaged weights
  (`Comfy-Org/stable-audio-3` on Hugging Face) are not gated.
- **Licence:** Stability AI Community License. You own what it generates, and
  commercial use is free below $1M annual revenue after registering. That
  covers a public GitHub Pages build.
- It outputs **44.1 kHz stereo**, which is what the drill wants.

Medium is also the biggest option, because nothing larger is worth running:

- **SA3 Large** scores best in Stability's paper (FAD 0.358 against Medium's
  0.369, lower is better), but its weights are not released.
- **Small-SFX** is not needed on an H100. It scores lower (0.395), exists to
  run on a CPU, and its onsets came out soft.
- **HunyuanVideo-Foley XXL** is bigger (48 kHz, 20 GB), but it is built to
  score a video, not to follow a text prompt alone. Its licence also does not
  apply in the EU, the UK or South Korea.
- **Woosh** (Sony AI) is SFX-specialised, but its weights are CC-BY-NC, so
  non-commercial only. It also scores below SA3 on SA3's benchmark
  (FAD 0.58).
- **TangoFlux** and **AudioLDM** are older and score lower.
- **ElevenLabs** is a paid cloud API node. It is the last resort if one
  sound will not come out right.

What the H100 buys is not a bigger model but many more tries, plus a second
model to try them on.

### Settings

- **Steps 8, CFG 1.0, sampler `lcm`, scheduler `simple`**, as ComfyUI's own
  Medium template sets them. Medium is distilled, so its guidance is baked in,
  and more steps or higher CFG do not help. (`pingpong` is not a sampler
  ComfyUI 0.37 offers.) The whole set of 20 × 32 takes renders in about 30 s.
- **CFG 1 means a negative prompt does nothing.** Put everything you do *not*
  want into the positive prompt as what you do want: "dry, close-miked",
  never "no reverb" in a negative box.
- **Start every prompt with `TrackType: SFX,`.** SA3 was trained with that
  prefix, and Stability's paper says it significantly improves results.
- **Generate about 2 s even for a 0.3 s sound**, then trim. Very short
  requests tend to come out mushy or cut off. Exceptions: 5 s for the horn and
  `run_end`, and 60 s for the ambience.
- **Batch 32 seeds per prompt** and keep the best 2–3 as the variations.
  That costs well under a minute per prompt here, and seeds are a better use
  of the GPU than rewording: different seeds of one prompt match each other
  in tone, which is what variations should do.
- Write down the seed of every keeper in `tools/audio/keepers.json`, so it
  can be re-rendered later. A batch renders from one seed (1000), so a take is
  named by its batch index.
- **Rank before you listen.** `tools/audio/process.py` scores every take on
  shape (one onset, attack time, a tail that ends near its slot, no clipping),
  cleans the best four as described below, and leaves the choosing to the ear.

### Second opinion: Stable Audio Open 1.0

Stable Audio Open 1.0 is also native in ComfyUI. It is older, but one tester
found it richer, and it is about 50x slower, which does not matter on an H100.
Unlike SA3 it runs real classifier-free guidance, so it takes a negative
prompt. Use it for any sound where none of the 32 SA3 seeds are right, and
try it for `lane_ambience` in any case.

- Start from ComfyUI's Stable Audio Open template and raise steps to 100.
- **Drop the `TrackType: SFX,` prefix.** Open was not trained with it.
  Otherwise the prompts below work as they are.
- Negative prompt: `reverb, echo, music, melody, speech, voice, background noise, hiss, low quality, distorted`.
  Leave out `reverb, echo` for the horn, `run_end` and the ambience.
- 16 seeds per prompt is enough, since each one takes longer.
- Same licence as SA3.

### How the prompts are built

The pattern follows Stability's prompt guide: **source** (what makes the
sound), **action** (how it is triggered and how long it lasts), **character**
(timbre and recording). Every one-shot ends with the same recording
description, so the set sounds like it came from one session:

> dry close-miked studio recording, single isolated one-shot, sharp attack

Several details come from the models the lane actually shows. The creeps are
KayKit skeletons: melee creeps carry a blade and shield, ranged ones a staff
and a caster's hat. So a creep death is bones, not flesh. The heroes are an
armoured knight with a two-handed sword and an archer with a bow.

(The prompts were written for those models. The creeps have since become
sprites of Synty characters: Radiant's are a soldier with sword and shield and
a mage with a staff, Dire's an undead swordsman and a wraith. Dire's deaths
are still bones; Radiant's are not, and nobody has re-rolled them yet.)

## Prompts

Copy each block as is.

### Must have

**`last_hit_gold`**. The one sound that must always cut through. The first
prompt asked for "bright", "sparkle" and a "fantasy game reward", and every
take sounded artificial and too high; real coins in a hand sound right and
still cut through.
```
TrackType: SFX, a few heavy gold coins dropped into an open palm, natural metallic clink with a warm low-mid body, real coins, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`deny`**. Dota's deny is understated, so keep it low and dry, clearly
different from the coin.
```
TrackType: SFX, a short muted wooden knock with a dull dry click, soft and understated, low-mid body, quick decay, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`sword_swing`**
```
TrackType: SFX, a heavy two-handed sword swung fast through the air, short airy whoosh with a faint metallic edge, rising then cut off, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`sword_hit`**
```
TrackType: SFX, a heavy steel sword striking a bony armored target, sharp metallic chop with a crunchy low thud, short and punchy, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`bow_draw`**. Generated 2 s long; the draw peaks around 0.9 s, and the cut
keeps the 0.45 s that end there.
```
TrackType: SFX, a wooden longbow drawn back, creaking wood and a tightening bowstring, rising tension, stopping at full draw with no release, dry close-miked studio recording, single isolated one-shot
```

**`bow_release`**. The first prompt's thin twang with an icy shimmer had
nothing under it.
```
TrackType: SFX, a heavy longbow string released, deep thrumming twang with a sharp snap and an arrow whooshing away, full-bodied, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`frost_arrow_hit`**
```
TrackType: SFX, an arrow thudding into a target, short wooden thunk with a small crackle of ice forming, crisp and cold, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`melee_creep_hit`**. It plays constantly, so keep it duller and smaller than
`sword_hit`.
```
TrackType: SFX, a rusty short blade hacking into a wooden shield, dull clack with a small bony knock, short and light, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`ranged_creep_cast`**
```
TrackType: SFX, a small magic bolt fired from a wooden staff, soft whooshing fizz with a hollow puff, short and light, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`ranged_creep_hit`**
```
TrackType: SFX, a small magic bolt hitting a target, quick sizzling pop with a tiny crackle, short and light, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`creep_death`**
```
TrackType: SFX, a small skeleton collapsing to the ground, dry bones clattering and a light armor rattle, brief hollow rasp at the start, dry close-miked studio recording, single isolated one-shot
```

### Nice to have

**`siege_launch`**
```
TrackType: SFX, a wooden catapult arm snapping forward and hitting its stop, deep wooden thump with a rope creak, heavy and short, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`siege_hit`**
```
TrackType: SFX, a large boulder slamming into the ground and a wooden barricade, heavy low crunch with scattered debris, short tail, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`tower_attack`**
```
TrackType: SFX, an ancient stone tower firing a bolt of arcane energy, deep resonant magical launch with a low hum, short, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`tower_hit`**
```
TrackType: SFX, a heavy bolt of arcane energy striking a target, deep punchy magical impact with a short crackle, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`hero_death`**
```
TrackType: SFX, an armored warrior falling heavily to the ground, metal armor clattering and a low body thud, weapon dropping after, dry close-miked studio recording, single isolated one-shot
```

**`horn`**
```
TrackType: SFX, a single long note on a large war horn blown in the distance across an open valley, deep and brassy, natural outdoor echo, slow swell and fade
```

**`lane_ambience`**. Generate 60 s, cut 45 s from the middle, and crossfade
the ends. Avoid distinct bird calls: they will be heard looping.
```
TrackType: SFX, outdoor forest clearing ambience, gentle steady wind through trees, soft distant birdsong, rustling leaves, calm and even, no distinct events, field recording
```

**`ui_click`**
```
TrackType: SFX, a soft wooden button click, small and muted, very short, dry close-miked studio recording, single isolated one-shot, sharp attack
```

**`run_end`**
```
TrackType: SFX, a single deep war drum hit with a low gong ringing out, solemn and warm, slow natural decay, dry close-miked studio recording
```

## When a result is wrong

- **It has a reverb tail:** add "dead room" before "dry close-miked".
- **It is music, or has a melody:** move `TrackType: SFX,` to the very start
  if it is not there, and drop words like "fantasy" and "game".
- **Several hits instead of one:** put "a single" in front of the source noun
  and shorten the requested length to 1.5 s.
- **Two variations sound too alike:** try the next seed rather than rewording.
  Rewording drifts the tone away from its siblings.

## Before handing the files over

Clean up every file the same way, in Audacity or Reaper:

1. Cut the silence before the transient. A late onset shifts where the hit
   seems to land.
2. Fade out over 5–10 ms.
3. Cut below 80–100 Hz on everything except the siege, tower, horn,
   `run_end` and death sounds.
4. Normalize every one-shot to −1 dBFS peak, and `lane_ambience` to about
   −23 LUFS. The balance between them is set in code, not in the files.
5. Mix down to mono, except `lane_ambience`, which stays stereo.
6. Export 16-bit WAV into `public/audio/`: 44.1 kHz for the one-shots, and
   22.05 kHz for `lane_ambience` (about 4 MB instead of 8).

Why WAV and not a compressed format: MP3 and AAC pad the start of every file
with encoder silence, about 25 ms, which is exactly the late onset step 1
removes. They also click at a loop point. OGG avoids both, but older Safari
cannot decode it. All the one-shots together come to well under 2 MB as WAV.
