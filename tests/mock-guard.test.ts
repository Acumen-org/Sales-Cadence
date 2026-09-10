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
});
