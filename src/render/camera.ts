import type { Vec2 } from '../sim/types.ts';
import { clamp, lerp } from '../sim/math.ts';

export class Camera {
  pos: Vec2 = { x: 0, y: 0 };
  scale = 0.75;

  viewW = 0;
  viewH = 0;

  /**
   * Follow with a lead toward the lane you are farming, so the wave sits in
   * frame instead of at the edge of the screen.
   */
  follow(target: Vec2, dt: number, lead = 0) {
    const t = 1 - Math.pow(0.001, dt);
    this.pos.x = lerp(this.pos.x, target.x + lead, t);
    this.pos.y = lerp(this.pos.y, target.y * 0.5, t);
  }

  snap(target: Vec2) {
    this.pos.x = target.x;
    this.pos.y = target.y * 0.5;
  }

  toScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.pos.x) * this.scale + this.viewW / 2,
      y: (p.y - this.pos.y) * this.scale + this.viewH / 2,
    };
  }

  toWorld(p: Vec2): Vec2 {
    return {
      x: (p.x - this.viewW / 2) / this.scale + this.pos.x,
      y: (p.y - this.viewH / 2) / this.scale + this.pos.y,
    };
  }

  zoom(delta: number) {
    this.scale = clamp(this.scale * (1 + delta), 0.45, 1.6);
  }
}
