import type { FloatingText, KillEvent, Projectile, Team, Unit, Vec2 } from './types.ts';
import {
  AGGRO_COOLDOWN,
  AGGRO_DURATION,
  DENY_THRESHOLD,
  LANE_HALF_WIDTH,
  LEASH_RANGE,
  MELEE_CREEP_HERO_DAMAGE_PENALTY,
  SIEGE_EVERY_N_WAVES,
  WAVE_INTERVAL,
  acquisitionRange,
  armorMultiplier,
  attackBackswingTime,
  attackInterval,
  attackPointTime,
  turnSpeed,
} from './constants.ts';
import { MELEE_CREEP, RANGED_CREEP, SIEGE_CREEP, TOWER, resetIds, rollDamage, spawnUnit } from './units.ts';
import { heroById } from './heroes.ts';
import { angleDelta, angleTo, clamp, dist, makeRng } from './math.ts';
import type { DrillConfig } from './config.ts';
import { ENEMY_PROFILES } from './config.ts';
import { runCreepAi } from './ai/creepAi.ts';
import { EnemyHeroAi } from './ai/enemyHeroAi.ts';

export const RADIANT_SPAWN = 400;
export const DIRE_SPAWN = 5600;
export const LANE_CENTER = (RADIANT_SPAWN + DIRE_SPAWN) / 2;
export const HERO_RESPAWN_TIME = 6;
export const RADIANT_TOWER_X = 1700;

/**
 * Phase timers are counted down by repeated subtraction of the fixed step, and
 * 30 subtractions of 1/120 land a few times 10^-17 above zero rather than on
 * it. Without a tolerance that residue costs an extra frame on every single
 * swing, which is exactly the kind of error this app is supposed to not have.
 */
const TIMER_EPSILON = 1e-9;
export const DIRE_TOWER_X = 4300;

export interface Stats {
  lastHits: number;
  denies: number;
  enemyLastHits: number;
  enemyDenies: number;
  /** Enemy creeps that died without you getting the gold. */
  missed: number;
  /** Your creeps that died undenied. */
  conceded: number;
  gold: number;
  deaths: number;
  /** Swings that landed on a creep that was already dead or full — pure overkill clicks. */
  wastedSwings: number;
}

export class World {
  readonly config: DrillConfig;
  readonly rng: () => number;

  units = new Map<number, Unit>();
  projectiles: Projectile[] = [];
  floaters: FloatingText[] = [];
  killLog: KillEvent[] = [];

  player!: Unit;
  enemy: Unit | null = null;

  time = 0;
  waveTimer = 0;
  waveCount = 0;
  finished = false;

  playerRespawnTimer = 0;

  stats: Stats = {
    lastHits: 0,
    denies: 0,
    enemyLastHits: 0,
    enemyDenies: 0,
    missed: 0,
    conceded: 0,
    gold: 0,
    deaths: 0,
    wastedSwings: 0,
  };

  private nextProjectileId = 1;
  private enemyAi: EnemyHeroAi | null = null;

  constructor(config: DrillConfig) {
    this.config = config;
    this.rng = makeRng(config.seed);
    resetIds();

    const heroTpl = heroById(config.heroId);
    this.player = spawnUnit(heroTpl, 'radiant', { x: LANE_CENTER - 480, y: 0 }, this.rng);
    this.units.set(this.player.id, this.player);

    if (config.enemyHero) {
      const enemyTpl = heroById(config.enemyHeroId);
      this.enemy = spawnUnit(enemyTpl, 'dire', { x: LANE_CENTER + 480, y: 0 }, this.rng);
      this.units.set(this.enemy.id, this.enemy);
      this.enemyAi = new EnemyHeroAi(this.enemy, ENEMY_PROFILES[config.enemyDifficulty]);
    }

    for (const [team, x] of [['radiant', RADIANT_TOWER_X] as const, ['dire', DIRE_TOWER_X] as const]) {
      const tower = spawnUnit(TOWER, team, { x, y: -260 }, this.rng);
      this.units.set(tower.id, tower);
    }

    // Seed the lane so the drill starts in combat instead of with a 10 second walk.
    this.spawnWave(LANE_CENTER - 150, LANE_CENTER + 150);
    this.waveTimer = WAVE_INTERVAL;
  }

  // ---------------------------------------------------------------- queries

  get(id: number | null): Unit | null {
    if (id == null) return null;
    const u = this.units.get(id);
    return u && u.alive ? u : null;
  }

  aliveUnits(): Unit[] {
    const out: Unit[] = [];
    for (const u of this.units.values()) if (u.alive) out.push(u);
    return out;
  }

  /** Average damage this unit deals to that target, after armor and modifiers. */
  expectedDamage(source: Unit, target: Unit): number {
    const avg = (source.damageMin + source.damageMax) / 2;
    return this.applyModifiers(source, target, avg);
  }

  /**
   * Armor, plus every flat multiplier that sits between a rolled attack and the
   * health bar. Today that is just `creep_irresolute`: melee lane creeps deal
   * 25% less to heroes. It lives in one place so the damage preview, the bot's
   * estimate and the actual hit can never disagree.
   */
  private applyModifiers(source: Unit, target: Unit, raw: number): number {
    let dmg = raw * armorMultiplier(target.armor);
    if (source.kind === 'melee_creep' && target.kind === 'hero') {
      dmg *= 1 - MELEE_CREEP_HERO_DAMAGE_PENALTY;
    }
    return dmg;
  }

  /** How long until a swing started now would land on `target`. */
  timeToLand(source: Unit, target: Unit): number {
    const windup = attackPointTime(source.attackPoint, source.attackSpeedBonus);
    if (source.projectileSpeed <= 0) return windup;
    return windup + dist(source.pos, target.pos) / source.projectileSpeed;
  }

  /** HP the target is expected to have once everything already in flight lands. */
  predictedHp(target: Unit): number {
    return target.hp - target.incomingDamage;
  }

  /**
   * Seconds until `u`'s next attack deals damage to `target`, or Infinity if it
   * is not going to hit it at all. This is exact rather than a dps average,
   * because creeps attack in discrete one-second cycles and a last hit is
   * decided by whether one more creep swing lands before yours does.
   */
  private timeToNextDamage(u: Unit, target: Unit): number {
    if (!u.alive || u.attackTargetId !== target.id) return Infinity;
    if (!this.inAttackRange(u, target)) return Infinity;
    const travel = u.projectileSpeed > 0 ? dist(u.pos, target.pos) / u.projectileSpeed : 0;
    if (u.phase === 'windup') return u.phaseTimer + travel;
    return Math.max(0, u.attackCooldown) + attackPointTime(u.attackPoint, u.attackSpeedBonus) + travel;
  }

  /**
   * HP the target will have at the instant a swing started right now by
   * `source` lands: every projectile already in the air that arrives first,
   * plus every scheduled attack from everything else hitting it.
   */
  hpAtLanding(source: Unit, target: Unit): number {
    const flight = this.timeToLand(source, target);
    let hp = target.hp;

    for (const p of this.projectiles) {
      if (p.targetId !== target.id) continue;
      if (dist(p.pos, target.pos) / p.speed <= flight) hp -= p.damage;
    }

    for (const u of this.units.values()) {
      if (u.id === source.id || u.team === target.team) continue;
      let t = this.timeToNextDamage(u, target);
      if (t === Infinity) continue;
      const interval = attackInterval(u.baseAttackTime, u.attackSpeedBonus);
      const dmg = this.expectedDamage(u, target);
      // Projectiles already launched are counted above; this is the unit's
      // current and future swings only.
      while (t <= flight) {
        hp -= dmg;
        t += interval;
      }
    }
    return hp;
  }

  canTarget(source: Unit, target: Unit): boolean {
    if (!target.alive || target.id === source.id) return false;
    if (target.kind === 'tower' && target.team === source.team) return false;
    if (target.team !== source.team) return true;
    // Same team: only creeps, only below the deny threshold.
    if (target.kind === 'hero') return false;
    if (source.kind === 'hero' && source.team === 'radiant' && !this.config.deniesEnabled) return false;
    return target.hp <= target.maxHp * DENY_THRESHOLD;
  }

  inAttackRange(source: Unit, target: Unit): boolean {
    return dist(source.pos, target.pos) <= source.attackRange + target.radius;
  }

  // ----------------------------------------------------------------- orders

  orderMove(unit: Unit, point: Vec2) {
    unit.moveTarget = { x: point.x, y: clamp(point.y, -LANE_HALF_WIDTH, LANE_HALF_WIDTH) };
    unit.orderTargetId = null;
    unit.attackTargetId = null;
    unit.attackMove = false;
    this.cancelSwing(unit);
  }

  orderAttack(unit: Unit, target: Unit) {
    // The aggro check rides on the order, not on the attack landing, so it runs
    // before canTarget turns away an order on a healthy ally. Dropping aggro by
    // clicking your own creep has to work whatever shape that creep's HP is in.
    if (unit.kind === 'hero') this.runAggroCheck(unit, target);
    if (!this.canTarget(unit, target)) return;
    if (unit.attackTargetId === target.id && unit.phase === 'windup') return;
    // Re-targeting mid-swing restarts the wind-up rather than steering it.
    unit.orderTargetId = target.id;
    unit.attackTargetId = target.id;
    unit.moveTarget = null;
    unit.attackMove = false;
    this.cancelSwing(unit);
  }

  orderAttackMove(unit: Unit, point: Vec2) {
    unit.moveTarget = { x: point.x, y: clamp(point.y, -LANE_HALF_WIDTH, LANE_HALF_WIDTH) };
    unit.orderTargetId = null;
    unit.attackTargetId = null;
    unit.attackMove = true;
    this.cancelSwing(unit);
  }

  orderStop(unit: Unit) {
    unit.moveTarget = null;
    unit.orderTargetId = null;
    unit.attackTargetId = null;
    unit.attackMove = false;
    this.cancelSwing(unit);
  }

  /**
   * Give up on the swing in progress. A stop or move issued during the wind-up
   * cancels the attack outright in Dota — that is what makes starting a swing
   * and calling it off possible — and the backswing goes the same way.
   *
   * Doing it here rather than leaving `updateCombat` to notice a null target
   * is what keeps the stats honest: that path bills a wasted swing, which is
   * meant to mean a creep died on you, not a swing you chose to call off.
   */
  private cancelSwing(unit: Unit) {
    if (unit.phase === 'windup' || unit.phase === 'backswing') {
      unit.phase = 'idle';
      unit.phaseTimer = 0;
    }
  }

  /**
   * Attack-move acquisition: the first valid enemy inside acquisition range is
   * picked up while the unit travels, and when it dies the unit goes back to
   * walking — `moveTarget` is deliberately left intact so the order outlives
   * the kill, and on arrival the unit holds the spot and keeps swinging.
   *
   * Acquisition is not an order, so no aggro check runs here: attack-moving
   * past a wave must not pull it, only a deliberate click on a hero does.
   * Allies are never acquired either, which is what stops attack-move from
   * denying your own creeps for you.
   */
  private acquireForAttackMove(u: Unit) {
    let best: Unit | null = null;
    let bestD = acquisitionRange(u.kind);
    for (const o of this.units.values()) {
      if (!o.alive || o.team === u.team) continue;
      // The tower is invulnerable here, so walking into one is never the order.
      if (o.kind === 'tower') continue;
      const d = dist(u.pos, o.pos);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best) u.attackTargetId = best.id;
  }

  /**
   * The creep aggro check, run once per attack order a hero issues.
   *
   * Lane creeps rank the heroes near them by threat: one attacking the creep or
   * its allies outranks one that is idle, and a hero attacking its *own* allies
   * ranks below both. So the same order does opposite things depending on whose
   * side the target is on — ordering an attack on an enemy hero pulls the wave
   * onto you, and ordering one on a unit of your own drops you to the bottom of
   * the list and hands the wave back. That is the whole pull/give-back dance,
   * and it is why a deny quietly sheds aggro as a side effect.
   *
   * The order alone is enough either way: the attack never has to land, and on
   * an ally it never does. Only hero-type targets count, and the system is on a
   * per-hero cooldown, so a pull cannot be immediately re-pulled.
   */
  runAggroCheck(attacker: Unit, target: Unit) {
    if (!this.config.aggroEnabled) return;

    // The two halves are not symmetric. Only an order on an enemy *hero* pulls:
    // last-hitting a creep has to stay free, or the drill would punish the one
    // thing it is teaching. Handing aggro back works off any unit of your own,
    // creeps included — clicking your own creep is how it is actually done.
    const pull = target.team !== attacker.team && target.kind === 'hero';
    const giveBack = target.team === attacker.team;
    if (!pull && !giveBack) return;

    // Only the pull is on cooldown. Giving aggro back has to stay available
    // inside the 2.3 s you are holding it, or the mechanic could never be used.
    if (pull) {
      if (attacker.aggroCooldown > 0) return;
      attacker.aggroCooldown = AGGRO_COOLDOWN;
    }
    for (const u of this.units.values()) {
      if (!u.alive || u.kind === 'hero') continue;
      if (u.team === attacker.team) continue;
      const radius = acquisitionRange(u.kind);
      if (dist(u.pos, attacker.pos) > radius) continue;

      if (pull) {
        u.aggroTargetId = attacker.id;
        u.aggroTimer = AGGRO_DURATION;
      } else if (u.aggroTargetId === attacker.id) {
        // Lowest threat now: give up the forced aggro and re-acquire normally.
        u.aggroTargetId = null;
        u.aggroTimer = 0;
        if (u.attackTargetId === attacker.id) u.attackTargetId = null;
      }
    }
  }

  // ------------------------------------------------------------------- step

  step(dt: number) {
    if (this.finished) return;
    this.time += dt;
    if (this.time >= this.config.duration) {
      this.finished = true;
    }

    this.waveTimer -= dt;
    if (this.waveTimer <= 0) {
      this.waveTimer += WAVE_INTERVAL;
      this.spawnWave(RADIANT_SPAWN, DIRE_SPAWN);
    }

    if (!this.player.alive) {
      this.playerRespawnTimer -= dt;
      if (this.playerRespawnTimer <= 0) this.respawn(this.player, RADIANT_SPAWN + 300);
    }
    if (this.enemy && !this.enemy.alive) {
      this.enemy.phaseTimer -= dt;
      if (this.enemy.phaseTimer <= 0) this.respawn(this.enemy, DIRE_SPAWN - 300);
    }

    for (const u of this.units.values()) {
      if (!u.alive) continue;
      if (u.aggroTimer > 0) {
        u.aggroTimer -= dt;
        if (u.aggroTimer <= 0) u.aggroTargetId = null;
      }
      if (u.attackCooldown > 0) u.attackCooldown -= dt;
      if (u.aggroCooldown > 0) u.aggroCooldown -= dt;
      if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.hpRegen * dt);
      if (u.kind !== 'hero') runCreepAi(this, u);
      else if (u.attackMove && !this.get(u.attackTargetId)) this.acquireForAttackMove(u);
    }

    if (this.enemyAi && this.enemy?.alive) this.enemyAi.update(this, dt);

    for (const u of this.units.values()) {
      if (!u.alive) continue;
      this.updateCombat(u, dt);
      this.updateMovement(u, dt);
    }

    this.updateProjectiles(dt);
    this.updateFloaters(dt);
    this.separate();
    this.reap();
  }

  // --------------------------------------------------------------- movement

  private updateMovement(u: Unit, dt: number) {
    if (u.moveSpeed <= 0) return;
    // A unit committed to a wind-up is rooted.
    if (u.phase === 'windup') return;

    const target = this.get(u.attackTargetId);
    let goal: Vec2 | null = null;

    if (target) {
      if (!this.inAttackRange(u, target)) {
        const a = angleTo(u.pos, target.pos);
        const stand = u.attackRange + target.radius - 20;
        goal = { x: target.pos.x - Math.cos(a) * stand, y: target.pos.y - Math.sin(a) * stand };
      }
    } else if (u.moveTarget) {
      goal = u.moveTarget;
    }

    if (!goal) return;

    const d = dist(u.pos, goal);
    if (d < 6) {
      if (!target) u.moveTarget = null;
      return;
    }

    const a = angleTo(u.pos, goal);
    this.turnToward(u, a, dt);
    const step = Math.min(d, u.moveSpeed * dt);
    u.pos.x += Math.cos(a) * step;
    u.pos.y += Math.sin(a) * step;
    u.pos.y = clamp(u.pos.y, -LANE_HALF_WIDTH, LANE_HALF_WIDTH);
  }

  private turnToward(u: Unit, angle: number, dt: number) {
    const delta = angleDelta(u.facing, angle);
    const max = turnSpeed(u.turnRate) * dt;
    u.facing += clamp(delta, -max, max);
  }

  private facingTarget(u: Unit, target: Unit): boolean {
    return Math.abs(angleDelta(u.facing, angleTo(u.pos, target.pos))) < 0.15;
  }

  /** Keep units from stacking on one pixel. Cheap, not a real pathfinder. */
  private separate() {
    const list = this.aliveUnits();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.moveSpeed <= 0 && b.moveSpeed <= 0) continue;
        const min = a.radius + b.radius;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        if (d >= min || d === 0) continue;
        const nx = dx / d;
        const ny = dy / d;
        // Immobile units do not get shoved; the other one absorbs the whole push.
        const aShare = a.moveSpeed <= 0 ? 0 : b.moveSpeed <= 0 ? 1 : 0.5;
        const push = min - d;
        a.pos.x -= nx * push * aShare;
        a.pos.y -= ny * push * aShare;
        b.pos.x += nx * push * (1 - aShare);
        b.pos.y += ny * push * (1 - aShare);
        a.pos.y = clamp(a.pos.y, -LANE_HALF_WIDTH, LANE_HALF_WIDTH);
        b.pos.y = clamp(b.pos.y, -LANE_HALF_WIDTH, LANE_HALF_WIDTH);
      }
    }
  }

  // ----------------------------------------------------------------- combat

  private updateCombat(u: Unit, dt: number) {
    // The backswing is resolved first, and a swing that is ready to start may
    // then cut it short in the same tick: the follow-through never gates the
    // next attack, only the attack cooldown does.
    if (u.phase === 'backswing') {
      u.phaseTimer -= dt;
      if (u.phaseTimer <= TIMER_EPSILON) {
        u.phase = 'idle';
        u.phaseTimer = 0;
      }
    }

    if (u.phase !== 'windup') this.tryStartSwing(u, dt);

    if (u.phase === 'windup') {
      u.phaseTimer -= dt;
      const target = this.get(u.attackTargetId);
      if (!target) {
        // Target died mid-swing: the attack is lost, exactly like in game.
        u.phase = 'idle';
        u.phaseTimer = 0;
        if (u.kind === 'hero') this.stats.wastedSwings += u.team === 'radiant' ? 1 : 0;
        return;
      }
      // Rooted, but still tracking: a unit keeps turning onto its target
      // through the wind-up, at its own turn rate rather than snapping.
      this.turnToward(u, angleTo(u.pos, target.pos), dt);
      if (u.phaseTimer <= TIMER_EPSILON) {
        this.releaseAttack(u, target);
        u.phase = 'backswing';
        u.phaseTimer = attackBackswingTime(u.attackBackswing, u.attackSpeedBonus);
      }
    }
  }

  /**
   * Begin a swing if everything lines up. Deliberately called before the
   * wind-up is ticked, so the tick that decides to attack is also the first
   * tick of the attack point — otherwise every swing in the game would land a
   * frame late, and at 1/120 that is a whole frame of borrowed time on a
   * timing the drill exists to teach.
   */
  private tryStartSwing(u: Unit, dt: number) {
    const target = this.get(u.attackTargetId);
    if (!target) return;
    if (u.attackCooldown > TIMER_EPSILON) return;
    if (!this.inAttackRange(u, target)) return;

    // Turning happens on the clock, not for free: a unit that has to come
    // about spends real time doing it before the wind-up can start.
    if (!this.facingTarget(u, target)) {
      this.turnToward(u, angleTo(u.pos, target.pos), dt);
      return;
    }

    u.phase = 'windup';
    u.phaseTimer = attackPointTime(u.attackPoint, u.attackSpeedBonus);
    u.attackCooldown = attackInterval(u.baseAttackTime, u.attackSpeedBonus);
  }

  private releaseAttack(source: Unit, target: Unit) {
    const raw = rollDamage(source, this.rng);
    const dmg = this.applyModifiers(source, target, raw);

    if (source.projectileSpeed <= 0) {
      this.applyDamage(source, target, dmg);
      return;
    }
    target.incomingDamage += dmg;
    this.projectiles.push({
      id: this.nextProjectileId++,
      sourceId: source.id,
      targetId: target.id,
      team: source.team,
      pos: { x: source.pos.x, y: source.pos.y },
      speed: source.projectileSpeed,
      damage: dmg,
      kind: source.kind === 'hero' ? 'hero' : 'creep',
    });
  }

  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const target = this.units.get(p.targetId);
      const source = this.units.get(p.sourceId);
      if (!target || !target.alive) {
        // Projectiles in Dota keep flying and fizzle; the damage never lands.
        if (target) target.incomingDamage = Math.max(0, target.incomingDamage - p.damage);
        this.projectiles.splice(i, 1);
        continue;
      }
      const d = dist(p.pos, target.pos);
      const step = p.speed * dt;
      if (step >= d) {
        target.incomingDamage = Math.max(0, target.incomingDamage - p.damage);
        this.projectiles.splice(i, 1);
        if (source) this.applyDamage(source, target, p.damage);
        continue;
      }
      const a = angleTo(p.pos, target.pos);
      p.pos.x += Math.cos(a) * step;
      p.pos.y += Math.sin(a) * step;
    }
  }

  private applyDamage(source: Unit, target: Unit, dmg: number) {
    if (!target.alive) return;
    if (target.kind === 'tower') return;
    target.hp -= dmg;
    this.pushFloater(target.pos, `-${Math.round(dmg)}`, source.kind === 'hero' ? '#ffd479' : '#b9c4cf');

    // Creeps retaliate against enemy *creeps* that hit them. A hero attacking a
    // creep draws no aggro in Dota — only an attack order on a hero does, which
    // is handled by runAggroCheck.
    if (target.kind !== 'hero' && source.kind !== 'hero' && target.team !== source.team && !target.aggroTargetId) {
      if (!this.get(target.attackTargetId)) target.attackTargetId = source.id;
    }

    if (target.hp <= 0) this.kill(source, target);
  }

  private kill(source: Unit, victim: Unit) {
    victim.alive = false;
    victim.hp = 0;
    const denied = victim.team === source.team;
    const byPlayer = source.id === this.player.id;
    const byEnemy = this.enemy != null && source.id === this.enemy.id;

    let gold = 0;
    if (victim.kind === 'hero') {
      if (victim.id === this.player.id) {
        this.stats.deaths++;
        this.playerRespawnTimer = HERO_RESPAWN_TIME;
      } else {
        victim.phaseTimer = HERO_RESPAWN_TIME;
      }
    } else if (!denied) {
      gold = victim.bounty;
      if (byPlayer) {
        this.stats.lastHits++;
        this.stats.gold += gold;
        this.pushFloater(victim.pos, `+${gold}`, '#f2c94c');
      } else if (byEnemy) {
        this.stats.enemyLastHits++;
      }
      if (victim.team === 'dire' && !byPlayer) this.stats.missed++;
      if (victim.team === 'radiant') this.stats.conceded++;
    } else {
      if (byPlayer) {
        this.stats.denies++;
        this.pushFloater(victim.pos, 'DENY', '#7fd6a2');
      } else if (byEnemy) {
        this.stats.enemyDenies++;
      }
    }

    this.killLog.push({
      victimTeam: victim.team,
      victimKind: victim.kind,
      credit: byPlayer ? 'player' : byEnemy ? 'enemy_hero' : 'creep',
      denied,
      gold,
      at: this.time,
    });

    for (const u of this.units.values()) {
      if (u.attackTargetId === victim.id) u.attackTargetId = null;
      if (u.orderTargetId === victim.id) u.orderTargetId = null;
      if (u.aggroTargetId === victim.id) {
        u.aggroTargetId = null;
        u.aggroTimer = 0;
      }
    }
  }

  private respawn(u: Unit, x: number) {
    u.alive = true;
    u.hp = u.maxHp;
    u.pos = { x, y: 0 };
    u.phase = 'idle';
    u.phaseTimer = 0;
    u.attackCooldown = 0;
    u.attackTargetId = null;
    u.orderTargetId = null;
    u.moveTarget = null;
    u.incomingDamage = 0;
  }

  private reap() {
    for (const [id, u] of this.units) {
      if (!u.alive && u.kind !== 'hero' && u.kind !== 'tower') this.units.delete(id);
    }
  }

  // ------------------------------------------------------------------ waves

  private spawnWave(radiantX: number, direX: number) {
    this.waveCount++;
    const siege = this.waveCount % SIEGE_EVERY_N_WAVES === 0;
    const make = (team: Team, x: number, tpl: typeof MELEE_CREEP, i: number) => {
      const y = ((i % 4) - 1.5) * 52 + (this.rng() - 0.5) * 18;
      const u = spawnUnit(tpl, team, { x: x + (this.rng() - 0.5) * 60, y }, this.rng);
      u.moveTarget = { x: team === 'radiant' ? DIRE_SPAWN : RADIANT_SPAWN, y: 0 };
      this.units.set(u.id, u);
    };

    for (const [team, x] of [['radiant', radiantX] as const, ['dire', direX] as const]) {
      for (let i = 0; i < 3; i++) make(team, x, MELEE_CREEP, i);
      make(team, x, RANGED_CREEP, 3);
      if (siege) make(team, x, SIEGE_CREEP, 4);
    }
  }

  // --------------------------------------------------------------- floaters

  pushFloater(pos: Vec2, text: string, color: string) {
    this.floaters.push({
      pos: { x: pos.x + (this.rng() - 0.5) * 20, y: pos.y - 20 },
      text,
      color,
      age: 0,
      life: 0.9,
      rise: 46,
    });
    if (this.floaters.length > 120) this.floaters.shift();
  }

  private updateFloaters(dt: number) {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      f.pos.y -= f.rise * dt;
      if (f.age >= f.life) this.floaters.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ hints

  /**
   * True when starting a swing *right now* should land the killing blow. This
   * is the timing the trainer is actually teaching: by the time a creep is
   * visibly one hit from death it is already too late to click.
   */
  shouldSwingNow(source: Unit, target: Unit): boolean {
    if (target.kind === 'tower' || !target.alive) return false;
    const hp = this.hpAtLanding(source, target);
    return hp > 0 && hp <= this.expectedDamage(source, target);
  }

  /** Nearest valid target under the cursor, Dota-style click priority. */
  unitAt(point: Vec2, forUnit: Unit): Unit | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      if (!u.alive || u.id === forUnit.id) continue;
      const d = dist(point, u.pos);
      if (d > u.radius + 16) continue;
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  nearestEnemy(u: Unit, range = acquisitionRange(u.kind)): Unit | null {
    let best: Unit | null = null;
    let bestD = range;
    for (const o of this.units.values()) {
      if (!o.alive || o.team === u.team) continue;
      const d = dist(u.pos, o.pos);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  withinLeash(u: Unit, target: Unit): boolean {
    return dist(u.pos, target.pos) <= LEASH_RANGE;
  }
}
