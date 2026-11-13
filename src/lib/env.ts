import { z } from 'zod';

/** T41: `True` or ` false ` mean what they say; anything else is refused when the process starts. */
const BoolString = z
  .preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['true', 'false', '1', '0', '']).optional())
  .transform((v) => v === 'true' || v === '1');

/** T42: where these live, unless a test (mock mode) points them at a stand-in. */
const TEST_ONLY_URLS = {
  MICROSOFT_LOGIN_URL: 'https://login.microsoftonline.com',
  MICROSOFT_GRAPH_URL: 'https://graph.microsoft.com',
  TWILIO_API_URL: 'https://api.twilio.com',
} as const;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().optional(),
  APP_URL: z.string().default('http://localhost:3100'),
  COOKIE_SECURE: BoolString,
  SEED_PROFILE: z.string().default('core'),
  ADMIN_EMAIL: z.string().default('admin@cadence.local'),
  ADMIN_PASSWORD: z.string().default(''),
  TWENTY_MODE: z.enum(['mock', 'graphql']).default('graphql'),
  /** Must be 1 for TWENTY_MODE=mock to be honoured. The test runners and the local launcher set it. */
  CADENCE_ALLOW_MOCK: z.string().optional(),
  TWENTY_API_URL: z.string().optional(),
  TWENTY_API_KEY: z.string().optional(),
  TWENTY_WEBHOOK_SECRET: z.string().optional(),
  CADENCE_WEBHOOK_TOKEN: z.string().optional(),
  /** 1 lets a production deployment accept unsigned webhooks. Off unless you mean it. */
  CADENCE_WEBHOOK_OPEN: z.string().optional(),
  CADENCE_DRY_RUN: BoolString,
  /** Microsoft sign-in. Each overrides what an admin saved under Settings > Sign-in. */
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** Where Microsoft's sign-in pages live. Only a test points it elsewhere. */
  MICROSOFT_LOGIN_URL: z.string().default(TEST_ONLY_URLS.MICROSOFT_LOGIN_URL),
  /** Where Microsoft Graph lives, which names the file behind a SharePoint sharing link. Only a test points it elsewhere. */
  MICROSOFT_GRAPH_URL: z.string().default(TEST_ONLY_URLS.MICROSOFT_GRAPH_URL),
  /** true brings password sign-in back after Microsoft took over, if Microsoft sign-in ever fails. */
  PASSWORD_SIGN_IN: BoolString,
  /** The key Bellwether sends in X-Cadence-Api-Key. Unset: every Bellwether call gets 503 integration_disabled. */
  BELLWETHER_API_KEY: z.string().optional(),
  /** The previous key, accepted too while a rotation is under way. */
  BELLWETHER_API_KEY_PREVIOUS: z.string().optional(),
  /**
   * The read API (/api/v1) learns the caller's address from X-Forwarded-For: how many proxies in
   * front of Cadence append to it (1 behind one Caddy or nginx). 0: the address is unknown, so a key
   * with an IP allowlist is refused rather than trusting a header anyone can send.
   */
  API_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Twilio, read only: the account behind the hosted dialpad and a Restricted API key made for Cadence. */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  /** Where Twilio's REST API lives. Only a test points it elsewhere. */
  TWILIO_API_URL: z.string().default(TEST_ONLY_URLS.TWILIO_API_URL),
  /** h00ks partner API key with staff:read: which rep has which Twilio number. Empty: numbers are assigned in Settings > Calling. */
  H00KS_API_TOKEN: z.string().optional(),
  H00KS_API_URL: z.string().default('https://h00ks.acm.acumen-strategy.com/api/partner/v1'),
  /** 1 uses the in-memory Twilio stand-in (tests and the local launcher); refused in production unless mock mode is allowed. */
  CADENCE_FAKE_TWILIO: z.string().optional(),
  /** true turns on reading the sales mailboxes through Microsoft Graph (application Mail.Read). Off when unset. */
  GRAPH_MAIL_ENABLED: BoolString,
  /**
   * The LinkedIn Console (read only). Its address (also used for "Open in Console" links), the API key
   * it issued for Cadence's event feed, and the secret its signed webhooks carry. Unset: no feed is read
   * and the webhook answers 503.
   */
  LINKEDIN_CONSOLE_URL: z.string().optional(),
  LINKEDIN_CONSOLE_API_KEY: z.string().optional(),
  LINKEDIN_CONSOLE_WEBHOOK_SECRET: z.string().optional(),
  WORKER_TICK_SECONDS: z.coerce.number().int().positive().default(300),
  CRM_SYNC_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  RECONCILE_HOUR: z.coerce.number().int().min(0).max(23).default(2),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parsed process environment. Lazy so `next build` works without a full .env. */
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment: ${parsed.error.message}`);
    }
    const problem = testOnlyUrlProblem(parsed.data);
    if (problem) throw new Error(`Invalid environment: ${problem}`);
    // T41: unset, cookies are marked secure whenever the app is served over https.
    if (!process.env.COOKIE_SECURE?.trim()) parsed.data.COOKIE_SECURE = parsed.data.APP_URL.startsWith('https://');
    cached = parsed.data;
  }
  return cached;
}

/** T42: in production, outside mock mode, the test-only addresses cannot point anywhere else. */
export function testOnlyUrlProblem(e: Pick<Env, 'NODE_ENV' | 'TWENTY_MODE' | 'CADENCE_ALLOW_MOCK' | keyof typeof TEST_ONLY_URLS>): string | null {
  if (e.NODE_ENV !== 'production' || (e.TWENTY_MODE === 'mock' && e.CADENCE_ALLOW_MOCK === '1')) return null;
  const changed = (Object.keys(TEST_ONLY_URLS) as (keyof typeof TEST_ONLY_URLS)[]).filter((key) => e[key].replace(/\/+$/, '') !== TEST_ONLY_URLS[key]);
  return changed.length ? `${changed.join(', ')} may only point elsewhere in test (mock) mode; remove ${changed.length > 1 ? 'them' : 'it'} in production` : null;
}

/** Test helper: forget the cached env so changed process.env values are re-read. */
export function resetEnvCache() {
  cached = undefined;
}

export const isDryRun = () => env().CADENCE_DRY_RUN;
