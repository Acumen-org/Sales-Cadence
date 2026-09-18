/**
 * A record's character: one of six accents inside the brand palette, chosen by a hash of the
 * record's id so a person or account always looks the same to everyone. It colours the header
 * band, the avatar ring and the small labels on that page - nothing else. Deterministic rather
 * than random, because a record that changed colour on every visit would read as a different record.
 */
export type Accent = {
  name: 'moss' | 'sage' | 'clay' | 'slate' | 'plum' | 'sand';
  /** The header band: a soft gradient from the accent's tint to the surface. */
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
  { name: 'moss', band: 'from-[#e3efe3] to-white', ring: 'ring-[#7fa88a]', text: 'text-[#2f6a45]', soft: 'bg-[#e3efe3] text-[#2f6a45]', pattern: '#2f6a45' },
  { name: 'sage', band: 'from-[#e6ecdf] to-white', ring: 'ring-[#9bb08a]', text: 'text-[#4b6a3c]', soft: 'bg-[#e6ecdf] text-[#4b6a3c]', pattern: '#4b6a3c' },
  { name: 'clay', band: 'from-[#f3e6dd] to-white', ring: 'ring-[#c99a7e]', text: 'text-[#8a4f2f]', soft: 'bg-[#f3e6dd] text-[#8a4f2f]', pattern: '#8a4f2f' },
  { name: 'slate', band: 'from-[#e3e8ee] to-white', ring: 'ring-[#8fa3b8]', text: 'text-[#34506b]', soft: 'bg-[#e3e8ee] text-[#34506b]', pattern: '#34506b' },
  { name: 'plum', band: 'from-[#ece3ee] to-white', ring: 'ring-[#a98cb1]', text: 'text-[#5e3d6b]', soft: 'bg-[#ece3ee] text-[#5e3d6b]', pattern: '#5e3d6b' },
  { name: 'sand', band: 'from-[#f1ead9] to-white', ring: 'ring-[#c2ad7d]', text: 'text-[#735a22]', soft: 'bg-[#f1ead9] text-[#735a22]', pattern: '#735a22' },
];

/** FNV-1a over the id: cheap, stable, spread evenly across the six. */
export function accentFor(id: string): Accent {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ACCENTS[h % ACCENTS.length];
}
