import { World } from './sim/world.ts';
import { DEFAULT_CONFIG } from './sim/config.ts';
import { Renderer3D } from './render3d/renderer3d.ts';
import { loadAssets } from './render3d/assets.ts';

/**
 * 3D debug page.
 *
 * The same stage the game draws with, plus instrumentation: an unattended sim,
 * a clip histogram and a free-look camera, which is how you check that all
 * four clips actually fire.
 *
 * Open http://localhost:5173/slice3d.html
 */

const SIM_STEP = 1 / 120;
const MAX_CATCHUP = 0.25;

const app = document.getElementById('app') as HTMLDivElement;
// The readout doubles as the DOM anchor: the stage canvases go in front of it.
const info = document.getElementById('info') as HTMLDivElement;

const world = new World({ ...DEFAULT_CONFIG, waves: Infinity });

loadAssets((path) => `/${path}`)
  .then((assets) => start(new Renderer3D(app, info, assets)))
  .catch((err) => {
    info.textContent = `Failed to load the sprites: ${err.message}`;
    console.error(err);
  });

function start(renderer: Renderer3D) {
  let orbit = false;
  addEventListener('keydown', (e) => {
    if (e.key === 'o' || e.key === 'O') {
      orbit = !orbit;
      renderer.toggleOrbit(orbit);
    }
  });
  addEventListener('wheel', (e) => renderer.zoom(wheelNotches(e)), { passive: true });

  let last = performance.now();
  let accumulator = 0;
  let fpsAccum = 0;
  let frames = 0;

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, MAX_CATCHUP);
    last = now;

    accumulator += dt;
    while (accumulator >= SIM_STEP) {
      world.step(SIM_STEP);
      accumulator -= SIM_STEP;
    }

    renderer.follow(world.player.pos, dt);
    renderer.draw(world, dt);

    frames++;
    fpsAccum += dt;
    if (fpsAccum >= 0.5) {
      const alive = world.aliveUnits().length;
      // Histogram of what each rig is playing: the quickest way to see that all
      // four clips actually fire, rather than assuming the state machine works.
      const hist = renderer.clipHistogram();
      const clips = (['Idle', 'Walk', 'Attack', 'Death'] as const)
        .map((c) => `${c} ${hist[c] ?? 0}`)
        .join('  ');
      info.textContent =
        `${Math.round(frames / fpsAccum)} fps · ${renderer.rigCount} rigs · ${alive} alive · ` +
        `t=${world.time.toFixed(0)}s\n${clips}\n` +
        `[O] orbit ${orbit ? 'on' : 'off'} · wheel to zoom`;
      frames = 0;
      fpsAccum = 0;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    // Handle for poking at the rigs from the console.
    (window as unknown as Record<string, unknown>).__lht3d = { world, renderer };
  }
}

/**
 * A wheel event as mouse-wheel notches, positive for zooming out.
 *
 * Counting events instead, as this used to, is right for a mouse and wrong for
 * a trackpad: a two-finger swipe or a pinch arrives as dozens of small events,
 * and each of them zoomed a full notch, so one gesture ran the whole range. A
 * notch is 100 px in Chromium and 3 lines in Firefox's line mode. One event
 * never counts for more than a notch, so an accelerated wheel cannot jump the
 * range in a single tick either.
 */
export function wheelNotches(e: WheelEvent): number {
  const notches =
    e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? e.deltaY / 3
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? e.deltaY
        : e.deltaY / 100;
  return Math.max(-1, Math.min(1, notches));
}
