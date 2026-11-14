import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db';
import { env } from '../env';
import { logAudit, userActor } from '../audit';
import { getSettings, invalidateSettingsCache, isExternalEmail, saveSettingsSection } from '../settings';
import { workspaceTimezone } from '../workspace';

/**
 * Signing in with Microsoft (the organisation's Entra ID tenant), the team's way in.
 *
 * Someone already on the team signs in as themselves: matched by their Microsoft account once it
 * is known, else by their sign-in address or one of their aliases. Someone new joins as a Junior FO
 * with no title until an admin gives them one, but only with an address at one of our own domains.
 * Someone whose access an admin removed stays out. Passwords keep working until the first
 * sign-in through Microsoft succeeds, so a mistake in the app registration cannot lock the team out.
 */

export type MicrosoftConfig = { clientId: string; tenantId: string; clientSecret: string; loginUrl: string; redirectUri: string };

export type SignInErrorCode = 'microsoft' | 'expired' | 'removed' | 'outsider';

export class SignInError extends Error {
  constructor(readonly code: SignInErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'SignInError';
  }
}

/** The address Microsoft sends people back to; the app registration must list it. */
export const microsoftRedirectUri = () => `${env().APP_URL.replace(/\/+$/, '')}/api/auth/microsoft/callback`;

export async function microsoftConfig(): Promise<MicrosoftConfig | null> {
  const e = env();
  const { signIn } = await getSettings();
  const clientId = e.MICROSOFT_CLIENT_ID || signIn.microsoftClientId;
  const tenantId = e.MICROSOFT_TENANT_ID || signIn.microsoftTenantId;
  const clientSecret = e.MICROSOFT_CLIENT_SECRET || signIn.microsoftClientSecret;
  if (!clientId || !tenantId || !clientSecret) return null;
  return { clientId, tenantId: tenantId.toLowerCase(), clientSecret, loginUrl: e.MICROSOFT_LOGIN_URL.replace(/\/+$/, ''), redirectUri: microsoftRedirectUri() };
}

/** Which ways in the login page offers. */
export async function signInMethods(): Promise<{ microsoft: boolean; password: boolean }> {
  const [config, { signIn }] = await Promise.all([microsoftConfig(), getSettings()]);
  const microsoft = Boolean(config);
  return { microsoft, password: !microsoft || !signIn.passwordRetiredAt || env().PASSWORD_SIGN_IN };
}

/** One attempt's secrets: state ties the answer to this browser, nonce to this id token, PKCE to this code. */
export function newSignInAttempt() {
  const verifier = randomBytes(32).toString('base64url');
  return {
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export function authorizeUrl(c: MicrosoftConfig, a: { state: string; nonce: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: c.clientId, response_type: 'code', redirect_uri: c.redirectUri, response_mode: 'query',
    scope: 'openid profile email', state: a.state, nonce: a.nonce, code_challenge: a.challenge, code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${c.loginUrl}/${c.tenantId}/oauth2/v2.0/authorize?${q}`;
}

export type MicrosoftIdentity = { oid: string; addresses: string[]; name: string | null };

/**
 * Who the id token says signed in. The token comes straight from Microsoft's token endpoint over
 * TLS in exchange for our client secret, so its signature need not be checked again (OpenID
 * Connect Core 3.1.3.7); the audience, tenant, issuer, nonce and expiry are.
 */
export function readIdToken(idToken: string, c: Pick<MicrosoftConfig, 'clientId' | 'tenantId' | 'loginUrl'>, nonce: string, now = Date.now()): MicrosoftIdentity {
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')); }
  catch { throw new SignInError('microsoft', 'unreadable id token'); }
  const text = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string).trim() : '');
  const tid = text('tid').toLowerCase();
  if (text('aud') !== c.clientId) throw new SignInError('microsoft', 'id token for another app');
  if (tid !== c.tenantId.toLowerCase()) throw new SignInError('microsoft', 'id token from another tenant');
  if (text('iss').toLowerCase() !== `${c.loginUrl}/${tid}/v2.0`.toLowerCase()) throw new SignInError('microsoft', 'id token from another issuer');
  if (!nonce || text('nonce') !== nonce) throw new SignInError('microsoft', 'id token for another attempt');
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 < now - 60_000) throw new SignInError('expired', 'id token expired');
  const oid = text('oid');
  if (!oid) throw new SignInError('microsoft', 'id token without an account');
  const addresses = [...new Set([text('email'), text('preferred_username'), text('upn')].filter((a) => a.includes('@')).map((a) => a.toLowerCase()))];
  return { oid, addresses, name: text('name') || null };
}

/** Trade the code Microsoft sent back for the id token, and read it. */
export async function redeemCode(c: MicrosoftConfig, code: string, verifier: string, nonce: string): Promise<MicrosoftIdentity> {
  const res = await fetch(`${c.loginUrl}/${c.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, code_verifier: verifier, scope: 'openid profile email' }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err: unknown) => { throw new SignInError('microsoft', err instanceof Error ? err.message : String(err)); });
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown; error_description?: unknown };
  if (!res.ok || typeof body.id_token !== 'string') {
    throw new SignInError('microsoft', `${String(body.error ?? res.status)}: ${String(body.error_description ?? '').split(/\r?\n/)[0]}`);
  }
  return readIdToken(body.id_token, c, nonce);
}

/**
 * The Cadence account for a Microsoft sign-in: someone on the team, someone the CRM sync found
 * who has never had access (they join), or someone new at one of our domains (they join).
 */
export async function microsoftUser(identity: MicrosoftIdentity): Promise<{ id: string; name: string; email: string; joined: boolean }> {
  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true, aliases: true, active: true, microsoftId: true } });
  const owns = (u: (typeof users)[number]) => [u.email, ...u.aliases].some((a) => identity.addresses.includes(a.trim().toLowerCase()));
  const user = users.find((u) => u.microsoftId === identity.oid) ?? users.find((u) => u.active && owns(u)) ?? users.find(owns);
  const linkable = !users.some((u) => u.id !== user?.id && u.microsoftId === identity.oid);
  if (user?.active) {
    if (user.microsoftId !== identity.oid && linkable) await prisma.user.update({ where: { id: user.id }, data: { microsoftId: identity.oid } });
    return { id: user.id, name: user.name, email: user.email, joined: false };
  }
  if (user) {
    // An inactive account is either someone the CRM sync found, who never had access, or someone
    // an admin removed. Only the first may come in this way.
    const last = await prisma.auditLog.findFirst({ where: { entityType: 'user', entityId: user.id, action: { in: ['created', 'enabled', 'removed', 'restored'] } }, orderBy: { createdAt: 'desc' }, select: { action: true } });
    if (last?.action === 'removed') throw new SignInError('removed');
  }
  const { rules } = await getSettings();
  const ours = identity.addresses.find((a) => !isExternalEmail(a, rules.internalDomains));
  if (!user && !ours) throw new SignInError('outsider', identity.addresses.join(', '));
  const access = { active: true, role: 'JUNIOR_FO' as const, roleAssigned: false, timezone: workspaceTimezone(), dailyCap: null, ...(linkable ? { microsoftId: identity.oid } : {}) };
  const joined = user
    ? await prisma.user.update({ where: { id: user.id }, data: { ...access, ...(identity.name && user.name === user.email ? { name: identity.name } : {}) } })
    : await prisma.user.create({ data: { ...access, email: ours!, name: identity.name || ours!, passwordHash: '' } });
  await logAudit({ entityType: 'user', entityId: joined.id, action: 'joined', actor: userActor(joined), details: { via: 'microsoft', role: 'JUNIOR_FO' } });
  return { id: joined.id, name: joined.name, email: joined.email, joined: true };
}

/** The first sign-in through Microsoft proves it works; passwords stop working from then on. */
export async function retirePasswords(): Promise<void> {
  invalidateSettingsCache();
  const { signIn } = await getSettings();
  if (!signIn.passwordRetiredAt) await saveSettingsSection('signIn', { ...signIn, passwordRetiredAt: new Date().toISOString() });
}
