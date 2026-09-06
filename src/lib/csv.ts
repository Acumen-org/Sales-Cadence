/**
 * Extract Twenty person ids from pasted text or a CSV export.
 * - one id per line, or comma/semicolon/tab separated
 * - CSV with a header: uses the column named id / personId / person_id / twenty id
 * - CSV without a header: first column
 */
const ID_HEADER = /^(id|person ?id|person_id|twenty ?id|record ?id)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parsePersonIds(text: string): { ids: string[]; skipped: number; column: string | null } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { ids: [], skipped: 0, column: null };
  const rows = lines.map(splitRow);
  let column: string | null = null;
  let colIndex = 0;
  let start = 0;
  const header = rows[0];
  const headerIdx = header.findIndex((c) => ID_HEADER.test(c));
  if (headerIdx >= 0) {
    column = header[headerIdx];
    colIndex = headerIdx;
    start = 1;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const clean = (v: string) => v.replace(/^"|"$/g, '').trim();
  // A pasted list (no header, every cell is an id-shaped token) may have several ids per line.
  const body = rows.slice(start);
  const pastedList = column === null && body.every((cells) => cells.every((c) => looksLikeTwentyId(clean(c))));
  for (const cells of body) {
    const values = pastedList ? cells.map(clean) : [clean(cells[colIndex] ?? '')];
    for (const value of values) {
      if (!value || (/\s/.test(value) && !UUID.test(value))) {
        skipped += 1;
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      ids.push(value);
    }
  }
  return { ids, skipped, column };
}

export function looksLikeTwentyId(value: string): boolean {
  return UUID.test(value) || /^[A-Za-z0-9_-]{3,64}$/.test(value);
}
