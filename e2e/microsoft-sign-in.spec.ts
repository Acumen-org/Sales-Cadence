import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { expect, test, type Page } from '@playwright/test';

/**
 * Signing in with Microsoft, end to end: the login page, the trip to Microsoft and back, the
 * session. Microsoft's sign-in pages are played by a small server here, which signs in whichever
 * account the test names and checks what the app sends it as Microsoft would (the secret, PKCE).
 * `pnpm test:fresh` runs it on a fresh install pointed at this stand-in.
 */
test.describe.configure({ mode: 'serial' });

const CLIENT_ID = '0f0f0f0f-0000-4000-8000-00000000c1d0';
const TENANT = '0e0e0e0e-0000-4000-8000-0000000071d0';
const SECRET = 'stand-in-secret';
const ORIGIN = new URL(process.env.E2E_MICROSOFT_LOGIN_URL ?? 'http://127.0.0.1:3998');

type Account = { oid: string; email: string; name: string };
let account: Account = { oid: 'oid-admin', email: 'admin@cadence.local', name: 'Admin' };
const grants = new Map<string, { nonce: string; challenge: string; redirectUri: string; account: Account }>();
let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', ORIGIN);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && url.pathname === `/${TENANT}/oauth2/v2.0/authorize`) {
      const q = url.searchParams;
      if (q.get('client_id') !== CLIENT_ID || q.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      const code = randomUUID();
      grants.set(code, { nonce: q.get('nonce') ?? '', challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? '', account: { ...account } });
      const back = new URL(q.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (req.method === 'POST' && url.pathname === `/${TENANT}/oauth2/v2.0/token`) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const grant = grants.get(form.get('code') ?? '');
        grants.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!grant || form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== SECRET || form.get('redirect_uri') !== grant.redirectUri
          || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(400, { error: 'invalid_grant' });
        const claims = {
          aud: CLIENT_ID, tid: TENANT, iss: `${ORIGIN.origin}/${TENANT}/v2.0`, nonce: grant.nonce, exp: Math.floor(Date.now() / 1000) + 3600,
          oid: grant.account.oid, preferred_username: grant.account.email, name: grant.account.name,
        };
        json(200, { token_type: 'Bearer', id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.stand-in` });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(Number(ORIGIN.port), ORIGIN.hostname, resolve));
});

test.afterAll(async () => { await new Promise((resolve) => server?.close(resolve)); });

const ADMIN: Account = { oid: 'oid-admin', email: 'admin@cadence.local', name: 'Admin' };
const ARJUN: Account = { oid: 'oid-arjun', email: 'arjun@acumen-talent.com', name: 'Arjun R' };
const LISA: Account = { oid: 'oid-lisa', email: 'lisa@acumen-strategy.com', name: 'Lisa Ray' };

async function signInWithMicrosoft(page: Page, who: Account) {
  account = who;
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
}

/** Signed in, on Home, with the sidebar naming them. */
async function signedInAs(page: Page, who: Account) {
  await signInWithMicrosoft(page, who);
  await page.waitForURL(/\/home/);
  await expect(page.getByText(who.name, { exact: true }).first()).toBeVisible();
}

async function sound(page: Page, path: string) {
  await page.goto(path);
  const body = await page.locator('body').innerText();
  expect(body, path).not.toContain('Application error');
  expect(body, path).not.toContain('server-side exception');
}

const teamRow = (page: Page, email: string) => page.locator('table').first().locator('tbody tr', { hasText: email });

test('the admin signs in with Microsoft, and from then on there are no passwords', async ({ page }) => {
  await page.goto('/login');
  // Until Microsoft has worked once, both ways in: nobody is locked out by a mistake in the setup.
  await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();

  // The address Microsoft has is matched whatever its case; the admin stays the admin.
  await signedInAs(page, { ...ADMIN, email: 'Admin@Cadence.local' });
  await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await page.waitForURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/microsoft-login.png' });
});

test('a page asked for before signing in opens after Microsoft', async ({ page }) => {
  account = ADMIN;
  await page.context().clearCookies();
  await page.goto('/settings?tab=signin');
  await page.waitForURL(/\/login/);
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  await page.waitForURL(/\/settings\?tab=signin/);
  await expect(page.locator('main')).toContainText('Microsoft sign-in');
  await expect(page.locator('main')).toContainText('/api/auth/microsoft/callback');
});

test("someone new at one of our domains joins with a Junior FO's access and no title", async ({ page }) => {
  await signedInAs(page, ARJUN);
  await expect(page.getByText('Junior FO', { exact: true })).toHaveCount(0);
  for (const path of ['/home', '/tasks', '/people', '/accounts', '/enrichment', '/meetings', '/campaigns', '/activity', '/reports']) await sound(page, path);
  // A Junior FO is not an admin.
  await page.goto('/settings');
  await expect(page).not.toHaveURL(/\/settings/);
});

test('an admin gives the newcomer a title, and they keep it', async ({ page }) => {
  await signedInAs(page, ADMIN);
  await page.goto('/settings?tab=users');
  await expect(teamRow(page, ARJUN.email)).toContainText('No title');

  await page.getByRole('button', { name: 'Add pod' }).click();
  await page.getByLabel('Pod name').fill('Pod One');
  await page.getByRole('button', { name: 'Add pod' }).click();
  await expect(page.locator('table').nth(1)).toContainText('Pod One');

  await teamRow(page, ARJUN.email).getByRole('button', { name: 'Edit' }).click();
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Save changes' }) });
  await expect(form.getByLabel('Role')).toHaveValue('');
  await expect(form.getByLabel(/password/i)).toHaveCount(0);
  await form.getByLabel('Role').selectOption({ label: 'Sales Leader' });
  await form.getByLabel('Pod One').check();
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(teamRow(page, ARJUN.email)).toContainText('Sales Leader');
  await expect(teamRow(page, ARJUN.email)).not.toContainText('No title');

  await signedInAs(page, ARJUN);
  await expect(page.getByText('Sales Leader', { exact: true })).toBeVisible();
});

test('an admin adds someone without a password, and they sign in with Microsoft in that role', async ({ page }) => {
  await signedInAs(page, ADMIN);
  await page.goto('/settings?tab=users');
  await page.getByRole('button', { name: 'Add team member' }).click();
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Add team member' }) });
  await expect(form.getByLabel(/password/i)).toHaveCount(0);
  await form.getByLabel('Name').fill(LISA.name);
  await form.getByLabel('Email').fill(LISA.email);
  await form.getByLabel('Role').selectOption({ label: 'Senior FO' });
  await form.getByLabel('Pod One').check();
  await form.getByRole('button', { name: 'Add team member' }).click();
  await expect(teamRow(page, LISA.email)).toContainText('Senior FO');

  await signedInAs(page, LISA);
  await expect(page.getByText('Senior FO', { exact: true })).toBeVisible();
});

test('someone an admin removed stays out', async ({ page }) => {
  await signedInAs(page, ADMIN);
  await page.goto('/settings?tab=users');
  await teamRow(page, LISA.email).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove access' }).click();
  await expect(teamRow(page, LISA.email)).toHaveCount(0);

  await signInWithMicrosoft(page, LISA);
  await page.waitForURL(/\/login\?error=removed/);
  await expect(page.locator('main').getByRole('alert')).toHaveText('Your access to Cadence was removed. Ask an admin.');
});

test('an address outside our domains is turned away', async ({ page }) => {
  await signInWithMicrosoft(page, { oid: 'oid-outsider', email: 'someone@gmail.com', name: 'Someone' });
  await page.waitForURL(/\/login\?error=outsider/);
  await expect(page.locator('main').getByRole('alert')).toHaveText('Sign in with your work account.');
});
