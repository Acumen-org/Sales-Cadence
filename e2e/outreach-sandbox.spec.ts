import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * The outreach sandbox end to end (docs/outreach-sandbox-plan.md): a fake Bellwether pushes a
 * contact, a fake Twilio call to it is imported, the post-call form is required and submitted, the
 * contact moves to the CRM, and the move is undone. Twilio and Twenty are the built-in stand-ins.
 */
test.describe.configure({ mode: 'serial' });

const KEY = 'e2e-bellwether-key-not-a-secret-000000000000';
const REP_LINE = '+13125550100';
const CONTACT_LINE = '+13125550199';
const stamp = Date.now();
const NAME = { first: 'Erin', last: `Harbor${stamp % 100000}` };
const FULL = `${NAME.first} ${NAME.last}`;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}
async function signOut(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}

test('push, call, form, move to CRM and undo', async ({ page, request }) => {
  page.on('dialog', (d) => void d.accept());

  // 1. Bellwether pushes a contact for Alisa.
  const pushed = await request.post('/api/integrations/bellwether/v1/contacts', {
    headers: { 'x-cadence-api-key': KEY, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    data: {
      pushedBy: { email: 'alisa@cadence.local', name: 'Alisa' },
      contacts: [{ bellwetherContactId: `e2e:${stamp}`, firstName: NAME.first, lastName: NAME.last, jobTitle: 'Wealth Advisor', email: `erin.${stamp}@harbor-light-advisors.com`, emailVerification: 'valid', phone: '(312) 555-0199', phoneType: 'direct', state: 'IL', city: 'Chicago', country: 'US', firm: { name: 'Harbor Light Advisors', website: 'https://harbor-light-advisors.com' } }],
    },
  });
  expect(pushed.status()).toBe(200);
  const body = await pushed.json();
  expect(body.results[0]).toEqual(expect.objectContaining({ result: 'created', ownerEmail: 'alisa@cadence.local' }));
  const contactId: string = body.results[0].cadenceContactId;

  // 2. The admin confirms Alisa's Twilio number; a call from it to the contact is imported.
  await signIn(page, 'admin@cadence.local', 'admin12345');
  expect((await page.request.post('/api/test/fake-twilio', { data: { action: 'reset' } })).ok()).toBe(true);
  await page.request.post('/api/test/fake-twilio', { data: { action: 'addNumber', phoneNumber: REP_LINE, friendlyName: 'Alisa Senior desk line' } });
  await page.goto('/settings?tab=calling');
  await expect(page.getByText('Stand-in (tests)')).toBeVisible();
  // The first import starts the clock: calls made from now on ask for a form.
  await page.getByRole('button', { name: 'Import calls now' }).click();
  await expect(page.getByText(/Read \d+ calls from Twilio/)).toBeVisible();
  const row = page.locator('form', { has: page.getByText(REP_LINE) });
  await row.getByLabel(`Rep for ${REP_LINE}`).selectOption({ label: 'Alisa Senior' });
  await row.getByRole('button', { name: /Confirm|Save/ }).click();
  await expect(page.getByText('Number assigned.')).toBeVisible();
  await page.request.post('/api/test/fake-twilio', { data: { action: 'addCall', from: REP_LINE, to: CONTACT_LINE, durationSec: 125, recording: true } });
  await page.getByRole('button', { name: 'Import calls now' }).click();
  await expect(page.getByText(/1 new, 1 forms opened, 1 recordings/)).toBeVisible();
  await signOut(page);

  // 3. Alisa must fill in the form: the bar names the call and her Call button waits for it.
  await signIn(page, 'alisa@cadence.local', 'password123');
  const bar = page.getByRole('region', { name: 'Calls waiting for their form' });
  await expect(bar.getByRole('button', { name: new RegExp(`Your call with ${FULL}`) })).toBeVisible();
  await page.goto(`/sandbox/${contactId}`);
  await expect(page.getByRole('heading', { name: FULL })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Call: Fill in the form for your call with/ })).toBeDisabled();
  await expect(page.locator('audio')).toHaveCount(1);
  await bar.getByRole('button', { name: new RegExp(`Your call with ${FULL}`) }).click();
  const form = page.getByRole('form', { name: `Form for your call with ${FULL}` });
  await form.getByText('Connected', { exact: true }).click();
  await form.getByRole('button', { name: '4', exact: true }).click();
  await form.getByLabel('Notes').fill('Interested in PHH; send the deck.');
  await form.getByLabel('Next step', { exact: true }).selectOption('email');
  await expect(form.getByLabel('Next step day')).not.toHaveValue('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(bar).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(/Email · Email · /)).toBeVisible();
  // The form no longer holds Call back; outside 8:00-21:00 in Chicago, calling hours do.
  await expect(page.getByRole('button', { name: /^Call: Fill in the form/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Call', exact: true }).or(page.getByRole('button', { name: /^Call: It is .* outside 8:00 to 21:00\.$/ }))).toBeVisible();

  // 4. Move to CRM: ready, the firm is created, and the person shows in People.
  await page.getByRole('button', { name: 'Move to CRM' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to CRM' });
  await expect(dialog.getByText('Creates Harbor Light Advisors')).toBeVisible();
  await dialog.getByRole('button', { name: 'Move 1' }).click();
  await page.waitForURL(/\/sandbox\/moves\//);
  await expect(page.getByText('In the CRM')).toBeVisible();
  await page.goto(`/people?q=${encodeURIComponent(NAME.last)}`);
  await expect(page.getByRole('link', { name: new RegExp(NAME.last) }).first()).toBeVisible();
  // It has left the sandbox's active list.
  await page.goto(`/sandbox?tab=contacts&owner=all&q=${encodeURIComponent(NAME.last)}`);
  await expect(page.getByText('No contacts match')).toBeVisible();

  // 5. Undo: the person leaves Twenty and the contact is back in the sandbox.
  await page.goto(`/sandbox?tab=contacts&owner=all&status=moved&q=${encodeURIComponent(NAME.last)}`);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('No contacts match')).toBeVisible();
  await page.goto(`/sandbox/${contactId}`);
  await expect(page.getByText('In the sandbox')).toBeVisible();
  await page.goto(`/people?q=${encodeURIComponent(NAME.last)}`);
  await expect(page.getByRole('link', { name: new RegExp(NAME.last) })).toHaveCount(0);
});
