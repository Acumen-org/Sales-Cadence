import { env } from '../env';
import { microsoftConfig } from '../auth/microsoft';
import { currentToken } from '../meetings/sharepoint-player';

/*
 * How a bell email leaves (owner, 21 Nov 2026: "a new Cadence mailbox"): Microsoft Graph's sendMail,
 * as the one mailbox named in Settings > Meetings and email, with Mail.Send that IT scopes to that
 * mailbox alone (RBAC for Applications, DEPLOY.md). Cadence still never emails a prospect: these go
 * to teammates only, about their own bell.
 *
 * Tests and the demo workspace use an outbox in memory instead (CADENCE_FAKE_MAIL=1, or under test).
 */

export type OutgoingMail = { from: string; to: string; subject: string; html: string; text: string };
export type SendResult = { ok: true } | { ok: false; error: string; permanent: boolean };

const g = globalThis as unknown as { __cadenceFakeMail?: OutgoingMail[] };
export const fakeOutbox = (): OutgoingMail[] => (g.__cadenceFakeMail ??= []);
export const usesFakeMail = () => process.env.CADENCE_FAKE_MAIL === '1' || process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export async function sendMail(mail: OutgoingMail, fetcher: typeof fetch = fetch): Promise<SendResult> {
  if (usesFakeMail()) { fakeOutbox().push(mail); return { ok: true }; }
  const config = await microsoftConfig();
  if (!config) return { ok: false, error: 'No Microsoft app is configured (Settings > Sign-in).', permanent: true };
  const token = await currentToken(config);
  if ('error' in token) return { ok: false, error: token.error, permanent: false };
  // Mail.Send granted by RBAC for Applications (DEPLOY.md) is not listed in the token, so Cadence asks
  // Microsoft and reports its answer rather than refusing on the token alone.
  const url = `${env().MICROSOFT_GRAPH_URL.replace(/\/+$/, '')}/v1.0/users/${encodeURIComponent(mail.from)}/sendMail`;
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { subject: mail.subject, body: { contentType: 'HTML', content: mail.html }, toRecipients: [{ emailAddress: { address: mail.to } }] },
        saveToSentItems: false,
      }),
    });
    if (res.status === 202 || res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    const why = (() => { try { return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body; } catch { return body; } })();
    // 403: the access policy does not allow this mailbox, or the permission is missing; 404: no such mailbox.
    const hint = res.status === 403 ? ' The app may not have Mail.Send for this mailbox yet (DEPLOY.md, "Email from Cadence").' : res.status === 404 ? ' Microsoft does not know this mailbox: check the address.' : '';
    return { ok: false, error: `Microsoft refused (${res.status}): ${why.slice(0, 300)}${hint}`, permanent: res.status === 403 || res.status === 404 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), permanent: false };
  }
}
