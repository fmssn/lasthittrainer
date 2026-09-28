import type { Renderer3D } from './render3d/renderer3d.ts';
import type { Vec2 } from './sim/types.ts';
import type { World } from './sim/world.ts';

/**
 * Dota-style controls:
 *   right click        move, or attack an enemy under the cursor
 *   A                  attack or deny whatever the cursor is over, else
 *                      attack-move there. The only way to deny your own creep,
 *                      and — aimed at one — the way to hand creep aggro back
 *   S                  stop (cancels the backswing, frees the next order)
 *   space              pause
 *   M                  mute
 */
export class Input {
  private world: World | null = null;
  /** Cursor in canvas pixels, so a keystroke can aim at what the mouse is over. */
  private lastScreen: Vec2 = { x: 0, y: 0 };
  onPause: (() => void) | null = null;
  onMute: (() => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: Renderer3D,
  ) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('mouseleave', () => (this.renderer.pointer = null));
    // The camera is fixed, as in Dota at its default distance, so the wheel does
    // nothing. It is still swallowed: a trackpad pinch arrives as a ctrl+wheel
    // and would otherwise zoom the whole page.
    canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  attach(world: World | null) {
    this.world = world;
    // The menu and results draw a lane behind them, which nothing should outline.
    if (!world) this.renderer.pointer = null;
  }

  private screen(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Where the order lands: the lane point under the cursor. */
  private point(e: MouseEvent) {
    return this.renderer.toWorld(this.screen(e));
  }

  /**
   * What the order is aimed at. The renderer answers this rather than the sim,
   * because on the 3D stage a unit is clickable well above the lane point its
   * cursor resolves to.
   */
  private pick(e: MouseEvent, world: World) {
    return this.renderer.pickUnit(this.screen(e), world, world.player);
  }

  private onMouseMove(e: MouseEvent) {
    this.lastScreen = this.screen(e);
    this.renderer.cursor = this.point(e);
    this.renderer.pointer = this.world ? this.lastScreen : null;
  }

  private onMouseDown(e: MouseEvent) {
    const world = this.world;
    if (!world || !world.player.alive || world.finished) return;
    const p = this.point(e);

    if (e.button === 2) {
      e.preventDefault();
      const target = this.pick(e, world);
      // Right click never attacks your own units — denying takes A, so a
      // panicked right click can never throw away your own creep.
      if (target && target.team !== world.player.team) world.orderAttack(world.player, target);
      else world.orderMove(world.player, p);
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const world = this.world;
    const key = e.key.toLowerCase();

    if (key === 'escape' || key === ' ') {
      e.preventDefault();
      this.onPause?.();
      return;
    }
    if (key === 'm') {
      this.onMute?.();
      return;
    }
    if (!world || !world.player.alive) return;

    if (key === 'a') {
      // A fires on the cursor straight away rather than arming a second click:
      // a deny window is a handful of frames wide, and the click was spending
      // them. What the cursor is over is attacked or denied, empty lane is an
      // attack-move, which is the same pair of orders A + LMB used to give.
      const target = this.renderer.pickUnit(this.lastScreen, world, world.player);
      // Ally or enemy, the order goes to orderAttack: an attack order on your
      // own creep is what hands creep aggro back, and it does that whether or
      // not the creep is low enough to actually deny. Only empty lane is an
      // attack-move.
      if (target) {
        world.orderAttack(world.player, target);
      } else {
        world.orderAttackMove(world.player, this.renderer.toWorld(this.lastScreen));
      }
    } else if (key === 's') {
      world.orderStop(world.player);
    } else if (key === 'h') {
      world.orderStop(world.player);
    }
  }
}
