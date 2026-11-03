import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { mockFingerprint, type MockState, type MockTwentyClient } from './mock-client';

/**
 * The built-in fake Twenty keeps its records in memory, and the web server and the worker are two
 * processes. Without a shared store each had its own fake: a person the web process created (a
 * move, a test's auto-created person) did not exist for the worker, so a move the worker picked up
 * failed with "The CRM person to attach to no longer exists". The fake's records now live in one
 * Setting row that every process reads before a call and writes after a call that changed them.
 *
 * Off under vitest (the suite drives the fake in-process and resets it per test) and when
 * MOCK_TWENTY_SHARED=0. Last writer wins between processes; this is a fake for development and the
 * browser tests, not a database.
 */

export const MOCK_STORE_KEY = 'mockTwenty.state';

type Stored = { fingerprint: string; state: MockState };

export function mockStoreEnabled(): boolean {
  return !process.env.VITEST && process.env.MOCK_TWENTY_SHARED !== '0';
}

type Tracked = { seen: number | null; queue: Promise<unknown> };
const tracked = new WeakMap<MockTwentyClient, Tracked>();
const trackOf = (mock: MockTwentyClient): Tracked => {
  let t = tracked.get(mock);
  if (!t) { t = { seen: null, queue: Promise.resolve() }; tracked.set(mock, t); }
  return t;
};

/** Load the shared records when another process changed them since this one last looked. */
export async function pullMock(mock: MockTwentyClient, key = MOCK_STORE_KEY): Promise<void> {
  const t = trackOf(mock);
  const row = await prisma.setting.findUnique({ where: { key }, select: { updatedAt: true } });
  if (!row || row.updatedAt.getTime() === t.seen) return;
  const full = await prisma.setting.findUnique({ where: { key } });
  if (!full) return;
  const stored = full.value as unknown as Stored;
  if (stored?.fingerprint === mockFingerprint(mock.dataset) && stored.state) mock.restore(stored.state);
  t.seen = full.updatedAt.getTime();
}

/** Save this process's records for the others. */
export async function pushMock(mock: MockTwentyClient, key = MOCK_STORE_KEY, state: MockState = mock.snapshot()): Promise<void> {
  const value = { fingerprint: mockFingerprint(mock.dataset), state } as unknown as Prisma.InputJsonValue;
  const row = await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  trackOf(mock).seen = row.updatedAt.getTime();
}

/** Run one call against the shared records: pull, call, and push when the records changed. One call at a time per process. */
export function withSharedMock<T>(mock: MockTwentyClient, call: () => Promise<T>, key = MOCK_STORE_KEY): Promise<T> {
  const t = trackOf(mock);
  const run = t.queue.then(async () => {
    await pullMock(mock, key);
    const before = mock.stateText();
    const result = await call();
    const after = mock.stateText();
    if (after !== before) await pushMock(mock, key, JSON.parse(after) as MockState);
    return result;
  });
  t.queue = run.catch(() => undefined);
  return run;
}

const AsyncFunction = (async () => undefined).constructor;

/** The fake as the app sees it: every async method goes through the shared store. */
export function sharedMock(mock: MockTwentyClient, key = MOCK_STORE_KEY): MockTwentyClient {
  return new Proxy(mock, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || !(value instanceof AsyncFunction)) return value;
      return (...args: unknown[]) => withSharedMock(target, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args), key);
    },
  });
}
