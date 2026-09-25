import type { Team, Unit } from '../types.ts';
import type { World } from '../world.ts';
import type { EnemyProfile } from '../config.ts';
import { DENY_THRESHOLD, aggroTriggerRange, armorMultiplier } from '../constants.ts';
import { angleTo, dist } from '../math.ts';

interface Memory {
  /** Seconds this opportunity has been visible to the bot. */
  seen: number;
  /** Rolled once per creep: this bot is going to fumble this one. */
  skip: boolean;
}

/**
 * A laning bot that contests the same creeps you do. It does not cheat: it
 * estimates creep HP at the moment its own attack would land, with an error
 * band and a reaction delay set by difficulty, and it loses swings to
 * mispredictions just like a person does.
 */
export class EnemyHeroAi {
  private memory = new Map<number, Memory>();
  private harassCooldown = 0;
  private retreating = false;
  private hero: Unit;
  private profile: EnemyProfile;
  private own: Team;
  private foe: Team;
  /** +1 when this hero pushes toward increasing x, -1 the other way. */
  private dir: number;

  constructor(hero: Unit, profile: EnemyProfile) {
    this.hero = hero;
    this.profile = profile;
    this.own = hero.team;
    this.foe = hero.team === 'radiant' ? 'dire' : 'radiant';
    this.dir = hero.team === 'radiant' ? 1 : -1;
  }

  update(world: World, dt: number) {
    this.harassCooldown -= dt;
    this.prune(world);

    // Back off while creeps are actually chewing on it, not on a flat HP rule —
    // a bot that sits in the fountain waiting to heal is no sparring partner.
    const frac = this.hero.hp / this.hero.maxHp;
    let threat = 0;
    for (const u of world.units.values()) {
      if (u.alive && u.team !== this.own && u.attackTargetId === this.hero.id) threat++;
    }
    if (frac < 0.25 || (threat >= 2 && frac < 0.6)) this.retreating = true;
    else if (threat === 0 && frac > 0.4) this.retreating = false;
    if (this.retreating) {
      world.orderMove(this.hero, { x: this.hero.pos.x - this.dir * 400, y: this.hero.pos.y });
      return;
    }

    const kill = this.bestOpportunity(world, dt, this.foe);
    const deny = this.profile.denies ? this.bestOpportunity(world, dt, this.own) : null;

    // Denies are worth less than gold, so a kill wins a tie.
    const target = kill ?? deny;

    if (target) {
      if (world.inAttackRange(this.hero, target)) {
        if (this.hero.attackTargetId !== target.id) world.orderAttack(this.hero, target);
      } else {
        this.approach(world, target);
      }
      return;
    }

    if (this.tryHarass(world)) return;
    this.hold(world);
  }

  /** Find the creep this bot thinks it can finish with the swing it starts now. */
  private bestOpportunity(world: World, dt: number, team: Team): Unit | null {
    let best: Unit | null = null;
    let bestHp = Infinity;

    for (const u of world.units.values()) {
      if (!u.alive || u.kind === 'hero' || u.kind === 'tower' || u.team !== team) continue;
      if (team === this.own && u.hp > u.maxHp * DENY_THRESHOLD) continue;

      const mem = this.remember(u.id, world);
      const damage = this.estimatedDamage(u);
      const hp = this.projectedHp(world, u);

      if (hp <= 0 || hp > damage) {
        mem.seen = 0;
        continue;
      }
      mem.seen += dt;
      if (mem.seen < this.profile.reaction) continue;
      if (mem.skip) continue;

      if (hp < bestHp) {
        bestHp = hp;
        best = u;
      }
    }
    return best;
  }

  /** HP the creep should have when this bot's attack actually lands. */
  private projectedHp(world: World, creep: Unit): number {
    return world.hpAtLanding(this.hero, creep);
  }

  private estimatedDamage(creep: Unit): number {
    const avg = ((this.hero.damageMin + this.hero.damageMax) / 2) * armorMultiplier(creep.armor);
    // A weaker bot both over- and under-estimates; the error is signed per creep.
    const mem = this.memory.get(creep.id);
    const bias = mem ? (mem.skip ? -1 : 1) : 1;
    return avg * (1 + bias * this.profile.estimateError * 0.5);
  }

  private remember(id: number, world: World): Memory {
    let m = this.memory.get(id);
    if (!m) {
      m = { seen: 0, skip: world.rng() < this.profile.missChance };
      this.memory.set(id, m);
    }
    return m;
  }

  private prune(world: World) {
    for (const id of this.memory.keys()) {
      if (!world.units.has(id)) this.memory.delete(id);
    }
  }

  /** Walk to just inside attack range without diving into the wave. */
  private approach(world: World, target: Unit) {
    const a = angleTo(target.pos, this.hero.pos);
    const stand = this.hero.attackRange + target.radius - 40;
    world.orderMove(this.hero, {
      x: target.pos.x + Math.cos(a) * stand,
      y: target.pos.y + Math.sin(a) * stand,
    });
  }

  /**
   * Right-click the player when it is cheap. This is what teaches you to
   * respect the enemy hero instead of parking on top of the wave.
   */
  private tryHarass(world: World): boolean {
    if (this.harassCooldown > 0) return false;
    const player = this.own === 'dire' ? world.player : world.enemy;
    if (!player || !player.alive) return false;
    if (!world.inAttackRange(this.hero, player)) return false;
    if (world.rng() > this.profile.harass) {
      this.harassCooldown = 1.5;
      return false;
    }
    // Harassing pulls their creeps onto you. Only do it when that is survivable.
    let nearby = 0;
    for (const u of world.units.values()) {
      if (!u.alive || u.kind !== 'melee_creep' || u.team === this.own) continue;
      if (dist(u.pos, this.hero.pos) <= aggroTriggerRange(u.kind)) nearby++;
    }
    if (nearby >= 2) {
      this.harassCooldown = 2;
      return false;
    }
    world.orderAttack(this.hero, player);
    this.harassCooldown = 2.5;
    return true;
  }

  /** Sit behind its own wave, ready for the next creep to drop. */
  private hold(world: World) {
    let front = this.hero.pos.x;
    let found = false;
    for (const u of world.units.values()) {
      if (!u.alive || u.kind === 'hero' || u.kind === 'tower' || u.team !== this.own) continue;
      if (!found || u.pos.x * this.dir > front * this.dir) {
        front = u.pos.x;
        found = true;
      }
    }
    // Stand behind your own front creep, close enough that the enemy wave sits
    // inside attack range without walking into it.
    const desired = found ? front - this.dir * Math.max(140, this.hero.attackRange * 0.45) : this.hero.pos.x;
    if (Math.abs(this.hero.pos.x - desired) > 60) {
      world.orderMove(this.hero, { x: desired, y: this.hero.pos.y * 0.6 });
    } else if (dist(this.hero.pos, this.hero.moveTarget ?? this.hero.pos) < 10) {
      this.hero.moveTarget = null;
    }
  }
}
