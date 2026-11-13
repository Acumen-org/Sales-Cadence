import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The built-in fake CRM is compiled into the app, because the client factory has to be able to
 * construct it. So the guarantee that a deployment cannot serve invented contacts to a sales team
 * is a runtime refusal, and this is the test of it.
 */
describe('mock mode is refused without an explicit opt-in', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when TWENTY_MODE=mock and CADENCE_ALLOW_MOCK is not set', async () => {
    process.env.CADENCE_ALLOW_MOCK = '';
    const { getTwentyClient } = await import('@/lib/twenty');
    await expect(getTwentyClient()).rejects.toThrow(/CADENCE_ALLOW_MOCK/);
    process.env.CADENCE_ALLOW_MOCK = '1';
  });

  it('serves the fake CRM once the opt-in is set', async () => {
    process.env.CADENCE_ALLOW_MOCK = '1';
    const { getTwentyClient } = await import('@/lib/twenty');
    await expect(getTwentyClient()).resolves.toBeTruthy();
  });

  it('N40: refuses the fake where a real CRM API key is configured, even with both switches set', async () => {
    process.env.CADENCE_ALLOW_MOCK = '1';
    process.env.TWENTY_API_KEY = 'a-real-key';
    try {
      const { getTwentyClient } = await import('@/lib/twenty');
      await expect(getTwentyClient()).rejects.toThrow(/API key is configured/);
    } finally {
      delete process.env.TWENTY_API_KEY;
    }
  });

  it('N41: a dry-run write is logged by name, without its content', async () => {
    const { DryRunTwentyClient } = await import('@/lib/twenty');
    const { getMockTwentyClient } = await import('@/lib/twenty/mock-client');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await new DryRunTwentyClient(getMockTwentyClient()).createNote({ title: 'Call with Jane', bodyMarkdown: 'jane@private.example 555-0100', personId: 'person-01' });
      const logged = info.mock.calls.map((c) => c.join(' ')).join(' ');
      expect(logged).toContain('createNote');
      expect(logged).not.toContain('jane@private.example');
    } finally {
      info.mockRestore();
    }
  });
});
