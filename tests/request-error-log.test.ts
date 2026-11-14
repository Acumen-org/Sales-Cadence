import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequestError } from '@/instrumentation';

const req = (path: string) => ({ path, method: 'GET', headers: { cookie: 'secret-session' } });
const ctx = { routerKind: 'App Router', routePath: '/(app)/tasks', routeType: 'render', renderSource: 'react-server-components' } as const;

describe('server errors are logged with the page they came from', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one CADENCE_REQUEST_ERROR line with path, route, digest and message, never headers', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new TypeError('Cannot read properties of undefined'), { digest: '12345' });
    await onRequestError(err, req('/tasks?view=mine') as never, ctx as never);
    expect(spy).toHaveBeenCalledTimes(1);
    const text = String(spy.mock.calls[0][0]);
    expect(text.startsWith('CADENCE_REQUEST_ERROR ')).toBe(true);
    const line = JSON.parse(text.slice('CADENCE_REQUEST_ERROR '.length));
    expect(line).toMatchObject({ path: '/tasks', route: '/(app)/tasks', digest: '12345', name: 'TypeError', message: 'Cannot read properties of undefined' });
    expect(text).not.toContain('secret-session');
  });

  it('skips the fake-action bot probes', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await onRequestError(new Error('The Server Reference ID did not match the expected format. Received "x".'), req('/') as never, ctx as never);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws, even for an odd error value', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onRequestError(null, req('/x') as never, ctx as never)).resolves.toBeUndefined();
  });
});
