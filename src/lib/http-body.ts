/**
 * Audit Q05, Q21: a request body as text, or null once it passes `max` bytes. Refused at once when
 * the declared length is over; otherwise read in pieces and abandoned as soon as it passes, so a
 * body sent without a length is never taken in whole first.
 */
export async function boundedText(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
