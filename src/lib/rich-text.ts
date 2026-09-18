import sanitizeHtml from 'sanitize-html';

/**
 * The same allow-list protects saved drafts, sequence copy and rendered CRM content - anything a
 * person did not type into this app themselves, which includes every note and message read back
 * from Twenty.
 *
 * Widening `allowedTags` or `allowedAttributes` is a security decision, not a formatting one: two
 * known `sanitize-html` bypasses are out of reach only because `textarea`, `svg` and `animate` are
 * absent here (see DECISIONS.md on the pinned version). `tests/rich-text-security.test.ts` fails if
 * that stops being true.
 */
export function cleanRichText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'blockquote'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  });
}

export function plainToHtml(text: string): string {
  return `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`;
}

/** Render imported mail without Outlook spacing, retaining every text block. */
export function crmEmailHtml(text: string): string {
  if (!/<(?:p|div|br|html|table|a|blockquote|span)\b/i.test(text)) {
    return cleanRichText(plainToHtml(text.replace(/\r\n?/g, '\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')));
  }
  // Convert layout containers before the strict sanitizer strips their tags, preserving boundaries.
  const structured = text.replace(/<\/?(?:div|section|article|tr|h[1-6])\b[^>]*>/gi, '<br>')
    .replace(/<\/(?:td|th)>/gi, ' ');
  // A signature laid out as a table arrives as rows of empty cells and paragraphs holding one
  // non-breaking space each. Every one of those is a blank line to the reader, so: empty
  // paragraphs go (however the emptiness is spelled), runs of breaks - with any spaces or
  // non-breaking spaces between them - fold to one blank line, and a paragraph boundary is its
  // own spacing, so breaks around it go too.
  const GAP = '(?:\\s|\\u00a0|&nbsp;|&#160;)';
  const BR = '<br\\s*\\/?>';
  return cleanRichText(structured)
    .replace(new RegExp(`<p>(?:${GAP}|${BR})*<\\/p>`, 'gi'), '')
    .replace(new RegExp(`(?:${BR}${GAP}*){3,}`, 'gi'), '<br><br>')
    .replace(new RegExp(`<\\/p>(?:${GAP}|${BR})*<p>`, 'gi'), '</p><p>')
    .replace(new RegExp(`<p>(?:${GAP}|${BR})+`, 'gi'), '<p>')
    .replace(new RegExp(`(?:${GAP}|${BR})+<\\/p>`, 'gi'), '</p>')
    .replace(new RegExp(`<p>(?:${GAP}|${BR})*<\\/p>`, 'gi'), '')
    // Indentation spelled as a run of non-breaking spaces is one space to the reader.
    .replace(/(?:\u00a0|&nbsp;|&#160;){2,}/gi, ' ')
    // The wrapper a mail client opens and closes with leaves a blank line at each end of the card.
    .replace(new RegExp(`^(?:${GAP}*${BR})+`, 'i'), '')
    .replace(new RegExp(`(?:${BR}${GAP}*)+$`, 'i'), '')
    .trim();
}
