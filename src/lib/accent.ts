/**
 * A record's character: one of six accents inside the brand palette, chosen by a hash of the
 * record's id so a person or account always looks the same to everyone. It colours the header
 * band, the avatar and the small labels on that page - nothing else. Deterministic rather than
 * random, because a record that changed colour on every visit would read as a different record.
 * The same hash picks the header's ornament - which motif, and the sizes inside it - so no two
 * records share a header while all of them stay inside one language.
 */
export type Accent = {
  name: 'moss' | 'sage' | 'clay' | 'slate' | 'plum' | 'sand';
  /** The header band's tint, and a deeper step of it where the band begins. */
  tint: string;
  mid: string;
  /** The saturated colour: the avatar fill, the ornament's strokes. */
  deep: string;
  /** The header band as Tailwind classes, for places that still compose it that way. */
  band: string;
  /** A ring around the avatar. */
  ring: string;
  /** Small labels and the stat figures on the page. */
  text: string;
  /** A tinted chip or pill background. */
  soft: string;
  /** The pattern colour, used at very low opacity. */
  pattern: string;
};

const ACCENTS: Accent[] = [
  { name: 'moss', tint: '#e3efe3', mid: '#cde2cf', deep: '#2f6a45', band: 'from-[#e3efe3] to-white', ring: 'ring-[#7fa88a]', text: 'text-[#2f6a45]', soft: 'bg-[#e3efe3] text-[#2f6a45]', pattern: '#2f6a45' },
  { name: 'sage', tint: '#e6ecdf', mid: '#d3dec6', deep: '#4b6a3c', band: 'from-[#e6ecdf] to-white', ring: 'ring-[#9bb08a]', text: 'text-[#4b6a3c]', soft: 'bg-[#e6ecdf] text-[#4b6a3c]', pattern: '#4b6a3c' },
  { name: 'clay', tint: '#f3e6dd', mid: '#e9d2c2', deep: '#8a4f2f', band: 'from-[#f3e6dd] to-white', ring: 'ring-[#c99a7e]', text: 'text-[#8a4f2f]', soft: 'bg-[#f3e6dd] text-[#8a4f2f]', pattern: '#8a4f2f' },
  { name: 'slate', tint: '#e3e8ee', mid: '#cdd8e3', deep: '#34506b', band: 'from-[#e3e8ee] to-white', ring: 'ring-[#8fa3b8]', text: 'text-[#34506b]', soft: 'bg-[#e3e8ee] text-[#34506b]', pattern: '#34506b' },
  { name: 'plum', tint: '#ece3ee', mid: '#dccde0', deep: '#5e3d6b', band: 'from-[#ece3ee] to-white', ring: 'ring-[#a98cb1]', text: 'text-[#5e3d6b]', soft: 'bg-[#ece3ee] text-[#5e3d6b]', pattern: '#5e3d6b' },
  { name: 'sand', tint: '#f1ead9', mid: '#e5dabd', deep: '#735a22', band: 'from-[#f1ead9] to-white', ring: 'ring-[#c2ad7d]', text: 'text-[#735a22]', soft: 'bg-[#f1ead9] text-[#735a22]', pattern: '#735a22' },
];

/** FNV-1a over the id: cheap, stable, spread evenly. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function accentFor(id: string): Accent {
  return ACCENTS[hashId(id) % ACCENTS.length];
}

export const MOTIFS = ['rings', 'dots', 'bars', 'waves', 'arcs'] as const;
export type Motif = (typeof MOTIFS)[number];
/** The ornament behind a record header: a motif and sixteen numbers in [0, 1) that size its shapes. */
export type RecordArt = { motif: Motif; values: number[] };

export function artFor(id: string): RecordArt {
  // A second hash so the motif is independent of the colour: moss records are not all rings.
  let h = hashId(`${id}#art`);
  const motif = MOTIFS[h % MOTIFS.length];
  const values: number[] = [];
  for (let i = 0; i < 16; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    values.push(((h ^ (h >>> 15)) >>> 0) / 4294967296);
  }
  return { motif, values };
}
