import { describe, expect, it, vi } from 'vitest';
import { RulesSettingsSchema } from '@/lib/settings';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Click-to-call is a workspace setting rather than a hardcoded host: Cadence posts to whatever
 * the team owns. Blank is the normal state and must stay valid, because the task screen falls
 * back to a tel: link rather than showing a button that does nothing.
 */
describe('click-to-call endpoint setting', () => {
  const parse = (clickToCallUrl: string) => RulesSettingsSchema.safeParse({ clickToCallUrl });

  it('defaults to blank, so nothing is wired up until an admin says so', () => {
    const parsed = RulesSettingsSchema.parse({});
    expect(parsed.clickToCallUrl).toBe('');
  });

  it('accepts an http(s) endpoint and trims it', () => {
    expect(parse('  https://h00ks.example.com/call  ').success).toBe(true);
    expect(RulesSettingsSchema.parse({ clickToCallUrl: '  https://h00ks.example.com/call  ' }).clickToCallUrl).toBe('https://h00ks.example.com/call');
    expect(parse('http://localhost:4000/dial').success).toBe(true);
  });

  it('refuses anything that is not an http(s) URL rather than storing it', () => {
    for (const bad of ['h00ks.example.com/call', 'javascript:alert(1)', 'ftp://example.com', 'not a url']) {
      expect(parse(bad).success, bad).toBe(false);
    }
  });
});
