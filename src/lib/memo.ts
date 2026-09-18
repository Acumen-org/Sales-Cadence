/**
 * A value kept for a few seconds inside one server process. For option lists and other things
 * that change rarely and are read on every render; never for a number the page shows.
 */
const store = new Map<string, { until: number; value: Promise<unknown> }>();

export function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.until > now) return hit.value as Promise<T>;
  const value = load().catch((error) => { store.delete(key); throw error; });
  store.set(key, { until: now + ttlMs, value });
  return value;
}

export function forgetMemo(prefix?: string) {
  for (const key of [...store.keys()]) if (!prefix || key.startsWith(prefix)) store.delete(key);
}
