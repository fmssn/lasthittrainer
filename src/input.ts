import type { GameRenderer } from './render/gameRenderer.ts';
import type { Vec2 } from './sim/types.ts';
import type { World } from './sim/world.ts';

/**
 * Dota-style controls:
 *   right click        move, or attack an enemy under the cursor
 *   A                  attack or deny whatever the cursor is over, else
 *                      attack-move there — the only way to deny your own creep
 *   S                  stop (cancels the backswing, frees the next order)
 *   scroll             zoom
 *   space              pause
 */
export class Input {
  private world: World | null = null;
  /** Cursor in canvas pixels, so a keystroke can aim at what the mouse is over. */
  private lastScreen: Vec2 = { x: 0, y: 0 };
  onPause: (() => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: GameRenderer,
  ) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  /** Swap the renderer under the same pointer surface when the mode changes. */
  setRenderer(renderer: GameRenderer) {
    this.renderer = renderer;
  }

  attach(world: World | null) {
    this.world = world;
  }

  /**
   * Whether pressing A right now would land on a unit. Drives the HUD hint, so
   * a creep crossing the deny line reads as denyable before the key is pressed.
   */
  isAttackReady(): boolean {
    const world = this.world;
    if (!world || !world.player.alive || world.finished) return false;
    const target = this.renderer.pickUnit(this.lastScreen, world, world.player);
    return target !== null && world.canTarget(world.player, target);
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
    const p = this.point(e);
    this.renderer.cursor = p;
    const world = this.world;
    this.renderer.hoverId = world ? (this.pick(e, world)?.id ?? null) : null;
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

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    this.renderer.zoom(e.deltaY > 0 ? -0.1 : 0.1);
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
    if (!world || !world.player.alive) return;

    if (key === 'a') {
      // A fires on the cursor straight away rather than arming a second click:
      // a deny window is a handful of frames wide, and the click was spending
      // them. What the cursor is over is attacked or denied, empty lane is an
      // attack-move, which is the same pair of orders A + LMB used to give.
      const target = this.renderer.pickUnit(this.lastScreen, world, world.player);
      if (target && world.canTarget(world.player, target)) {
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
