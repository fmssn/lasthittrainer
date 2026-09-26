import type { ItemId } from '../sim/items.ts';

/**
 * Item icons in the style of the Warcraft III buttons the original mod used:
 * a painted object on a dark vignetted ground, inside a bevelled square that
 * is lit from the top left. Drawn here rather than lifted from the game, whose
 * icon art is Blizzard's, so each shows what the old icon showed — an axe, a
 * branch, a blue mantle — without being a copy of it.
 *
 * Each icon is its own SVG document behind a `data:` URL, not inline markup.
 * Inline, every copy would share the document's id space, and a gradient
 * resolved from a copy inside a hidden screen does not paint in Chrome — so
 * the HUD's icons would go flat whenever the menu was the one holding the id.
 * It also keeps the single-file build working, which has nowhere to fetch a
 * file from.
 */

/** A dark outline under a coloured stroke, which is how the buttons ink their shapes. */
const inked = (d: string, width: number, color: string, ink = '#120a04') =>
  `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${width + 3}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** A four-point glint. */
const glint = (x: number, y: number, r: number, color: string) =>
  `<path d="M${x} ${y - r}L${x + r * 0.28} ${y - r * 0.28}L${x + r} ${y}L${x + r * 0.28} ${y + r * 0.28}L${x} ${y + r}L${x - r * 0.28} ${y + r * 0.28}L${x - r} ${y}L${x - r * 0.28} ${y - r * 0.28}Z" fill="${color}"/>`;

/** A pointed leaf lying along +x from its stem at the origin, 24 long. */
const LEAF = 'M0 0C6-7 18-7 24 0C18 7 6 7 0 0Z';
const leaf = (x: number, y: number, rot: number, scale: number, fill = 'url(#leaf)') =>
  `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${scale})">` +
  `<path d="${LEAF}" fill="${fill}" stroke="#0f2606" stroke-width="1.3"/>` +
  `<path d="M1.5 0L22 0" stroke="#2a5512" stroke-width="0.9"/></g>`;

/** One slipper, toe to the right, for the pair in the Slippers icon. */
const SLIPPER_OUTLINE =
  'M12 46C11 38 14 32 20 31C24 30 27 34 31 34C36 34 40 32 44 34C49 36 52 38 54 34C55 31 53 28 56 27C59 28 59 34 57 38C54 46 48 50 40 50L18 50C14 50 12 49 12 46Z';
const SLIPPER =
  `<path d="${SLIPPER_OUTLINE}" fill="url(#cloth)" stroke="#0b1a06" stroke-width="1.4" stroke-linejoin="round"/>` +
  `<path d="M16 34C19 31 26 33 31 35C27 37 20 37 16 34Z" fill="#0f1a08"/>` +
  `<path d="M13 48C20 51.5 40 51.5 51 47" fill="none" stroke="#5a3b1c" stroke-width="3" stroke-linecap="round"/>` +
  `<path d="M14.5 36.5C20 32.5 27 35.5 32 36.5" fill="none" stroke="#e8c85c" stroke-width="1.7" stroke-linecap="round"/>` +
  `<path d="M32 37C40 37 48 41 55 33" fill="none" stroke="#e8c85c" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>` +
  `<circle cx="56.3" cy="27.3" r="1.9" fill="url(#gold)" stroke="#3b2a06" stroke-width=".8"/>`;

const button = (art: string, ground: [string, string], defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>` +
  `<radialGradient id="ground" cx=".42" cy=".36" r=".85"><stop offset="0" stop-color="${ground[0]}"/><stop offset="1" stop-color="${ground[1]}"/></radialGradient>` +
  `<radialGradient id="vignette" cx=".5" cy=".5" r=".72"><stop offset=".62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></radialGradient>` +
  `<linearGradient id="steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f7f9"/><stop offset=".45" stop-color="#aab5bf"/><stop offset="1" stop-color="#4b5661"/></linearGradient>` +
  `<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2b0"/><stop offset=".5" stop-color="#d9a336"/><stop offset="1" stop-color="#7a5212"/></linearGradient>` +
  `<linearGradient id="leaf" x1="0" y1="-1" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#c3f57a"/><stop offset="1" stop-color="#3b8421"/></linearGradient>` +
  `<filter id="grain" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="7"/>` +
  `<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.4 0 0 0 -.7"/></filter>` +
  defs +
  `</defs><rect width="64" height="64" fill="url(#ground)"/>${art}` +
  `<rect width="64" height="64" filter="url(#grain)" opacity=".16"/>` +
  `<rect width="64" height="64" fill="url(#vignette)"/>` +
  `<path d="M0 0H64L60.5 3.5H3.5V60.5L0 64Z" fill="#fff" fill-opacity=".22"/>` +
  `<path d="M64 64H0L3.5 60.5H60.5V3.5L64 0Z" fill="#000" fill-opacity=".5"/>` +
  `<rect x="3.5" y="3.5" width="57" height="57" fill="none" stroke="#000" stroke-opacity=".55"/>` +
  `<rect x=".5" y=".5" width="63" height="63" fill="none" stroke="#000"/></svg>`;

const ART: Record<ItemId, string> = {
  // A hatchet: a crescent blade and a back spike on a wrapped haft.
  quelling_blade: button(
    `<g transform="translate(0 3)">` +
      inked('M17 53L43 15', 5, '#8a5a2b') +
      `<path d="M18.2 50.5L42 15.6" stroke="#c58d55" stroke-width="1.3" stroke-linecap="round" opacity=".8"/>` +
      `<path d="M17.2 46.4L23 50.4M19.8 42.6L25.6 46.6M22.4 38.8L28.2 42.8" stroke="#2b1a0c" stroke-width="1.8"/>` +
      `<path d="M34.7 27.1L41.5 17.1" stroke="#1a1d21" stroke-width="8.5" stroke-linecap="round"/>` +
      `<path d="M34.7 27.1L41.5 17.1" stroke="#5a636c" stroke-width="5.5" stroke-linecap="round"/>` +
      `<path d="M38.6 21.4L46.3 23.6L41.5 17.1Z" fill="#7d8893" stroke="#0e1114" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<path d="M35.2 26.4Q29 25.8 17.8 21.8Q18.5 10.1 29.2 5.1Q37.5 13.2 40.9 18Z" fill="url(#steel)" stroke="#0e1114" stroke-width="1.3" stroke-linejoin="round"/>` +
      `<path d="M19.8 20Q20.6 11.8 28.4 7.4" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity=".85"/>` +
      `</g>`,
    ['#4d3725', '#120c07'],
  ),

  // A gnarled branch with a few leaves still on it.
  iron_branch: button(
    `<g transform="translate(3.5 6) scale(.88)">` +
      `<path d="M12 55Q20 45 27 38M27 38Q36 30 40 20M40 20Q43 14 50 10M27 38Q36 39 46 34M36 28Q32 21 33 13" fill="none" stroke="#140b04" stroke-linecap="round" stroke-width="9"/>` +
      `<path d="M12 55Q20 45 27 38" fill="none" stroke="#7a4f2a" stroke-linecap="round" stroke-width="6.5"/>` +
      `<path d="M27 38Q36 30 40 20M27 38Q36 39 46 34" fill="none" stroke="#7a4f2a" stroke-linecap="round" stroke-width="4.5"/>` +
      `<path d="M40 20Q43 14 50 10M36 28Q32 21 33 13" fill="none" stroke="#7a4f2a" stroke-linecap="round" stroke-width="3"/>` +
      `<path d="M13 52Q20 44 26 38.5Q34 31 38.5 21" fill="none" stroke="#b98553" stroke-linecap="round" stroke-width="1.3" opacity=".8"/>` +
      `<ellipse cx="21" cy="46" rx="1.6" ry="1.1" fill="#2b170a"/><ellipse cx="33" cy="33" rx="1.3" ry="1" fill="#2b170a"/>` +
      leaf(49, 10.5, -35, 0.62) +
      leaf(45, 34, 8, 0.6) +
      leaf(33, 14, -110, 0.55) +
      leaf(22, 43, -160, 0.45) +
      `</g>`,
    ['#2e3f24', '#0a0f07'],
  ),

  // A green fairy flame, the colour Faerie Fire has always burned.
  faerie_fire: button(
    `<circle cx="32" cy="36" r="22" fill="url(#glow)"/>` +
      `<path d="M32 55C20 55 16 45 19 37C21 31 26 28 25 19C31 23 33 28 33 32C35 27 38 23 37 14C45 21 48 32 46 41C44 50 39 55 32 55Z" fill="url(#flame)" stroke="#05301e" stroke-width="1.3"/>` +
      `<path d="M32 52C25 52 23 46 25 41C27 37 30 35 30 30C34 33 36 37 35 41C37 38 39 36 39 32C43 37 43 44 41 47C39 51 36 52 32 52Z" fill="#c9ffe6"/>` +
      `<ellipse cx="32" cy="46" rx="5" ry="4" fill="#fff" opacity=".9"/>` +
      glint(15, 17, 3, '#d9fff0') +
      glint(50, 14, 2.5, '#d9fff0') +
      glint(49, 49, 2, '#d9fff0'),
    ['#133e48', '#03090c'],
    `<radialGradient id="glow"><stop offset="0" stop-color="#7dffc4" stop-opacity=".6"/><stop offset="1" stop-color="#7dffc4" stop-opacity="0"/></radialGradient>` +
      `<linearGradient id="flame" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#15a266"/><stop offset="1" stop-color="#72ffb8"/></linearGradient>`,
  ),

  // A leafy sprig: what the drill cannot let you eat.
  tango: button(
    inked('M32 57C31 49 31 41 32 30', 2.6, '#3d6b1c', '#0f2606') +
      leaf(32, 48, 168, 0.78) +
      leaf(32, 48, 12, 0.78) +
      leaf(32, 40, -148, 0.95) +
      leaf(32, 40, -32, 0.95) +
      leaf(32, 31, -92, 0.9),
    ['#3b3217', '#0c0a04'],
  ),

  // A plain wooden wand with a charge glowing at its tip.
  magic_stick: button(
    `<circle cx="44" cy="17" r="15" fill="url(#charge)"/>` +
      inked('M15 55Q26 39 44 17', 4.5, '#7b5230') +
      `<path d="M16.5 52.5Q26.5 38 42.5 18" fill="none" stroke="#b88758" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>` +
      `<path d="M17.5 47.5L23 51.5M20 44L25.5 48M22.5 40.5L28 44.5" stroke="#d8c6a0" stroke-width="1.6"/>` +
      `<circle cx="44.5" cy="16.5" r="4.2" fill="#f3e8ff"/>` +
      `<path d="M36 20A9.5 9.5 0 0 1 51 9.5M53 14A9.5 9.5 0 0 1 43 26" fill="none" stroke="#d9c4ff" stroke-width="1.1" stroke-linecap="round" opacity=".85"/>` +
      glint(54, 9, 2.6, '#efe4ff') +
      glint(36, 9, 2, '#efe4ff') +
      glint(55, 26, 1.8, '#efe4ff'),
    ['#221a3c', '#06050d'],
    `<radialGradient id="charge"><stop offset="0" stop-color="#c09bff" stop-opacity=".85"/><stop offset="1" stop-color="#8a5cff" stop-opacity="0"/></radialGradient>`,
  ),

  // A pair of green slippers with curled toes and gold trim, the back one in shadow.
  slippers: button(
    `<g transform="translate(-3 -11)">${SLIPPER}<path d="${SLIPPER_OUTLINE}" fill="#000" opacity=".45"/></g>` +
      `<g transform="translate(1 4)">${SLIPPER}</g>` +
      `<path d="M7 43H11M6 47.5H10" stroke="#d5ecaa" stroke-width="1.2" stroke-linecap="round" opacity=".55"/>`,
    ['#3b3419', '#0c0a05'],
    `<linearGradient id="cloth" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#9ee063"/><stop offset="1" stop-color="#2c661d"/></linearGradient>`,
  ),

  // A blue mantle, open at the front, held by a gold clasp.
  mantle: button(
    `<path d="M32 12C26 12 20 15 17 20C14 30 12 44 9 55C18 57 26 56 32 54C38 56 46 57 55 55C52 44 50 30 47 20C44 15 38 12 32 12Z" fill="url(#robe)" stroke="#070b1f" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<path d="M32 21C29 31 28 44 27 55L37 55C36 44 35 31 32 21Z" fill="#0b1130"/>` +
      `<path d="M21 26C19 36 17 46 15 55M43 26C45 36 47 46 49 55" fill="none" stroke="#10205a" stroke-width="1.3"/>` +
      `<path d="M24 22C22 32 21 44 20 55" fill="none" stroke="#a7c6ff" stroke-width="1" opacity=".5"/>` +
      `<path d="M21 18C25 10 39 10 43 18C38 15.5 26 15.5 21 18Z" fill="#3f63c9" stroke="#070b1f" stroke-width="1.1"/>` +
      `<circle cx="32" cy="20" r="3.4" fill="url(#gold)" stroke="#3b2a06" stroke-width=".9"/>` +
      `<circle cx="32" cy="20" r="1.4" fill="#63d6ff"/>`,
    ['#241b3d', '#07050e'],
    `<linearGradient id="robe" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#78a4ff"/><stop offset="1" stop-color="#1a2d70"/></linearGradient>`,
  ),

  // A plated fist over a red leather cuff.
  gauntlets: button(
    `<path d="M17 57L21.5 40H42.5L47 57Z" fill="url(#leather)" stroke="#1a0604" stroke-width="1.3" stroke-linejoin="round"/>` +
      `<path d="M21 34C15 32 14 26 17 22C19 20 22 22 22.5 26Z" fill="url(#steel)" stroke="#0e1114" stroke-width="1.2"/>` +
      `<path d="M21 41C19 33 20 27 22 23H42C44 27 45 33 43 41Z" fill="url(#steel)" stroke="#0e1114" stroke-width="1.3" stroke-linejoin="round"/>` +
      `<rect x="21.5" y="13" width="6" height="11" rx="3" fill="url(#steel)" stroke="#0e1114" stroke-width="1.1"/>` +
      `<rect x="27.5" y="11" width="6" height="13" rx="3" fill="url(#steel)" stroke="#0e1114" stroke-width="1.1"/>` +
      `<rect x="33.5" y="11" width="6" height="13" rx="3" fill="url(#steel)" stroke="#0e1114" stroke-width="1.1"/>` +
      `<rect x="39.5" y="13" width="5.5" height="11" rx="2.8" fill="url(#steel)" stroke="#0e1114" stroke-width="1.1"/>` +
      `<rect x="20.5" y="21.5" width="25" height="5" rx="2" fill="#6b7580" stroke="#0e1114" stroke-width="1.1"/>` +
      `<path d="M21.5 40H42.5L43.5 44.5H20.5Z" fill="url(#gold)" stroke="#3b2a06" stroke-width="1"/>` +
      `<circle cx="24" cy="24" r="1" fill="#eef2f5"/><circle cx="33" cy="24" r="1" fill="#eef2f5"/><circle cx="42" cy="24" r="1" fill="#eef2f5"/>` +
      `<path d="M25 30C26 34 26 37 25 39" fill="none" stroke="#fff" stroke-width="1.1" opacity=".6"/>`,
    ['#3b2b1b', '#0d0906'],
    `<linearGradient id="leather" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b3402b"/><stop offset="1" stop-color="#4a120b"/></linearGradient>`,
  ),

  // A gold band with a red stone set at the front.
  circlet: button(
    `<ellipse cx="32" cy="36" rx="22" ry="12" fill="url(#halo)"/>` +
      `<path d="M12 36A20 9 0 0 1 52 36" fill="none" stroke="#1a1004" stroke-width="8"/>` +
      `<path d="M12 36A20 9 0 0 1 52 36" fill="none" stroke="#8a651e" stroke-width="5"/>` +
      `<path d="M52 36A20 9 0 0 1 12 36" fill="none" stroke="#1a1004" stroke-width="9"/>` +
      `<path d="M52 36A20 9 0 0 1 12 36" fill="none" stroke="url(#gold)" stroke-width="6"/>` +
      `<path d="M15 39.5A20 9 0 0 0 49 39.5" fill="none" stroke="#fff6c8" stroke-width="1" opacity=".7"/>` +
      `<ellipse cx="32" cy="45" rx="6" ry="6.5" fill="url(#gold)" stroke="#3b2a06" stroke-width="1"/>` +
      `<path d="M32 39.5L36.5 45L32 50.5L27.5 45Z" fill="url(#ruby)" stroke="#3a0408" stroke-width=".9"/>` +
      `<path d="M32 40.8L34.2 44.2L30.8 43.4Z" fill="#fff" opacity=".85"/>` +
      `<circle cx="20.5" cy="42.5" r="1.8" fill="#7fd6ff" stroke="#0c2a3a" stroke-width=".7"/>` +
      `<circle cx="43.5" cy="42.5" r="1.8" fill="#7fd6ff" stroke="#0c2a3a" stroke-width=".7"/>`,
    ['#2e2040', '#09060e'],
    `<radialGradient id="halo"><stop offset="0" stop-color="#ffd76a" stop-opacity=".22"/><stop offset="1" stop-color="#ffd76a" stop-opacity="0"/></radialGradient>` +
      `<linearGradient id="ruby" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a8a"/><stop offset="1" stop-color="#9c0f1c"/></linearGradient>`,
  ),
};

const urls = new Map<ItemId, string>();

/** The icon as a URL an `<img>` can take. */
export function itemIconUrl(id: ItemId): string {
  let url = urls.get(id);
  if (!url) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ART[id])}`;
    urls.set(id, url);
  }
  return url;
}
