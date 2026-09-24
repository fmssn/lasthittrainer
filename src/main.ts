import './style.css';
import { World } from './sim/world.ts';
import type { DrillConfig } from './sim/config.ts';
import { Renderer } from './render/renderer.ts';
import type { GameRenderer } from './render/gameRenderer.ts';
import { Renderer3D } from './render3d/renderer3d.ts';
import { loadCreep, type CreepAsset } from './render3d/unitView.ts';
import { Input } from './input.ts';
import { Hud } from './ui/hud.ts';
import { Menu, type RenderMode } from './ui/menu.ts';
import { Results } from './ui/results.ts';

const SIM_STEP = 1 / 120;
const MAX_CATCHUP = 0.25;
/** How far ahead of the player the camera sits, in sim units. */
const CAMERA_LEAD = 240;

type State = 'menu' | 'playing' | 'paused' | 'results';

const app = document.getElementById('app') as HTMLDivElement;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;

// #game is always the pointer surface, whichever renderer is drawing: in 3D it
// simply stays transparent while the stage renders underneath it.
let renderer: GameRenderer = new Renderer(canvas);
let renderMode: RenderMode = '2d';
const input = new Input(canvas, renderer);
const hud = new Hud(overlay);

let state: State = 'menu';
let world: World | null = null;
let lastConfig: DrillConfig | null = null;
let accumulator = 0;
let lastFrame = performance.now();

const menu = new Menu(
  overlay,
  (config) => start(config),
  (mode) => void setRenderMode(mode),
);
const results = new Results(
  overlay,
  () => {
    if (lastConfig) start({ ...lastConfig, seed: (Math.random() * 0xffff) | 0 });
  },
  () => toMenu(),
);

/** The GLB is fetched once and shared by every 3D renderer instance. */
let creepAsset: Promise<CreepAsset> | null = null;

async function setRenderMode(mode: RenderMode) {
  if (mode === renderMode) return;
  let next: GameRenderer;
  if (mode === '3d') {
    try {
      next = new Renderer3D(app, canvas, await (creepAsset ??= loadCreep('/models/melee_creep.glb')));
    } catch (err) {
      // A missing or broken GLB must not cost the player their drill.
      creepAsset = null;
      menu.renderNote = `3D unavailable: ${(err as Error).message}. Staying on 2D.`;
      menu.setRenderMode('2d');
      console.error(err);
      return;
    }
  } else {
    next = new Renderer(canvas);
  }

  next.cursor = renderer.cursor;
  next.hoverId = renderer.hoverId;
  renderer.dispose();
  renderer = next;
  renderMode = mode;
  input.setRenderer(next);
  next.snap((world ?? backdrop)?.player.pos ?? { x: 0, y: 0 });
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

input.onPause = () => {
  if (state === 'playing') setPaused(true);
  else if (state === 'paused') setPaused(false);
};

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
    hud.update(world, input.isAttackCursor);
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
// Restore the renderer the player last used, once the menu exists to report a failure.
void setRenderMode(menu.renderMode);
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
