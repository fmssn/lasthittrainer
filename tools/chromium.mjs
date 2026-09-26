import { existsSync } from 'node:fs';

const CONTAINER = '/opt/pw-browsers/chromium';

/**
 * The Chromium the harnesses drive. A Claude Code container ships one at a
 * revision this playwright build does not expect, so it is pointed at directly
 * rather than downloading a second copy. Anywhere else, `undefined` lets
 * playwright use its own (`npx playwright install chromium`, once). CHROMIUM
 * overrides both.
 */
export function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  return existsSync(CONTAINER) ? CONTAINER : undefined;
}
