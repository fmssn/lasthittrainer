import type { GameRenderer } from './render/gameRenderer.ts';
import type { World } from './sim/world.ts';

/**
 * Dota-style controls:
 *   right click        move, or attack an enemy under the cursor
 *   A + left click     attack-move, and the only way to deny your own creep
 *   S                  stop (cancels the backswing, frees the next order)
 *   scroll             zoom
 *   space              pause
 */
export class Input {
  private attackCursor = false;
  private world: World | null = null;
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
    this.attackCursor = false;
    this.canvas.classList.remove('attack-cursor');
  }

  get isAttackCursor() {
    return this.attackCursor;
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
      // Right click never attacks your own units — denying takes an A-click,
      // same as the real game.
      if (target && target.team !== world.player.team) world.orderAttack(world.player, target);
      else world.orderMove(world.player, p);
      this.setAttackCursor(false);
      return;
    }

    if (e.button === 0 && this.attackCursor) {
      const target = this.pick(e, world);
      if (target && world.canTarget(world.player, target)) world.orderAttack(world.player, target);
      else world.orderAttackMove(world.player, p);
      this.setAttackCursor(false);
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
      this.setAttackCursor(!this.attackCursor);
    } else if (key === 's') {
      world.orderStop(world.player);
      this.setAttackCursor(false);
    } else if (key === 'h') {
      world.orderStop(world.player);
    }
  }

  private setAttackCursor(on: boolean) {
    this.attackCursor = on;
    this.canvas.classList.toggle('attack-cursor', on);
  }
}
