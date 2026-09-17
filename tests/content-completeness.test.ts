import { expect, it } from 'vitest';
import { crmEmailHtml } from '@/lib/rich-text';
import { normalizeNote } from '@/lib/twenty/normalize';
import { mergeTwentySchema } from '@/lib/twenty/twenty-schema';

/** The live default mapping, as every other suite builds it. */
const schema = mergeTwentySchema();

it('keeps long notes and nested BlockNote content through the final paragraph', () => {
  const tail = 'FINAL PARAGRAPH: follow up after committee review.';
  const text = 'Full notes. '.repeat(300) + tail;
  expect(normalizeNote({ bodyV2: { markdown: text } }, schema).bodyMarkdown).toBe(text);
  const blocks = [{ id: 'one', content: [{ text: text }], children: [{ id: 'two', content: [{ type: 'link', content: [{ text: 'Nested decision' }] }] }] }];
  const note = normalizeNote({ bodyV2: { markdown: 'Short imported summary', blocknote: JSON.stringify(blocks) } }, schema);
  expect(note.bodyMarkdown).toContain(tail);
  expect(note.bodyMarkdown).toContain('Nested decision');
  expect(note.bodyMarkdown).not.toContain('"content"');
});
it('compacts mail spacing without losing paragraphs, quoted text or links', () => {
  const output = crmEmailHtml('<div>First paragraph</div><p>&nbsp;</p><p><br></p><br><br><br><br><blockquote>Prior reply</blockquote><div>Last paragraph <a href="https://example.com">Details</a></div>');
  for (const text of ['First paragraph', 'Prior reply', 'Last paragraph', 'https://example.com']) expect(output).toContain(text);
  expect(output).not.toContain('&nbsp;');
  expect(output).not.toMatch(/(?:<br>){3}/);
  expect(crmEmailHtml('First\n\n\n\nLast')).toBe('<p>First<br /><br />Last</p>');
});
it('imported mail cannot inject executable markup or tracking images', () => {
  const output = crmEmailHtml('<div onclick="alert(1)">Keep me</div><script>alert(1)</script><img src="https://tracker.com"><a href="javascript:alert(1)">Link</a>');
  expect(output).toContain('Keep me');
  expect(output).not.toMatch(/onclick|<script|<img|javascript:/);
});
it('a mail card starts on its first line and ends on its last', () => {
  const output = crmEmailHtml('<div class="WordSection1"><p>Body</p></div><br><br>');
  expect(output).toContain('Body');
  expect(output.startsWith('<br')).toBe(false);
  expect(/<br\s*\/?>\s*$/i.test(output)).toBe(false);
});
