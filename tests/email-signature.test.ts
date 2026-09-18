import { describe, expect, it } from 'vitest';
import { crmEmailHtml } from '@/lib/rich-text';

/**
 * The gaps the owner saw on the hosted build came from signatures laid out as Outlook tables:
 * rows of empty cells and paragraphs holding one non-breaking space each. The reader gets the
 * signature's lines with at most one blank line between blocks, and every word kept.
 */
const SIGNATURE = `<div class="WordSection1"><p class="MsoNormal">Sounds good.</p><p class="MsoNormal">&nbsp;</p>
<p class="MsoNormal">See you Monday. Have a great week.</p><p class="MsoNormal">&nbsp;</p><p class="MsoNormal">Best,</p><p class="MsoNormal">Alisa</p>
<table class="MsoNormalTable" border="0" cellspacing="0" cellpadding="0"><tbody>
<tr><td><p class="MsoNormal"><b>Alisa Kolodizner CFP®</b></p></td></tr>
<tr><td><p class="MsoNormal">&nbsp;</p></td></tr>
<tr><td>&nbsp;</td></tr>
<tr><td><p class="MsoNormal"><span>&nbsp;</span></p></td></tr>
<tr><td><p class="MsoNormal">MANAGING DIRECTOR</p></td></tr>
<tr><td><p class="MsoNormal"><o:p>&nbsp;</o:p></p></td></tr>
<tr><td><p class="MsoNormal"><br></p></td></tr>
<tr><td><p class="MsoNormal">&nbsp;&nbsp;&nbsp;</p></td></tr>
<tr><td><p class="MsoNormal">C: 847-558-1464</p></td></tr>
<tr><td><p class="MsoNormal"><span style="color:white">&nbsp;</span></p></td></tr>
<tr><td><p class="MsoNormal">E: <a href="mailto:alisa@prairie-hill.com">alisa@prairie-hill.com</a></p></td></tr>
<tr><td></td></tr><tr><td></td></tr><tr><td></td></tr>
<tr><td><p class="MsoNormal">272 Market Sq Ste 211 Lake Forest, IL 60045</p></td></tr>
</tbody></table><p class="MsoNormal">&nbsp;</p><p class="MsoNormal">&nbsp;</p></div>`;

describe('email signatures laid out as tables', () => {
  it('keeps every line and never leaves more than one blank line between them', () => {
    const html = crmEmailHtml(SIGNATURE);
    for (const line of ['Sounds good.', 'See you Monday. Have a great week.', 'Best,', 'Alisa Kolodizner CFP®', 'MANAGING DIRECTOR', 'C: 847-558-1464', 'alisa@prairie-hill.com', '272 Market Sq Ste 211 Lake Forest, IL 60045']) expect(html).toContain(line);
    expect(html).not.toMatch(/(?:<br\s*\/?>\s*){3,}/i);
    expect(html).not.toMatch(/<p>(?:\s|&nbsp;| |<br\s*\/?>)*<\/p>/i);
    expect(html).not.toMatch(/<\/p>\s*<br/i);
    // Counting the visible line breaks between the name and the title: one blank line at most.
    const between = html.slice(html.indexOf('CFP®'), html.indexOf('MANAGING'));
    expect((between.match(/<br\s*\/?>|<\/p>/gi) ?? []).length).toBeLessThanOrEqual(3);
  });

  it('still trims the wrapper breaks at either end', () => {
    expect(crmEmailHtml('<div><br><br><p>Body</p><br><br></div>')).toBe('<p>Body</p>');
  });
});
