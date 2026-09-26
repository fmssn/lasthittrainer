/**
 * Regenerate public/models/melee_creep.glb through Blender.
 *
 *   npm run model              # headless rebuild, prints the GLB_REPORT
 *   npm run model -- --ui      # same, then opens the new GLB in Blender
 *
 * Blender is looked up through BLENDER, then the pinned build that
 * tools/fetch_assets.sh puts in tools/.cache, then PATH, then the default
 * install folders, newest version first. Versions before 4.0 are skipped:
 * 2.93's glTF exporter has no export_animation_mode, and the script is written
 * against 5.2.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIN_MAJOR = 4;
const SCRIPT = 'tools/blender/make_creep.py';
const OUT = 'public/models/melee_creep.glb';

/** Pinned so a rebuild reproduces the committed GLB; fetch_assets.sh is Linux-only. */
function pinned() {
  const cache = 'tools/.cache';
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache).filter((n) => n.startsWith('blender-')).sort().reverse();
  for (const name of builds) {
    const exe = join(cache, name, process.platform === 'win32' ? 'blender.exe' : 'blender');
    if (existsSync(exe)) return resolve(exe);
  }
  return undefined;
}

function onPath() {
  const probe = spawnSync('blender', ['--version'], { encoding: 'utf8' });
  const m = probe.stdout?.match(/^Blender (\d+)\./m);
  return m && Number(m[1]) >= MIN_MAJOR ? 'blender' : undefined;
}

/** Windows installs side by side as "Blender Foundation/Blender X.Y". */
function installed() {
  if (process.platform === 'darwin') {
    const app = '/Applications/Blender.app/Contents/MacOS/Blender';
    return existsSync(app) ? app : undefined;
  }
  if (process.platform !== 'win32') return undefined;
  const root = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation');
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root)
    .map((name) => ({ name, v: name.match(/^Blender (\d+)\.(\d+)/) }))
    .filter((d) => d.v && Number(d.v[1]) >= MIN_MAJOR)
    .sort((a, b) => Number(b.v[1]) - Number(a.v[1]) || Number(b.v[2]) - Number(a.v[2]));
  for (const { name } of versions) {
    const exe = join(root, name, 'blender.exe');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const blender = process.env.BLENDER ?? pinned() ?? onPath() ?? installed();
if (!blender) {
  console.error(`No Blender ${MIN_MAJOR}.0+ found. Install it, or set BLENDER to its executable.`);
  process.exit(1);
}

const args = ['--background', '--python', SCRIPT, '--', '--out', OUT];
console.log(`${blender} ${args.join(' ')}`);
const run = spawnSync(blender, args, { stdio: 'inherit' });
if (run.status !== 0 || !process.argv.includes('--ui')) process.exit(run.status ?? 1);

// The script cannot simply run with a window open: read_factory_settings leaves
// bpy.context stale until the event loop turns, and the first mode_set fails.
// So build headless as above, then open the GLB itself, which is also exactly
// what three.js will see.
const view = [
  'import bpy',
  'for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)',
  `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(resolve(OUT))})`,
].join('\n');
spawn(blender, ['--python-expr', view], { detached: true, stdio: 'ignore' }).unref();
