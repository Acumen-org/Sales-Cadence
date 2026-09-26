/**
 * The colour of a bar that fills towards a whole: a light green while it is nearly empty, the
 * brand's deep evergreen once it is full (owner, 26 September 2026: the bar "should get
 * progressively darker as it reaches 100%", and the same for every bar). One scale for every bar
 * in Cadence, so a darker bar always means further along, wherever it is.
 *
 * Plain hex, not a class: the Reports charts render into an exported HTML file with no stylesheet.
 */
const ON_LIGHT = ['#82c4ac', '#50a68b', '#2f8a70', '#24735e', '#1d4a3f'];
/** On a dark band the deep end would vanish into the band, so it runs from pale to a full lime. */
const ON_DARK = ['#eef6dc', '#d5e9ad', '#b8db7c', '#9ccf55'];

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (channels: number[]) => `#${channels.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

export function barColour(fraction: number, surface: 'light' | 'dark' = 'light'): string {
  const stops = surface === 'dark' ? ON_DARK : ON_LIGHT;
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const at = f * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(at));
  const [a, b] = [rgb(stops[i]), rgb(stops[i + 1])];
  return hex(a.map((c, k) => c + (b[k] - c) * (at - i)));
}
