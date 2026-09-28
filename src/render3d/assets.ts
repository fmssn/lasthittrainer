import * as THREE from 'three';
import type { Team } from '../sim/types.ts';
import { HEROES } from '../sim/heroes.ts';
import { loadSprites, UNIT_CLIPS, type SpriteSheet } from './spriteView.ts';
import { HERO_TINT_SHIFT, TEAM_TINT } from './appearance.ts';

/**
 * Everything the renderer draws with, loaded before it is built: every unit's
 * sprites, the scenery's, and the ground's tiles. There is no stand-in for any
 * of it — nothing else swings on a unit's timing — so a missing file is fatal.
 */
export interface Assets {
  /** By sheet id (appearance.ts sheetId) for creeps, catapults and towers, and by hero id for heroes. */
  units: Record<string, SpriteSheet>;
  scenery: SpriteSheet;
  /** By name, as build_props.py writes them. */
  ground: Record<GroundTile, THREE.Texture>;
}

export const GROUND_TILES = ['grass', 'grass_dark', 'flowers', 'path', 'mud', 'mud_stones', 'path_dire', 'moss'] as const;
export type GroundTile = (typeof GROUND_TILES)[number];

const UNIT_SHEETS = ['melee_creep', 'ranged_creep', 'siege_creep'].flatMap((k) => [`${k}_radiant`, `${k}_dire`]);
const TOWER_SHEETS = ['tower_radiant', 'tower_dire'];

/**
 * `url` maps a path under public/ to where it is served from, so a packed
 * build can hand in data: URLs instead.
 */
export async function loadAssets(url: (path: string) => string): Promise<Assets> {
  const tint = (team: Team) => new THREE.Color(TEAM_TINT[team]).multiplyScalar(HERO_TINT_SHIFT).getHex();
  const tints = { radiant: tint('radiant'), dire: tint('dire') };
  const units = [...HEROES.map((h) => h.id), ...UNIT_SHEETS];
  const [unitSheets, towers, scenery, ground] = await Promise.all([
    Promise.all(units.map((id) => loadSprites(id, url, tints, UNIT_CLIPS))),
    Promise.all(TOWER_SHEETS.map((id) => loadSprites(id, url, tints, ['Idle']))),
    loadSprites('scenery', url, tints),
    Promise.all(GROUND_TILES.map((name) => loadTile(url(`sprites/ground/${name}.png`)))),
  ]);
  return {
    units: Object.fromEntries([...units.map((id, i) => [id, unitSheets[i]]), ...TOWER_SHEETS.map((id, i) => [id, towers[i]])]),
    scenery,
    ground: Object.fromEntries(GROUND_TILES.map((name, i) => [name, ground[i]])) as Record<GroundTile, THREE.Texture>,
  };
}

async function loadTile(url: string): Promise<THREE.Texture> {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
