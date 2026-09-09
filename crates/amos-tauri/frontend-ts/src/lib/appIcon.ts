/**
 * appIcon.ts — Framework-agnostic launcher-tile model (single source of truth).
 *
 * Home surfaces (dock, icon grid, Spotlight, Recents, Edit-Home) all draw the
 * same "tonal tile" language: a deterministic per-app gradient + a centred
 * glyph. A small set of first-party apps instead use a dedicated "bespoke face"
 * (paper/night/tinted wash) plus bespoke vector art.
 *
 * WHY THIS MODULE EXISTS: the Svelte tile renderer (svelte/AppIcon.svelte) needs
 * to paint these tiles. Keeping the tone palette, per-app gradient, face washes
 * AND the bespoke glyph geometry as pure data here means the renderer can never
 * drift — the exact numbers that decide colour / geometry live in exactly one
 * place, and both the emoji-tile path and the bespoke-glyph path consume them.
 * (This file keeps that #1 audit-flagged regression source — a duplicated icon
 * implementation — in exactly one place.)
 *
 * The bespoke glyphs are returned as *SVG markup strings* so the Svelte tile
 * renderer can embed them via `{@html}`.
 * No framework import here — pure, unit-testable, SSR-safe.
 */

/** Deterministic soft tonal gradient families (top lighter → bottom deeper). */
export const ICON_TONES: ReadonlyArray<readonly [string, string]> = [
  ["#cfe3ee", "#a7c9e3"], // soft sky
  ["#ded7ee", "#bfaede"], // soft lavender
  ["#f3ddd6", "#e9c0b8"], // soft rose
  ["#d0e8dc", "#a8d3bd"], // soft sage
  ["#cfe0f2", "#a3bce6"], // soft periwinkle
  ["#f6e3cf", "#efcd9f"], // soft apricot
  ["#f0d6e2", "#ddadd3"], // soft pink
  ["#e8ecd0", "#d3df9e"], // soft green
  ["#cde8e2", "#a6d5cf"], // soft mint
  ["#f2d3cf", "#e6a89f"], // soft coral
];

/** Deterministic per-app background gradient (hash of the id). */
export function toneOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const [a, b] = ICON_TONES[h % ICON_TONES.length]!;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/* ---- Bespoke face washes (the tile background for first-party faces) ---- */
const WHITE_FACE = "linear-gradient(165deg,#ffffff,#eef2fa)"; // paper tiles
const NIGHT_FACE = "linear-gradient(160deg,#43434b 0%,#15151b 46%,#050507 100%)";
const PHOTOS_FACE = "linear-gradient(150deg,#fdfdfe,#eef1f7)"; // warm white
const CONTACTS_FACE = "linear-gradient(150deg,#71d1ff,#2e7bf6 68%,#1f5fe8)"; // sky blue
const AI_FACE = "linear-gradient(150deg,#cbb4ff,#8a6bff 55%,#5b43e8)"; // violet
const MAP_FACE = "linear-gradient(162deg,#e7eef6 0%,#cbdcEA 55%,#bdD2E5 100%)"; // map-canvas

/** ids that use a dedicated first-party face + bespoke vector art. */
export const BESPOKE_IDS: readonly string[] = [
  "reminders",
  "vmemos",
  "notes",
  "clock",
  "calculator",
  "photos",
  "maps",
  "contacts",
  "ai",
] as const;

/** True when a launcher tile should use a dedicated face rather than a glyph. */
export function isBespokeTile(id: string): boolean {
  return (BESPOKE_IDS as readonly string[]).includes(id);
}

/** Face wash for a bespoke tile; `null` for ordinary tonal tiles. */
export function bespokeFace(id: string): string | null {
  switch (id) {
    case "reminders":
    case "vmemos":
    case "notes":
      return WHITE_FACE;
    case "clock":
    case "calculator":
      return NIGHT_FACE;
    case "photos":
      return PHOTOS_FACE;
    case "contacts":
      return CONTACTS_FACE;
    case "ai":
      return AI_FACE;
    case "maps":
      return MAP_FACE;
    default:
      return null;
  }
}

/** Resolve the effective background image for any tile id (tonal or bespoke). */
export function tileBackground(id: string): string {
  return bespokeFace(id) ?? toneOf(id);
}

/* =====================================================================
 * Bespoke glyph geometry -> SVG markup strings.
 * Pure geometry numbers; the Svelte renderer embeds them as `<svg>` markup
 * (SVG attrs use kebab-case).
 * ===================================================================== */

const round = (n: number, d = 2): number => {
  const k = 10 ** d;
  return Math.round(n * k) / k;
};

/** Polar point helper (deg clockwise from 12 o'clock, origin at 36,36). */
function pt(deg: number, r: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: round(36 + r * Math.sin(a)), y: round(36 - r * Math.cos(a)) };
}

/** Four-point twinkle star points string (used by the AI glyph). */
function sparklePoints(x: number, y: number, s: number): string {
  const r = s * 0.34;
  const pts: string[] = [];
  for (let k = 0; k < 8; k++) {
    const ang = (k * 45 * Math.PI) / 180 - Math.PI / 2;
    const rad = k % 2 === 0 ? s : r;
    pts.push(`${round(x + rad * Math.cos(ang))},${round(y + rad * Math.sin(ang))}`);
  }
  return pts.join(" ");
}

/** Assemble a full <svg …>…</svg> glyph from its inner markup + sizing class. */
function svgGlyph(cls: string, inner: string): string {
  return `<svg viewBox="0 0 72 72" aria-hidden="true" class="${cls}">${inner}</svg>`;
}

/** Reminders: checked white/green checkbox over soft grey "text" lines. */
function remindersGlyph(): string {
  return svgGlyph(
    "h-[62%] w-[62%] drop-shadow-[0_1px_2px_rgba(0,0,0,0.14)]",
    "<g>" +
      '<rect x="9" y="11" width="19" height="19" rx="5.5" fill="#2fbf71"/>' +
      '<path d="M13.5 20.5 l4.6 4.6 L26 15.6" stroke="#ffffff" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<rect x="9" y="40" width="15" height="15" rx="4.5" fill="#eef1f6" stroke="#c6cbd6" stroke-width="1.6"/>' +
      '<rect x="29" y="42.5" width="34" height="5.6" rx="2.8" fill="#d7dbe4"/>' +
      '<rect x="29" y="50.5" width="24" height="5.6" rx="2.8" fill="#e6e9ef"/>' +
      "</g>",
  );
}

/** Voice Memos: a red recording waveform over a white card. */
function voiceGlyph(): string {
  const bars = [
    { x: 18, h: 12 },
    { x: 27, h: 22 },
    { x: 36, h: 34 },
    { x: 45, h: 22 },
    { x: 54, h: 12 },
  ];
  const rects = bars
    .map(
      (b) =>
        `<rect x="${b.x}" y="${36 - b.h / 2}" width="6" height="${b.h}" rx="3" fill="#f43f5e"/>`,
    )
    .join("");
  return svgGlyph(
    "h-[62%] w-[62%] drop-shadow-[0_1px_2px_rgba(0,0,0,0.14)]",
    `<g fill="#f43f5e">${rects}` +
      '<path d="M36 17a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0v-6a6 6 0 0 1 6-6z" fill="#ffffff"/>' +
      '<path d="M26 30v2a10 10 0 0 0 20 0v-2" fill="none" stroke="#f43f5e" stroke-width="4" stroke-linecap="round"/>' +
      '<rect x="33" y="44" width="6" height="5" rx="1.5" fill="#f43f5e"/>' +
      "</g>",
  );
}

/** Notes: a yellow notepad with rule lines over white. */
function notesGlyph(): string {
  return svgGlyph(
    "h-[66%] w-[66%] drop-shadow-[0_1px_2px_rgba(0,0,0,0.16)]",
    "<g>" +
      '<rect x="13" y="9" width="46" height="54" rx="7" fill="#f4c430"/>' +
      '<path d="M13 9 h46 v8 a0 0 0 0 1 0 0 H13 Z" fill="#d9a800"/>' +
      '<rect x="13" y="9" width="46" height="6" rx="3" fill="#e0ae00"/>' +
      '<g fill="#c9a227">' +
      '<rect x="20" y="26" width="32" height="3.4" rx="1.7"/>' +
      '<rect x="20" y="36" width="32" height="3.4" rx="1.7"/>' +
      '<rect x="20" y="46" width="32" height="3.4" rx="1.7"/>' +
      "</g>" +
      '<rect x="20" y="54" width="18" height="3.4" rx="1.7" fill="#fff3c0"/>' +
      "</g>",
  );
}



/** Clock: crisp white analogue face (~10:09) + red seconds, on the night tile. */
function clockGlyph(): string {
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30)
    .map((deg) => {
      const a = pt(deg, 20.5);
      const b = pt(deg, 24.5);
      const major = deg % 90 === 0;
      const w = major ? 3 : 1.6;
      return (
        `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ` +
        `stroke="#ffffff" stroke-width="${w}" stroke-linecap="round" opacity="0.95"/>`
      );
    })
    .join("");
  const hour = pt(30 * (10 + 9 / 60), 12);
  const minute = pt(6 * 9, 18);
  const second = pt(6 * 30, 22);
  return svgGlyph(
    "h-[80%] w-[80%] drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]",
    "<g>" +
      '<circle cx="36" cy="36" r="25.5" fill="none" stroke="#ffffff" stroke-width="4"/>' +
      ticks +
      `<line x1="36" y1="36" x2="${hour.x}" y2="${hour.y}" stroke="#ffffff" stroke-width="4.4" stroke-linecap="round"/>` +
      `<line x1="36" y1="36" x2="${minute.x}" y2="${minute.y}" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>` +
      `<line x1="36" y1="36" x2="${second.x}" y2="${second.y}" stroke="#ff3b30" stroke-width="1.7" stroke-linecap="round"/>` +
      '<circle cx="36" cy="36" r="2.5" fill="#ff3b30"/>' +
      "</g>",
  );
}

/** Calculator: bright keypad (LCD + number keys + orange operator column). */
function calculatorGlyph(): string {
  const cols = [18, 29.4, 40.8, 52.2];
  const rows = [30, 41, 52];
  let keys = "";
  for (const y of rows)
    for (let ci = 0; ci < cols.length; ci++) {
      const x = cols[ci]!;
      const operator = ci === 3;
      const top = y === rows[0];
      const fill = operator ? "#ff9f0a" : top ? "#f2f2f7" : "#cfd1d8";
      keys +=
        `<rect x="${round(x - 3.9, 1)}" y="${round(y - 4, 1)}" width="7.8" height="8" ` +
        `rx="1.9" fill="${fill}"/>`;
    }
  return svgGlyph(
    "h-[88%] w-[88%] drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]",
    "<g>" +
      '<rect x="13" y="13" width="46" height="10" rx="3.4" fill="#0b0b0e" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1"/>' +
      '<rect x="41" y="16.4" width="14" height="3.2" rx="1.6" fill="#e6e6ec" opacity="0.9"/>' +
      keys +
      "</g>",
  );
}

/** Photos: the signature 8-petal colour pinwheel over a soft white tile. */
function photosGlyph(): string {
  const petals = [
    "#ff5d5d",
    "#ff9f1c",
    "#ffd22e",
    "#59d078",
    "#2fc1e8",
    "#3f6df0",
    "#9a5cff",
    "#ff5da0",
  ];
  const ellipses = petals
    .map(
      (c, i) =>
        `<ellipse cx="36" cy="36" rx="27" ry="10.5" fill="${c}" opacity="0.94" ` +
        `transform="rotate(${(i * 360) / petals.length} 36 36)"/>`,
    )
    .join("");
  return svgGlyph(
    "h-[92%] w-[92%] drop-shadow-[0_2px_5px_rgba(90,110,180,0.25)]",
    `<g>${ellipses}` +
      '<circle cx="36" cy="36" r="5.5" fill="#ffffff" opacity="0.9"/>' +
      '<circle cx="36" cy="36" r="5.5" fill="none" stroke="#ffffff" stroke-width="0"/>' +
      "</g>",
  );
}

/** Maps: mini map of cased white streets + park/water hints + red pin. */
function mapsGlyph(): string {
  const casing = "rgba(125,150,180,0.5)";
  return svgGlyph(
    "h-[94%] w-[94%] drop-shadow-[0_2px_5px_rgba(70,110,150,0.28)]",
    '<ellipse cx="13" cy="15" rx="13" ry="9" fill="#a7dcab" opacity="0.55" transform="rotate(-16 13 15)"/>' +
      '<ellipse cx="60" cy="62" rx="14" ry="10" fill="#9ccdf0" opacity="0.6" transform="rotate(24 60 62)"/>' +
      `<g stroke="${casing}">` +
      '<path d="M22 -2 V74" stroke-width="16"/>' +
      '<path d="M-2 40 H74" stroke-width="15"/>' +
      '<path d="M4 70 C 30 52 42 30 66 6" stroke-width="17"/>' +
      "</g>" +
      '<g stroke="#ffffff" fill="none" stroke-linecap="round">' +
      '<path d="M22 -2 V74" stroke-width="12"/>' +
      '<path d="M-2 40 H74" stroke-width="11"/>' +
      '<path d="M4 70 C 30 52 42 30 66 6" stroke-width="13"/>' +
      "</g>" +
      '<g stroke="#8fa6c0" stroke-width="3.4" fill="none" stroke-linecap="round">' +
      '<path d="M22 24 C 30 24 38 20 46 14"/>' +
      '<path d="M8 56 C 22 56 34 48 44 40"/>' +
      "</g>" +
      '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" transform="translate(34 33) scale(1.5)" fill="#ff3b30" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="49.5" cy="46" r="3.1" fill="#ffffff"/>',
  );
}

/** Contacts: a clean white "people" silhouette (head on shoulders). */
function contactsGlyph(): string {
  return svgGlyph(
    "h-[82%] w-[82%] drop-shadow-[0_2px_6px_rgba(10,40,120,0.3)]",
    '<g fill="#ffffff">' +
      '<path d="M13 70 C 13 46 22 34 36 34 C 50 34 59 46 59 70 Z" opacity="0.96"/>' +
      '<circle cx="36" cy="23.5" r="11.5"/>' +
      '<circle cx="36" cy="54" r="6" opacity="0.28" fill="#164cc9"/>' +
      "</g>",
  );
}

/** AI: violet tile dusted with white Siri-style twinkle stars + chat pulse. */
function aiGlyph(): string {
  return svgGlyph(
    "h-[86%] w-[86%] drop-shadow-[0_2px_6px_rgba(60,30,160,0.35)]",
    "<g>" +
      `<polygon points="${sparklePoints(36, 38, 16)}" fill="#ffffff"/>` +
      `<polygon points="${sparklePoints(20, 22, 6.5)}" fill="#ffffff"/>` +
      `<polygon points="${sparklePoints(53, 21, 5)}" fill="#ffffff"/>` +
      '<circle cx="55" cy="51" r="3.2" fill="#ffffff" opacity="0.85"/>' +
      '<circle cx="22" cy="51" r="2.2" fill="#ffffff" opacity="0.7"/>' +
      "</g>",
  );
}

const GLYPH_BUILDERS: Record<string, () => string> = {
  reminders: remindersGlyph,
  vmemos: voiceGlyph,
  notes: notesGlyph,
  clock: clockGlyph,
  calculator: calculatorGlyph,
  photos: photosGlyph,
  maps: mapsGlyph,
  contacts: contactsGlyph,
  ai: aiGlyph,
};

/** Full <svg> markup string for a bespoke tile; `null` for non-bespoke ids. */
export function bespokeGlyphSvg(id: string): string | null {
  const build = GLYPH_BUILDERS[id];
  return build ? build() : null;
}

