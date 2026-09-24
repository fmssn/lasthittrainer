import './style.css';
import { World } from './sim/world.ts';
import type { DrillConfig } from './sim/config.ts';
import { Renderer } from './render/renderer.ts';
import { Input } from './input.ts';
import { Hud } from './ui/hud.ts';
import { Menu } from './ui/menu.ts';
import { Results } from './ui/results.ts';

const SIM_STEP = 1 / 120;
const MAX_CATCHUP = 0.25;

type State = 'menu' | 'playing' | 'paused' | 'results';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;

const renderer = new Renderer(canvas);
const input = new Input(canvas, renderer);
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

input.onPause = () => {
  if (state === 'playing') setPaused(true);
  else if (state === 'paused') setPaused(false);
};

function start(config: DrillConfig) {
  lastConfig = config;
  world = new World(config);
  renderer.camera.snap(world.player.pos);
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
    renderer.camera.follow(world.player.pos, elapsed);
    hud.update(world, input.isAttackCursor);
    if (world.finished) finish();
  }

  if (world) renderer.draw(world);
  else renderer.draw(emptyWorld());

  requestAnimationFrame(frame);
}

/** The menu still wants a lane behind it; a frozen throwaway world does the job. */
let backdrop: World | null = null;
function emptyWorld(): World {
  if (!backdrop) {
    backdrop = new World({ ...menu.config, enemyHero: false, duration: 1e9, seed: 1234 });
    for (let i = 0; i < 240; i++) backdrop.step(SIM_STEP);
    renderer.camera.snap(backdrop.player.pos);
  }
  return backdrop;
}

hud.hide();
requestAnimationFrame(frame);

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
