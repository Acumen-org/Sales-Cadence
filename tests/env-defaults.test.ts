import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache, testOnlyUrlProblem } from '@/lib/env';

const saved = { ...process.env };

describe('T41, T42: safer environment defaults', () => {
  afterEach(() => {
    for (const key of ['COOKIE_SECURE', 'APP_URL', 'CADENCE_DRY_RUN']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetEnvCache();
  });

  it('reads True and FALSE as booleans, refuses nonsense, and marks cookies secure on https when unset', () => {
    process.env.CADENCE_DRY_RUN = 'True';
    process.env.COOKIE_SECURE = '';
    process.env.APP_URL = 'https://cadence.example.com';
    resetEnvCache();
    expect(env().CADENCE_DRY_RUN).toBe(true);
    expect(env().COOKIE_SECURE).toBe(true);
    process.env.COOKIE_SECURE = 'FALSE';
    resetEnvCache();
    expect(env().COOKIE_SECURE).toBe(false);
    process.env.COOKIE_SECURE = 'maybe';
    resetEnvCache();
    expect(() => env()).toThrow(/COOKIE_SECURE/);
  });

  it('refuses a test-only address in production outside mock mode', () => {
    const base = { NODE_ENV: 'production', TWENTY_MODE: 'graphql', CADENCE_ALLOW_MOCK: undefined, MICROSOFT_LOGIN_URL: 'https://login.microsoftonline.com/', MICROSOFT_GRAPH_URL: 'https://graph.microsoft.com', TWILIO_API_URL: 'https://api.twilio.com' } as const;
    expect(testOnlyUrlProblem(base)).toBeNull();
    expect(testOnlyUrlProblem({ ...base, TWILIO_API_URL: 'http://evil.example' })).toMatch(/TWILIO_API_URL/);
    expect(testOnlyUrlProblem({ ...base, TWILIO_API_URL: 'http://127.0.0.1:3999', TWENTY_MODE: 'mock', CADENCE_ALLOW_MOCK: '1' })).toBeNull();
    expect(testOnlyUrlProblem({ ...base, NODE_ENV: 'test', MICROSOFT_GRAPH_URL: 'http://127.0.0.1:3997' })).toBeNull();
  });
});
