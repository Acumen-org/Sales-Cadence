import type { Instrumentation } from 'next';

/**
 * Production hides a server error's message from the page ("An error occurred in the Server
 * Components render ... digest"). Next prints it to stderr too, but without the page it came from,
 * so a failure is hard to find in the Nomad log. This writes one greppable line per server error:
 * `CADENCE_REQUEST_ERROR {json}` with the path, route, digest, message and the top of the stack.
 * Nothing about the request beyond its path and method is logged (no headers, no body).
 */

// Bots probing for old Next.js action flaws send a fake action id; Next refuses it and logs it already.
const PROBE_NOISE = /Server Reference ID did not match|Failed to find Server Action/i;

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  try {
    const e = (err ?? {}) as { name?: string; message?: string; stack?: string; digest?: string; code?: string };
    const message = String(e.message ?? err);
    if (PROBE_NOISE.test(message)) return;
    const line = {
      at: new Date().toISOString(),
      method: request.method,
      path: String(request.path).split('?')[0],
      route: context.routePath,
      routeType: context.routeType,
      renderSource: (context as { renderSource?: string }).renderSource,
      digest: e.digest,
      name: e.name,
      code: e.code,
      message: message.slice(0, 2000),
      stack: e.stack?.split('\n').slice(0, 15).join('\n'),
    };
    console.error('CADENCE_REQUEST_ERROR ' + JSON.stringify(line));
  } catch {
    // Logging must never become a second failure.
  }
};
