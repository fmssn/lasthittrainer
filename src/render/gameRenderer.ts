import type { Unit, Vec2 } from '../sim/types.ts';
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

  /**
   * Camera: snap on start, follow every frame. `lead` pushes the view ahead of
   * the target along the lane, so the wave sits in frame rather than at the edge.
   */
  snap(target: Vec2): void;
  follow(target: Vec2, dt: number, lead?: number): void;

  /** Screen pixels to sim units, on the lane plane. */
  toWorld(screen: Vec2): Vec2;
  /**
   * Unit under the cursor, or null. Picking belongs to the renderer because
   * only it knows how a unit is drawn: the 2D painter can test the lane plane
   * the cursor already resolves to, but on the 3D stage a click on a creep's
   * chest lands well behind its feet once projected down to y=0, so the rig's
   * full height has to be tested instead.
   */
  pickUnit(screen: Vec2, world: World, forUnit: Unit): Unit | null;
  /** Positive zooms in, matching the 2D camera's sign. */
  zoom(delta: number): void;

  /** Drop listeners and GPU resources; the renderer is not reused after this. */
  dispose(): void;
}
