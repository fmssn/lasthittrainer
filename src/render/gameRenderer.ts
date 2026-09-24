import type { Vec2 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';

/**
 * Everything main.ts and input.ts are allowed to know about a renderer.
 *
 * Both the 2D canvas painter and the three.js stage implement this, so the
 * drill can switch renderer at runtime without either of them growing a branch.
 * Screen points are CSS pixels relative to the canvas; world points are sim units.
 */
export interface GameRenderer {
  /** World-space cursor, written by input, drawn by the renderer. */
  cursor: Vec2;
  hoverId: number | null;

  /** One frame. `dt` is real seconds since the last draw — 0 while paused. */
  draw(world: World, dt: number): void;

  /** Camera: snap on start, follow every frame. */
  snap(target: Vec2): void;
  follow(target: Vec2, dt: number): void;

  /** Screen pixels to sim units. */
  toWorld(screen: Vec2): Vec2;
  /** Positive zooms in, matching the 2D camera's sign. */
  zoom(delta: number): void;

  /** Drop listeners and GPU resources; the renderer is not reused after this. */
  dispose(): void;
}
