import { createHash } from 'node:crypto';

/**
 * S18: which transcript an edit form was opened on, as a short fingerprint the form sends back, so a
 * save can tell "left as it was" from "changed" without sending the transcript twice.
 */
export function transcriptKey(text: string | null | undefined): string {
  return createHash('sha256').update((text ?? '').trim()).digest('hex').slice(0, 32);
}
