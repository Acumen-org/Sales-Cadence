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
