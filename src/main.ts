import './style.css';
import { World } from './sim/world.ts';
import type { DrillConfig } from './sim/config.ts';
import { Renderer3D } from './render3d/renderer3d.ts';
import { loadCreep, type CreepAsset } from './render3d/unitView.ts';
import { Input } from './input.ts';
import { Hud } from './ui/hud.ts';
import { Menu } from './ui/menu.ts';
import { Results } from './ui/results.ts';

const SIM_STEP = 1 / 120;
const MAX_CATCHUP = 0.25;
/** How far ahead of the player the camera sits, in sim units. */
const CAMERA_LEAD = 240;

type State = 'menu' | 'playing' | 'paused' | 'results';

const app = document.getElementById('app') as HTMLDivElement;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;

// Both are built by boot(), once the creep rig is in memory — there is nothing
// to draw with until then. #game is the pointer surface: the stage canvases go
// underneath it and it stays transparent on top, so input never changes hands.
let renderer: Renderer3D;
let input: Input;
const hud = new Hud(overlay);

let state: State = 'menu';
let world: World | null = null;
let lastConfig: DrillConfig | null = null;
let accumulator = 0;
let lastFrame = performance.now();

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
 * The creep rig has to be in memory before anything can be drawn, and there is
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

  let asset: CreepAsset;
  try {
    asset = await loadCreep('/models/melee_creep.glb');
  } catch (err) {
    // textContent, not innerHTML: the message comes from a loader, not from us.
    loading.querySelector('h1')!.textContent = 'Could not start';
    loading.querySelector('[data-msg]')!.textContent =
      `The creep model failed to load: ${(err as Error).message}. Reload to try again.`;
    console.error(err);
    return;
  }
  loading.remove();

  renderer = new Renderer3D(app, canvas, asset);
  input = new Input(canvas, renderer);
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
    hud.update(world, input.isAttackReady());
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
  };
}
