/**
 * Note text the way a reader wants it. Twenty's markdown summary of a note can carry table
 * syntax - a one-column table of call log lines arrives as `| --- |` separator rows and cells
 * wrapped in pipes - and runs of blank lines. The reader gets the cells' words, one row per line,
 * with a single blank line at most between paragraphs. Nothing is invented and no word is lost.
 */
const SEPARATOR_ROW = /^\s*\|?[\s|:-]*\|\s*$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;

export function presentNoteBody(body: string | null | undefined): string {
  if (!body) return '';
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    if (SEPARATOR_ROW.test(line) && /-/.test(line)) return null;
    const row = TABLE_ROW.exec(line);
    if (!row) return line.replace(/ /g, ' ').trimEnd();
    const cells = row[1].split('|').map((c) => c.replace(/ /g, ' ').trim()).filter(Boolean);
    return cells.length ? cells.join(' · ') : null;
  });
  return lines.filter((line): line is string => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
