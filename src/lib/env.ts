import { z } from 'zod';

const BoolString = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().optional(),
  APP_URL: z.string().default('http://localhost:3100'),
  SESSION_SECRET: z.string().default('dev-secret-change-me'),
  COOKIE_SECURE: BoolString,
  SEED_PROFILE: z.string().default('core,demo'),
  ADMIN_EMAIL: z.string().default('admin@cadence.local'),
  ADMIN_PASSWORD: z.string().default('admin12345'),
  TWENTY_MODE: z.enum(['mock', 'graphql']).default('mock'),
  TWENTY_API_URL: z.string().optional(),
  TWENTY_API_KEY: z.string().optional(),
  TWENTY_WEBHOOK_SECRET: z.string().optional(),
  CADENCE_WEBHOOK_TOKEN: z.string().optional(),
  CADENCE_DRY_RUN: BoolString,
  WORKER_TICK_SECONDS: z.coerce.number().int().positive().default(300),
  RECONCILE_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  CACHE_REFRESH_HOUR: z.coerce.number().int().min(0).max(23).default(3),
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
    cached = parsed.data;
  }
  return cached;
}

/** Test helper: forget the cached env so changed process.env values are re-read. */
export function resetEnvCache() {
  cached = undefined;
}

export const isDryRun = () => env().CADENCE_DRY_RUN;
