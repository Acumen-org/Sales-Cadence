import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

/**
 * Cold outreach beyond the rep's path (S11b): the bell (S5), Home with cold work in it (S6), and
 * Reports (S8): the audience switch, the Calls view, the export per audience, and Activity's filter and
 * chip. Each case pushes its own contacts, so none depends on another having run.
 */
test.describe.configure({ mode: 'serial' });

const db = new PrismaClient({ datasourceUrl: 'postgresql://postgres:postgres@localhost:5435/cadence' });
test.afterAll(async () => db.$disconnect());

const KEY = 'e2e-bellwether-key-not-a-secret-000000000000';
const stamp = Date.now() % 1_000_000;

async function signIn(page: Page, email: string, password = 'password123') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/** Bellwether sends one contact; Alisa pushes it, so it arrives hers. */
async function push(request: APIRequestContext, first: string, last: string) {
  const tag = `${last.toLowerCase()}${stamp}`;
  const res = await request.post('/api/integrations/bellwether/v1/contacts', {
    headers: { 'x-cadence-api-key': KEY, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    data: { pushedBy: { email: 'alisa@cadence.local', name: 'Alisa Senior' }, contacts: [{ bellwetherContactId: `e2e-screens:${tag}`, firstName: first, lastName: last, jobTitle: 'Partner', email: `${tag}@${tag}-wealth.com`, emailVerification: 'valid', state: 'IL', city: 'Chicago', country: 'US', firm: { name: `${last} Wealth`, website: `https://${tag}-wealth.com` } }] },
  });
  expect(res.status()).toBe(200);
  const r = (await res.json()).results[0];
  expect(r.result).toBe('created');
  return r.cadenceContactId as string;
}

test('the bell: a colleague\'s suggested next step is accepted in the bell, a finished move links to it, and Mark read clears the count', async ({ page, request }) => {
  const last = `Bell${stamp}`;
  const contactId = await push(request, 'Nina', last);
  const alisa = await db.user.findUniqueOrThrow({ where: { email: 'alisa@cadence.local' } });
  const karson = await db.user.findUniqueOrThrow({ where: { email: 'karson@cadence.local' } });
  // What the post-call form and the move worker write (S4, S5): a suggestion and a finished move.
  await db.notification.create({ data: { userId: alisa.id, kind: 'next_step_suggestion', sandboxContactId: contactId, fromUserId: karson.id, payload: { what: 'Send the deck', how: 'EMAIL', when: '2099-01-05', from: karson.name } } });
  const move = await db.notification.create({ data: { userId: alisa.id, kind: 'move_finished', payload: { moveId: randomUUID(), done: 2, failed: 0 } } });

  await signIn(page, 'alisa@cadence.local');
  const bell = page.getByRole('button', { name: 'Notifications' });
  await expect(bell).toHaveAttribute('title', /\d+ unread/);
  await bell.click();
  const dialog = page.getByRole('dialog', { name: 'Notifications' });
  // This case's own rows: the shared workspace keeps Alisa's earlier notifications (a CI retry
  // runs the case again with a new contact), so each row is found by what it is about.
  const suggestion = dialog.getByRole('listitem').filter({ hasText: `Nina ${last}` });
  await expect(suggestion.getByText(`Karson Junior suggests a next step: Send the deck (Email) on`)).toBeVisible();
  await expect(dialog.locator(`a[href="/cold-outreach/moves/${(move.payload as { moveId: string }).moveId}"]`)).toHaveAccessibleName(/Move to CRM: 2 contacts moved/);
  // The bell never says "sandbox" or "Twenty".
  await expect(dialog).not.toContainText(/sandbox|twenty/i);

  await suggestion.getByRole('button', { name: 'Accept as next step' }).click();
  await expect(suggestion.getByText('You accepted it: it is the next step now.')).toBeVisible();
  await expect.poll(async () => (await db.nextAction.findFirst({ where: { sandboxContactId: contactId, state: 'OPEN' } }))?.label ?? null).toBe('Send the deck');

  await dialog.getByRole('button', { name: 'Mark read' }).click();
  await expect(dialog.getByLabel('Unread')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close notifications' }).click();
  await expect(bell).not.toHaveAttribute('title', /unread/);
  // The suggestion's link opens the contact's own page, under Cold outreach.
  await bell.click();
  await dialog.getByRole('link', { name: new RegExp(`^Nina ${last}`) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/cold-outreach/${contactId}`));
  await expect(page.getByRole('heading', { name: `Nina ${last}` })).toBeVisible();
});

test('Home counts cold work with CRM work: a cold step due today is in To reach today and Up next, and opens in Tasks', async ({ page, request }) => {
  const last = `Home${stamp}`;
  const contactId = await push(request, 'Omar', last);
  await signIn(page, 'alisa@cadence.local');

  // A next step due today (the dialog's default day), set on the contact's own page.
  await page.goto(`/cold-outreach/${contactId}`);
  await page.getByRole('button', { name: 'Set next step' }).first().click();
  const form = page.getByRole('dialog');
  await form.getByLabel('What to do').fill('Send the PHH deck');
  // The contact has an email and no phone, so the step is an email (a call would be refused, N077).
  await form.getByLabel('How').selectOption({ label: 'Email' });
  await form.getByRole('button', { name: 'Set next step', exact: true }).click();
  await expect.poll(async () => (await db.nextAction.findFirst({ where: { sandboxContactId: contactId, state: 'OPEN' } }))?.label ?? null).toBe('Send the PHH deck');

  await page.goto('/home');
  await expect(page.getByText('Nothing this week')).toHaveCount(0);
  // A tile's figure: the first number in it.
  const figure = async (label: string) => Number((await page.getByRole('link').filter({ hasText: label }).first().innerText()).split(/\s+/).find((w) => /^\d+$/.test(w)) ?? -1);
  // To reach today counts the cold step, and Up next lists it with CRM work, no tag.
  expect(await figure('To reach today')).toBeGreaterThanOrEqual(1);
  const row = page.getByRole('link').filter({ hasText: `Omar ${last}` }).filter({ hasText: 'Send the PHH deck' }).first();
  await expect(row).toBeVisible();
  // My people counts the live cold contacts Alisa owns as well as her CRM people (D2).
  expect(await figure('My people')).toBeGreaterThanOrEqual(await db.sandboxContact.count({ where: { owner: { email: 'alisa@cadence.local' }, status: 'ACTIVE' } }));
  // Its row opens Tasks with the step on screen (D2: one list, Home's links land on the item).
  await row.click();
  await expect(page).toHaveURL(/\/tasks\?/);
  await expect(page.getByText(`Omar ${last}`).first()).toBeVisible();
  await expect(page.getByText('Send the PHH deck').first()).toBeVisible();
});

test('Reports: the audience switch keeps the period and view, the Calls view follows it, and the export is per audience', async ({ page }) => {
  await signIn(page, 'admin@cadence.local', 'admin12345');
  await page.goto('/reports?audience=all');
  const which = page.getByRole('navigation', { name: 'Which outreach' });
  await expect(which.getByRole('link', { name: 'All outreach', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(which.getByRole('link', { name: 'CRM', exact: true })).toBeVisible();
  // A period chosen first is kept when the audience changes (B042).
  await page.getByRole('navigation', { name: 'Period' }).getByRole('link', { name: 'Last month', exact: true }).click();
  await expect(page).toHaveURL(/from=/);
  const period = new URL(page.url()).searchParams;
  await which.getByRole('link', { name: 'Cold outreach', exact: true }).click();
  await expect(page).toHaveURL(/audience=cold/);
  for (const k of ['from', 'to']) expect(new URL(page.url()).searchParams.get(k)).toBe(period.get(k));
  // The cold view adds the funnel; every tile is there.
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Moved to CRM').first()).toBeVisible();

  // The Calls view keeps the audience, and switching the audience keeps the Calls view.
  await page.locator('main').getByRole('link', { name: 'Calls', exact: true }).first().click();
  await expect(page).toHaveURL(/view=calls/);
  await expect(page).toHaveURL(/audience=cold/);
  await which.getByRole('link', { name: 'All outreach', exact: true }).click();
  await expect(page).toHaveURL(/view=calls/);
  // All outreach is the default view, so the address leaves the audience out.
  await expect(which.getByRole('link', { name: 'All outreach', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(page).not.toHaveURL(/audience=cold/);

  // The export follows the audience and the view.
  for (const [audience, words, file] of [['all', 'All outreach', 'all-outreach'], ['crm', 'CRM', 'crm'], ['cold', 'Cold outreach', 'cold-outreach']] as const) {
    const res = await page.request.get(`/reports/export?audience=${audience}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<h1>Cadence report, ${words},`);
    expect(res.headers()['content-disposition'] ?? '').toContain(`cadence-report-${file}-`);
    const calls = await page.request.get(`/reports/export?audience=${audience}&view=calls`);
    expect(await calls.text()).toContain(`<h1>Cadence calls report, ${words},`);
  }
  const body = await page.locator('main').innerText();
  expect(body).not.toMatch(/\bsandbox\b|\btwenty\b/i);
});

test('Activity: the CRM / Cold outreach filter, and the Cold outreach chip on cold events', async ({ page, request }) => {
  const last = `Act${stamp}`;
  const contactId = await push(request, 'Pia', last);
  await signIn(page, 'alisa@cadence.local');
  // A cold event of Alisa's own: she adds a note on the contact.
  await page.goto(`/cold-outreach/${contactId}?tab=notes`);
  await page.getByLabel('Note').fill('Prefers email');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect.poll(async () => db.auditLog.count({ where: { entityId: contactId } })).toBeGreaterThan(0);

  await signIn(page, 'admin@cadence.local', 'admin12345');
  await page.goto(`/activity?q=${encodeURIComponent(last)}`);
  const row = page.getByRole('listitem').filter({ hasText: last }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText('Cold outreach', { exact: true })).toBeVisible();
  const filter = page.getByRole('navigation', { name: 'CRM or Cold outreach' });
  await filter.getByRole('button', { name: 'CRM', exact: true }).click();
  await expect(page).toHaveURL(/audience=crm/);
  await expect(page.getByRole('listitem').filter({ hasText: last })).toHaveCount(0);
  await filter.getByRole('button', { name: 'Cold outreach', exact: true }).click();
  await expect(page).toHaveURL(/audience=cold/);
  await expect(page.getByRole('listitem').filter({ hasText: last }).first()).toBeVisible();
  // It links to the contact's own page, never a CRM person.
  const link = page.getByRole('listitem').filter({ hasText: last }).first().getByRole('link').first();
  await expect(link).toHaveAttribute('href', new RegExp(`/cold-outreach/${contactId}`));
});
