import './style.css';
import { World } from './sim/world.ts';
import type { DrillConfig } from './sim/config.ts';
import { Renderer3D } from './render3d/renderer3d.ts';
import { loadUnitAssets, type UnitAssets } from './render3d/unitView.ts';
import { Input } from './input.ts';
import { Hud } from './ui/hud.ts';
import { Menu } from './ui/menu.ts';
import { Results } from './ui/results.ts';
import { Mixer } from './audio/mixer.ts';
import { LaneAudio } from './audio/laneAudio.ts';

/**
 * Where a file under public/ comes from.
 *
 * The single-file build (`npm run pack`) has nowhere to fetch a file from — the
 * whole app is one HTML document, and the strict CSP it is published under
 * blocks the request anyway — so it injects every GLB and sound as a `data:`
 * URL on this global, keyed by its path under public/. The loaders already know
 * to parse a data: URL rather than fetch one, which is the only reason that
 * path exists.
 */
const INLINED = (window as unknown as { __LHT_MODELS__?: Record<string, string> }).__LHT_MODELS__;
const modelUrl = (path: string) => INLINED?.[path] ?? `${import.meta.env.BASE_URL}${path}`;

// Sound is not a startup dependency: it loads beside the models and a file
// that fails only leaves its sound silent.
const mixer = new Mixer(modelUrl);
void mixer.load();

const SIM_STEP = 1 / 120;
const MAX_CATCHUP = 0.25;
/** How far ahead of the player the camera sits, in sim units. */
const CAMERA_LEAD = 240;

type State = 'menu' | 'playing' | 'paused' | 'results';

const app = document.getElementById('app') as HTMLDivElement;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;

// Both are built by boot(), once the unit models are in memory — there is nothing
// to draw with until then. #game is the pointer surface: the stage canvases go
// underneath it and it stays transparent on top, so input never changes hands.
let renderer: Renderer3D;
let input: Input;
let laneAudio: LaneAudio;
const hud = new Hud(overlay);

let state: State = 'menu';
let world: World | null = null;
let lastConfig: DrillConfig | null = null;
let accumulator = 0;
let lastFrame = performance.now();

// Every button on the overlay clicks, menu, pause and results alike. A click is
// also the user gesture browsers want before they let audio start at all.
overlay.addEventListener(
  'click',
  (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('button')) return;
    mixer.resume();
    mixer.play('ui_click');
  },
  true,
);

const menu = new Menu(overlay, (config) => start(config));
const results = new Results(
  overlay,
  () => {
    if (lastConfig) start({ ...lastConfig, seed: (Math.random() * 0xffff) | 0 });
  },
  () => toMenu(),
);

/**
 * Bring up the renderer, then the menu.
 *
 * The unit models have to be in memory before anything can be drawn, and there is
 * no second renderer to fall back to any more, so a failure here is fatal and
 * says so on screen rather than leaving a black canvas and a dead Start button.
 */
async function boot() {
  const loading = document.createElement('div');
  loading.className = 'screen loading';
  loading.innerHTML = `
    <div class="loading-inner">
      <h1>Last Hit Trainer</h1>
      <p data-msg>Loading the lane\u2026</p>
    </div>`;
  overlay.appendChild(loading);

  let assets: UnitAssets;
  try {
    assets = await loadUnitAssets(modelUrl);
  } catch (err) {
    // textContent, not innerHTML: the message comes from a loader, not from us.
    loading.querySelector('h1')!.textContent = 'Could not start';
    loading.querySelector('[data-msg]')!.textContent =
      `The unit models failed to load: ${(err as Error).message}. Reload to try again.`;
    console.error(err);
    return;
  }
  loading.remove();

  renderer = new Renderer3D(app, canvas, assets);
  input = new Input(canvas, renderer);
  laneAudio = new LaneAudio(mixer, (p) => {
    const s = renderer.toScreen(p, 50);
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    return { x: (s.x / w) * 2 - 1, onScreen: s.x >= 0 && s.x <= w && s.y >= 0 && s.y <= h };
  });
  input.onPause = () => {
    if (state === 'playing') setPaused(true);
    else if (state === 'paused') setPaused(false);
  };

  menu.show();
  requestAnimationFrame(frame);
}

const pauseScreen = document.createElement('div');
pauseScreen.className = 'screen pause';
pauseScreen.hidden = true;
pauseScreen.innerHTML = `
  <div class="pause-inner">
    <h1>Paused</h1>
    <div class="actions">
      <button class="start" data-resume>Resume</button>
      <button class="ghost" data-end>End drill</button>
      <button class="ghost" data-quit>Back to menu</button>
    </div>
  </div>`;
overlay.appendChild(pauseScreen);
pauseScreen.querySelector('[data-resume]')?.addEventListener('click', () => setPaused(false));
pauseScreen.querySelector('[data-end]')?.addEventListener('click', () => finish());
pauseScreen.querySelector('[data-quit]')?.addEventListener('click', () => toMenu());

// A backgrounded tab throttles requestAnimationFrame, which would otherwise
// turn the drill into slow motion instead of stopping it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'playing') setPaused(true);
});

function start(config: DrillConfig) {
  lastConfig = config;
  world = new World(config);
  renderer.snap(world.player.pos);
  renderer.cursor = { ...world.player.pos };
  input.attach(world);
  mixer.resume();
  laneAudio.reset(world);
  menu.hide();
  results.hide();
  pauseScreen.hidden = true;
  hud.show();
  accumulator = 0;
  lastFrame = performance.now();
  state = 'playing';
}

function setPaused(paused: boolean) {
  if (state !== 'playing' && state !== 'paused') return;
  state = paused ? 'paused' : 'playing';
  pauseScreen.hidden = !paused;
  lastFrame = performance.now();
}

function finish() {
  if (!world || !lastConfig) return;
  pauseScreen.hidden = true;
  hud.hide();
  input.attach(null);
  results.show(lastConfig, world.stats);
  state = 'results';
}

function toMenu() {
  world = null;
  mixer.stop();
  input.attach(null);
  hud.hide();
  results.hide();
  pauseScreen.hidden = true;
  menu.show();
  state = 'menu';
}

function frame(now: number) {
  const elapsed = Math.min((now - lastFrame) / 1000, MAX_CATCHUP);
  lastFrame = now;

  if (state === 'playing' && world) {
    accumulator += elapsed;
    while (accumulator >= SIM_STEP) {
      world.step(SIM_STEP);
      accumulator -= SIM_STEP;
    }
    // Lead the camera toward the enemy side; that is where the creeps you are
    // farming always are.
    renderer.follow(world.player.pos, elapsed, CAMERA_LEAD);
    laneAudio.update(world);
    hud.update(world);
    if (world.finished) finish();
  }

  // Paused means frozen, animations included; the menu backdrop still breathes.
  const dt = state === 'paused' ? 0 : elapsed;
  if (world) renderer.draw(world, dt);
  else renderer.draw(emptyWorld(), dt);

  requestAnimationFrame(frame);
}

/** The menu still wants a lane behind it; a frozen throwaway world does the job. */
let backdrop: World | null = null;
function emptyWorld(): World {
  if (!backdrop) {
    backdrop = new World({ ...menu.config, enemyHero: false, duration: 1e9, seed: 1234 });
    for (let i = 0; i < 240; i++) backdrop.step(SIM_STEP);
    renderer.snap(backdrop.player.pos);
  }
  return backdrop;
}

hud.hide();
menu.hide();
void boot();

if (import.meta.env.DEV) {
  // Handle for poking at a live drill from the console.
  (window as unknown as Record<string, unknown>).__lht = {
    get world() {
      return world;
    },
    start,
    finish,
    /** Draw-call and triangle budget, for the perf sanity check in tools/. */
    renderStats: () => renderer.stats(),
    /** Screen position of a sim point, so a harness can click on a unit. */
    toScreen: (p: { x: number; y: number }, up = 0) => renderer.toScreen(p, up),
    /** Plays requested per sound, audible or not, for the audio checks in tools/. */
    audioStats: () => ({ ...mixer.counts }),
  };
}
