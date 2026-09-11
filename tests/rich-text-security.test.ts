import { describe, expect, it } from 'vitest';
import { cleanRichText } from '@/lib/rich-text';

/**
 * The sanitiser guards everything a person did not write themselves: a pasted email body, a
 * sequence's copy, and the CRM notes and messages Cadence renders from Twenty. Anyone who can
 * write a note in the CRM can therefore reach it, so it is tested against the payloads from the
 * advisories rather than trusted because of a version number.
 *
 * `sanitize-html` is pinned to 2.17.5: 2.17.6 and 2.17.7 require htmlparser2 v12, which ships
 * ESM only while sanitize-html's own build is CommonJS, so they cannot be loaded here at all.
 * These cases prove the two advisories patched after 2.17.5 are not reachable through this
 * configuration, and will fail if the allow-list is ever widened to make them reachable.
 */

/** Nothing that executes, navigates to a script, or smuggles a handler may survive. */
function expectInert(html: string) {
  const out = cleanRichText(html);
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toMatch(/javascript:/i);
  expect(out).not.toMatch(/\son\w+\s*=/i);
  expect(out).not.toMatch(/<svg|<animate|<textarea|<form|<object|<video|<iframe|<img/i);
  return out;
}

describe('the rich-text sanitiser holds against the known bypasses', () => {
  // GHSA-jxwj-j7wr-gfrw, patched upstream in 2.17.6: a literal `</textarea/>` closes the element
  // early in a permissive parser, letting what follows escape the allow-list.
  it('does not let a solidus-closed textarea smuggle markup past the allow-list', () => {
    expectInert('<textarea/><script>alert(1)</script>');
    expectInert('<p>hi</p><textarea/></textarea/><img src=x onerror=alert(1)>');
    expectInert('<textarea></textarea/><a href="javascript:alert(1)">click</a>');
  });

  // GHSA-g8qq-57p8-ggw5, patched upstream in 2.17.7: SVG SMIL animates an attribute to a
  // javascript: URI, which a scheme policy applied only at parse time never sees.
  it('drops SVG and its SMIL animation entirely', () => {
    expectInert('<svg><a><animate attributeName="href" values="javascript:alert(1)" /><text>x</text></a></svg>');
    expectInert('<svg><set attributeName="href" to="javascript:alert(1)" /></svg>');
  });

  // GHSA-vccv-cmxp-4j9h, patched upstream in 2.17.5: javascript: through attributes the scheme
  // policy did not cover.
  it('drops the attributes that carried javascript: URIs', () => {
    expectInert('<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button></form>');
    expectInert('<video poster="javascript:alert(1)"></video>');
    expectInert('<body background="javascript:alert(1)">x</body>');
    expectInert('<object data="javascript:alert(1)"></object>');
  });

  it('still refuses the ordinary ways in', () => {
    expectInert('<a href="javascript:alert(1)">click</a>');
    expectInert('<a href="JaVaScRiPt:alert(1)">click</a>');
    expectInert('<a href="&#106;avascript:alert(1)">click</a>');
    expectInert('<p onclick="alert(1)">text</p>');
    expectInert('<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>');
  });

  it('keeps the copy an FO actually writes', () => {
    const out = cleanRichText('<p>Hi <strong>Nina</strong>,</p><p>Worth <em>15 minutes</em>? <a href="https://acumen-strategy.com">Our note</a></p><ul><li>One</li></ul>');
    expect(out).toContain('<strong>Nina</strong>');
    expect(out).toContain('<em>15 minutes</em>');
    expect(out).toContain('<li>One</li>');
    // Links survive, and leave with the protection the transform adds.
    expect(out).toContain('href="https://acumen-strategy.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('keeps mailto and http links, which the composer relies on', () => {
    expect(cleanRichText('<a href="mailto:x@y.com">mail</a>')).toContain('href="mailto:x@y.com"');
    expect(cleanRichText('<a href="http://example.com">http</a>')).toContain('href="http://example.com"');
  });
});
