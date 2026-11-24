/*
 * The meetings bar of the morning summary, as a small animated picture (owner, 24 Nov 2026: "exciting,
 * with some animation"). Mail apps run no script and most drop CSS animation, but nearly all play an
 * animated GIF, Outlook included. The bar grows in, leans at its leading edge like the Meetings
 * scoreboard's bars, then one light passes along it; it plays once and stays on its last frame. A
 * light and a dark one are sent, and the dark mode rules swap them like the wordmark.
 *
 * Drawn at twice the size shown, so it stays sharp on phones and high-density screens. Each frame
 * after the first holds only the strip that changed, which keeps the picture a few kilobytes.
 */

export const BAR_WIDTH = 502;
export const BAR_HEIGHT = 14;
const SCALE = 2;
const W = BAR_WIDTH * SCALE;
const H = BAR_HEIGHT * SCALE;
const R = H / 2;
const LEAN = 7 * SCALE;
const NOTCH = 2 * SCALE;

type Rgb = [number, number, number];
export type BarColours = { track: Rgb; notch: Rgb; from: Rgb; to: Rgb };
export const BAR_LIGHT: BarColours = { track: [0xe4, 0xea, 0xe7], notch: [0xff, 0xff, 0xff], from: [0x1f, 0x6b, 0x57], to: [0x2f, 0x9c, 0x7c] };
export const BAR_DARK: BarColours = { track: [0x33, 0x40, 0x3b], notch: [0x24, 0x2a, 0x28], from: [0x1f, 0x6b, 0x57], to: [0x3a, 0xa8, 0x83] };

const GRADIENT_STEPS = 32; // with the shine's steps, well inside a GIF's 256 colours
const SHINE_STEPS = 6;
const SHINE_ALPHA = 0.38;
/** Timing in hundredths of a second, as GIF counts it. */
const START_DELAY = 45;
const GROW_FRAMES = 26;
const SHINE_FRAMES = 20;
const FRAME_DELAY = 5;
const HOLD_BEFORE_SHINE = 10;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Inside the track: a rounded bar, ends of radius R. */
function inTrack(x: number, y: number): boolean {
  const cy = y + 0.5 - R;
  if (x < R) { const cx = x + 0.5 - R; return cx * cx + cy * cy <= R * R; }
  if (x >= W - R) { const cx = x + 0.5 - (W - R); return cx * cx + cy * cy <= R * R; }
  return true;
}
const NOTCHES = [0.25, 0.5, 0.75].map((f) => Math.round(W * f) - NOTCH / 2);
const isNotch = (x: number) => NOTCHES.some((n) => x >= n && x < n + NOTCH);

/** One frame as palette indices; the palette grows as colours appear. Index 0 is see-through. */
function frame(fillW: number, finalW: number, shineAt: number | null, c: BarColours, palette: Map<number, number>, colours: Rgb[]): Uint8Array {
  const px = new Uint8Array(W * H);
  const index = (rgb: Rgb) => {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    let i = palette.get(key);
    if (i === undefined) { i = colours.length; colours.push(rgb); palette.set(key, i); }
    return i;
  };
  const band = finalW * 0.4;
  for (let y = 0; y < H; y++) {
    // The leading edge leans: full width at the top, LEAN short at the bottom.
    const edge = fillW - (LEAN * y) / (H - 1);
    for (let x = 0; x < W; x++) {
      let i: number;
      if (!inTrack(x, y)) i = 0;
      else if (isNotch(x)) i = index(c.notch);
      else if (fillW > 0 && x < edge) {
        const g = Math.round((Math.min(1, x / Math.max(1, finalW)) * (GRADIENT_STEPS - 1))) / (GRADIENT_STEPS - 1);
        let rgb: Rgb = [0, 1, 2].map((k) => c.from[k] + (c.to[k] - c.from[k]) * g) as Rgb;
        if (shineAt !== null) {
          const d = Math.abs(x - shineAt) / (band / 2);
          if (d < 1) {
            const a = Math.round((1 - d) * SHINE_STEPS) / SHINE_STEPS * SHINE_ALPHA;
            rgb = rgb.map((v) => v + (255 - v) * a) as Rgb;
          }
        }
        i = index(rgb.map((v) => Math.round(v)) as Rgb);
      } else i = index(c.track);
      px[y * W + x] = i;
    }
  }
  return px;
}

/** The animated bar for `share` (0 to 1) of the goal, as GIF bytes. */
export function meetingsBarGif(share: number, c: BarColours): Uint8Array {
  const finalW = Math.round(W * Math.max(0, Math.min(1, share)));
  const palette = new Map<number, number>();
  const colours: Rgb[] = [[0, 0, 0]];
  const frames: { px: Uint8Array; delay: number }[] = [];
  if (finalW === 0) frames.push({ px: frame(0, 0, null, c, palette, colours), delay: 0 });
  else {
    frames.push({ px: frame(0, finalW, null, c, palette, colours), delay: START_DELAY });
    for (let i = 1; i <= GROW_FRAMES; i++) {
      frames.push({ px: frame(Math.round(finalW * easeOut(i / GROW_FRAMES)), finalW, null, c, palette, colours), delay: i === GROW_FRAMES ? HOLD_BEFORE_SHINE : FRAME_DELAY });
    }
    const band = finalW * 0.4;
    for (let i = 0; i <= SHINE_FRAMES; i++) {
      // From just before the bar to just past its end; the last frame is the plain bar again.
      const at = i === SHINE_FRAMES ? null : -band / 2 + ((finalW + band) * i) / (SHINE_FRAMES - 1);
      frames.push({ px: frame(finalW, finalW, at, c, palette, colours), delay: FRAME_DELAY });
    }
  }
  return encodeGif(W, H, colours, frames);
}

/** A GIF89a that plays once: a global palette, see-through index 0, each later frame only the changed strip. */
export function encodeGif(width: number, height: number, colours: Rgb[], frames: { px: Uint8Array; delay: number }[]): Uint8Array {
  if (colours.length > 256) throw new Error(`The bar has ${colours.length} colours; a GIF holds 256.`);
  let bits = 1;
  while (1 << bits < colours.length) bits++;
  const out: number[] = [];
  const u16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  out.push(...[...'GIF89a'].map((ch) => ch.charCodeAt(0)));
  u16(width); u16(height);
  out.push(0x80 | 0x70 | (bits - 1), 0, 0);
  for (let i = 0; i < 1 << bits; i++) out.push(...(colours[i] ?? [0, 0, 0]));
  let prev: Uint8Array | null = null;
  for (const f of frames) {
    // The strip that changed since the last frame (all of the first).
    let x0 = 0, y0 = 0, x1 = width - 1, y1 = height - 1;
    if (prev) {
      x0 = width; y0 = height; x1 = -1; y1 = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (f.px[y * width + x] !== prev[y * width + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const sub = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sub[y * w + x] = f.px[(y + y0) * width + x + x0];
    // Graphic control: keep what is there (disposal 1), index 0 see-through, the frame's delay.
    out.push(0x21, 0xf9, 0x04, (1 << 2) | 1); u16(f.delay); out.push(0, 0);
    out.push(0x2c); u16(x0); u16(y0); u16(w); u16(h); out.push(0);
    const minCode = Math.max(2, bits);
    out.push(minCode);
    const data = lzw(sub, minCode);
    for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); out.push(n); for (let k = 0; k < n; k++) out.push(data[i + k]); }
    out.push(0);
    prev = f.px;
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

/** GIF's variable-length LZW, codes packed least significant bit first. */
function lzw(indices: Uint8Array, minCode: number): number[] {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let next = eoi + 1;
  let size = minCode + 1;
  let table = new Map<number, number>();
  const bytes: number[] = [];
  let cur = 0, shift = 0;
  const emit = (code: number) => {
    cur |= code << shift; shift += size;
    while (shift >= 8) { bytes.push(cur & 0xff); cur >>>= 8; shift -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1; size = minCode + 1; table = new Map();
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) bytes.push(cur & 0xff);
  return bytes;
}
