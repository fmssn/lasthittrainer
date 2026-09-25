export type Team = 'radiant' | 'dire';

export type UnitKind = 'hero' | 'melee_creep' | 'ranged_creep' | 'siege_creep' | 'tower';

export interface Vec2 {
  x: number;
  y: number;
}

export type AttackPhase = 'idle' | 'windup' | 'backswing';

/** Everything that can be hit, move, or attack. */
export interface Unit {
  id: number;
  kind: UnitKind;
  team: Team;
  name: string;

  pos: Vec2;
  facing: number;
  radius: number;
  moveSpeed: number;
  turnRate: number;

  hp: number;
  maxHp: number;
  hpRegen: number;
  armor: number;

  damageMin: number;
  damageMax: number;
  attackRange: number;
  baseAttackTime: number;
  attackPoint: number;
  attackBackswing: number;
  /** 0 for instant (melee) attacks. */
  projectileSpeed: number;
  attackSpeedBonus: number;

  /** Gold the killer receives. Creeps roll within a range at spawn. */
  bounty: number;
  xp: number;

  alive: boolean;

  // --- runtime state ---
  /** Explicit order target; null means the unit is auto-acquiring. */
  orderTargetId: number | null;
  /** Unit currently being swung at. */
  attackTargetId: number | null;
  /** Point the unit is walking to when it has no attack target. */
  moveTarget: Vec2 | null;
  /** True when the order came from attack-move (A-click) rather than plain move. */
  attackMove: boolean;

  phase: AttackPhase;
  /** Seconds left in the current windup or backswing. */
  phaseTimer: number;
  /** Seconds until the next attack may begin. */
  attackCooldown: number;

  /** Forced aggro: unit id and remaining seconds. */
  aggroTargetId: number | null;
  aggroTimer: number;
  /** Heroes only: seconds until this unit's next aggro check is allowed. */
  aggroCooldown: number;

  /** Set once a projectile is inbound that will finish this unit, for AI bookkeeping. */
  incomingDamage: number;
}

export interface Projectile {
  id: number;
  sourceId: number;
  targetId: number;
  team: Team;
  pos: Vec2;
  speed: number;
  damage: number;
  /** Visual only. */
  kind: 'creep' | 'hero';
}

/**
 * What produced a floater. Dota shows no damage numbers for creeps hitting each
 * other — the lane would be unreadable — so the renderer needs to be able to
 * tell your own hits and the ones landing on you apart from wave noise.
 */
export type FloaterKind = 'player_damage' | 'incoming_damage' | 'creep_damage' | 'gold' | 'deny';

export interface FloatingText {
  pos: Vec2;
  text: string;
  color: string;
  kind: FloaterKind;
  age: number;
  life: number;
  rise: number;
}

export type KillCredit = 'player' | 'enemy_hero' | 'creep' | 'none';

export interface KillEvent {
  victimTeam: Team;
  victimKind: UnitKind;
  credit: KillCredit;
  denied: boolean;
  gold: number;
  at: number;
}
