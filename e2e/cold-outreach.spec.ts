import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

/**
 * Cold outreach end to end (PLAN 9.4, the rep's path), on the new pages. A fake Bellwether pushes a
 * contact nobody owns and Alisa claims it; she builds a cold campaign in the studio with a call on its
 * first day; the step shows in Tasks; a call from her line, made outside
 * Cadence (no Call-button intent), is imported and closes that step; the form ends the campaign; the
 * contact moves to the CRM and the move is undone; Reports shows all three views. Twilio and Twenty are
 * the built-in stand-ins, and the worker (which launches the campaign) is the launcher's own.
 *
 * Replaces outreach-sandbox.spec.ts, which drove the old /sandbox pages. Like the rest of the suite it
 * expects the fresh database `pnpm test:e2e` makes: the stand-in Twilio numbers its call ids from one
 * after each reset, so on a database an earlier run used, the call is taken for one already imported.
 */
test.describe.configure({ mode: 'serial' });

const db = new PrismaClient({ datasourceUrl: 'postgresql://postgres:postgres@localhost:5435/cadence' });
test.afterAll(async () => db.$disconnect());

const KEY = 'e2e-bellwether-key-not-a-secret-000000000000';
const REP_LINE = '+13125550100';
const stamp = Date.now();
// Its own number each run, so its contact is never taken for an earlier run's.
const CONTACT_LINE = `+1312555${String(2000 + (stamp % 7000)).padStart(4, '0')}`;
const NAME = { first: 'Erin', last: `Harbor${stamp % 100000}` };
const FULL = `${NAME.first} ${NAME.last}`;
const CAMPAIGN = `Harbor intro ${stamp % 100000}`;

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
/** Today in the workspace's zone (the e2e workspace is Chicago), as YYYY-MM-DD. */
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const weekday = (day: string) => ![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test('the rep\'s path: push and claim, a studio campaign, its step in both task lists, a call closes it, the form ends it, move and undo, reports', async ({ page, request }) => {
  test.setTimeout(360_000);
  const today = chicagoToday();
  // The campaign starts today, so its first step is due today; on a weekend there is no today to start on.
  test.skip(!weekday(today), 'The path needs a working day: a campaign starts on one.');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // 1. Bellwether pushes a contact. Every move names an owner Cadence lets own contacts (13 Nov 2026):
  // the pusher alone is an admin, who never owns contacts, so that move is refused, never created unclaimed.
  const contact = { bellwetherContactId: `e2e:${stamp}`, firstName: NAME.first, lastName: NAME.last, jobTitle: 'Wealth Advisor', email: `erin.${stamp}@harbor-light-advisors.com`, emailVerification: 'valid', phone: CONTACT_LINE, phoneType: 'direct', state: 'IL', city: 'Chicago', country: 'US', linkedinUrl: `https://www.linkedin.com/in/erin-harbor-${stamp}`, firm: { name: 'Harbor Light Advisors', website: 'https://harbor-light-advisors.com' } };
  const push = (assignTo?: { email: string }) => request.post('/api/integrations/bellwether/v1/contacts', {
    headers: { 'x-cadence-api-key': KEY, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    data: { pushedBy: { email: 'admin@cadence.local', name: 'Admin' }, ...(assignTo ? { assignTo } : {}), contacts: [contact] },
  });
  const refused = await push();
  expect(refused.status()).toBe(200);
  expect((await refused.json()).results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'owner_not_found' }));
  // The move again, naming Alisa as the owner: it arrives hers.
  const pushed = await push({ email: 'alisa@cadence.local' });
  expect(pushed.status()).toBe(200);
  const body = await pushed.json();
  expect(body.results[0]).toEqual(expect.objectContaining({ result: 'created' }));
  const contactId: string = body.results[0].cadenceContactId;
  expect((await db.sandboxContact.findUniqueOrThrow({ where: { id: contactId } })).ownerId).not.toBeNull();

  // The admin confirms Alisa's Twilio number; the first import starts the forms clock.
  await signIn(page, 'admin@cadence.local', 'admin12345');
  expect((await page.request.post('/api/test/fake-twilio', { data: { action: 'reset' } })).ok()).toBe(true);
  await page.request.post('/api/test/fake-twilio', { data: { action: 'addNumber', phoneNumber: REP_LINE, friendlyName: 'Alisa Senior desk line' } });
  await page.goto('/settings?tab=calling');
  await page.getByRole('button', { name: 'Import calls now' }).click();
  await expect(page.getByText(/Read \d+ calls from Twilio/)).toBeVisible();
  const assigned = page.getByText('Assigned to Alisa Senior', { exact: true });
  // A second run on the same database finds the number hers already.
  if (!(await assigned.isVisible())) {
    const rep = page.getByLabel(`Rep for ${REP_LINE}`);
    await rep.selectOption({ label: 'Alisa Senior' });
    await rep.locator('xpath=..').getByRole('button', { name: 'Assign', exact: true }).click();
  }
  await expect(assigned).toBeVisible();
  await signOut(page);

  // Alisa opens it from its page: it is already hers, so there is nothing to claim.
  await signIn(page, 'alisa@cadence.local', 'password123');
  await page.goto(`/cold-outreach/${contactId}`);
  await expect(page.getByRole('heading', { name: FULL })).toBeVisible();
  const alisa = await db.user.findFirstOrThrow({ where: { email: 'alisa@cadence.local' } });
  expect((await db.sandboxContact.findUniqueOrThrow({ where: { id: contactId } })).ownerId).toBe(alisa.id);

  // 2. A cold campaign in the studio, starting today, with a call on its first day.
  await page.goto('/campaigns/new?audience=cold');
  await page.getByLabel('Campaign name', { exact: true }).fill(CAMPAIGN);
  await page.getByLabel('Campaign pod').selectOption({ label: "Alisa's pod" });
  await page.getByLabel('Start date', { exact: true }).fill(today);
  await page.getByLabel('End date', { exact: true }).fill(plusDays(today, 28));
  await page.getByRole('button', { name: 'PHH', exact: true }).click();
  await page.getByLabel('Default new people per day').fill('5');
  await page.getByRole('checkbox', { name: 'Alisa Senior', exact: true }).check();
  await page.getByLabel('Search contacts to add').fill(NAME.last);
  await page.getByLabel(`Select ${FULL}`, { exact: true }).check();
  await page.getByRole('button', { name: 'Next: Outreach', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Outreach groups', exact: true })).toBeVisible();
  await page.getByText('Add to this step').first().locator('..').getByRole('button', { name: 'Call', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Your outreach calendar' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish campaign' }).click();
  await page.waitForURL(/\/campaigns\/[a-f0-9-]+$/);
  const campaignId = page.url().split('/').at(-1)!;
  // The worker launches it at its next tick (once a minute here).
  await expect.poll(async () => (await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status, { timeout: 150_000, intervals: [5_000] }).toBe('ACTIVE');
  const enrollment = await db.enrollment.findFirstOrThrow({ where: { campaignId }, include: { tasks: true } });
  const callStep = enrollment.tasks.find((t) => t.action === 'CALL')!;
  expect(callStep).toEqual(expect.objectContaining({ state: 'PENDING', dueDate: today }));

  // 3. The step is in Tasks, with CRM work. Cold outreach has no Tasks tab of its own any more
  // (owner, 9 Nov 2026): its old address opens Tasks.
  await page.goto('/tasks');
  await expect(page.getByText(FULL).first()).toBeVisible();
  await page.goto('/cold-outreach/tasks');
  await expect(page).toHaveURL(/\/tasks$/);
  // The contacts list: four pills, every other view in one menu, no step strip.
  await page.goto('/cold-outreach');
  await expect(page.getByRole('main').getByRole('link', { name: 'Tasks', exact: true })).toHaveCount(0);
  const views = page.getByRole('navigation', { name: 'Quick views' });
  await expect(views.getByRole('link')).toHaveText([/^My contacts/, /^To claim/, /^Needs a next step/, /^Ready to move/]);
  await expect(page.getByRole('navigation', { name: "The rep's path" })).toHaveCount(0);
  const other = views.getByLabel('Other views');
  await other.selectOption((await other.locator('option', { hasText: /^All \(/ }).getAttribute('value'))!);
  await expect(page).toHaveURL(/view=all/);
  await expect(page.getByText(FULL).first()).toBeVisible();

  // 4. A call from Alisa's line to the contact, made outside Cadence, is imported: no intent, and it
  // closes the one call step due today (PLAN 8.7).
  await page.request.post('/api/test/fake-twilio', { data: { action: 'addCall', from: REP_LINE, to: CONTACT_LINE, durationSec: 125, recording: true } });
  await signOut(page);
  await signIn(page, 'admin@cadence.local', 'admin12345');
  await page.goto('/settings?tab=calling');
  await page.getByRole('button', { name: 'Import calls now' }).click();
  await expect(page.getByText(/Read \d+ calls from Twilio/)).toBeVisible();
  // This import, or the worker's own a moment before it, brought the call in, waiting for its form.
  await expect.poll(async () => (await db.callLog.findFirst({ where: { sandboxContactId: contactId, formDueAt: { not: null } } }))?.id ?? null, { timeout: 150_000, intervals: [3_000] }).not.toBeNull();
  await signOut(page);

  // 5. Alisa fills in the form: it says which step it closes; answered, the campaign ends.
  await signIn(page, 'alisa@cadence.local', 'password123');
  await page.goto(`/cold-outreach/${contactId}`);
  const waiting = page.getByRole('region', { name: 'Calls waiting for their form' });
  await expect(waiting).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^Call with ${FULL}`) }).click();
  const form = page.getByRole('form', { name: `Form for your call with ${FULL}` });
  await expect(form.getByText(/^Closes /)).toBeVisible();
  await form.getByText('Connected', { exact: true }).click();
  await form.getByRole('button', { name: '4', exact: true }).click();
  await form.getByLabel('What was said').fill('Interested in PHH; send the deck.');
  await form.locator('select[name="interest"]').selectOption('warm');
  await expect(form.getByText(`answered, so ${CAMPAIGN} ends`)).toBeVisible();
  await form.locator('select[name="nextStep"]').selectOption('email');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(waiting).toHaveCount(0);
  await expect.poll(async () => (await db.task.findUniqueOrThrow({ where: { id: callStep.id } })).state).toBe('DONE');
  await expect.poll(async () => (await db.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).not.toBe('ACTIVE');

  // 6. Move to CRM, then undo it.
  await page.reload();
  await page.getByRole('button', { name: 'Move to CRM' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Move to CRM' });
  await expect(dialog.getByText(/Creates firm Harbor Light Advisors/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Move 1' }).click();
  await page.waitForURL(/\/cold-outreach\/moves\//);
  await expect(page.getByText('In the CRM').first()).toBeVisible();
  await expect.poll(async () => (await db.sandboxContact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('MOVED');
  await page.goto(`/people?q=${encodeURIComponent(NAME.last)}`);
  await expect(page.getByRole('link', { name: new RegExp(NAME.last) }).first()).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await db.sandboxContact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('ACTIVE');
  await page.goto(`/people?q=${encodeURIComponent(NAME.last)}`);
  await expect(page.getByRole('link', { name: new RegExp(NAME.last) })).toHaveCount(0);

  // 7. Reports in all three views.
  for (const [audience, words] of [['all', 'All outreach'], ['crm', 'CRM'], ['cold', 'Cold outreach']] as const) {
    await page.goto(`/reports?audience=${audience}`);
    await expect(page.getByRole('link', { name: words, exact: true }).first()).toBeVisible();
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('people the CRM creates from email for cold contacts are cleaned up unless someone worked them', async ({ page, request }) => {
  const push = async (first: string, last: string, email: string) => {
    const res = await request.post('/api/integrations/bellwether/v1/contacts', {
      headers: { 'x-cadence-api-key': KEY, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      data: { pushedBy: { email: 'alisa@cadence.local', name: 'Alisa' }, contacts: [{ bellwetherContactId: `e2e-clean:${email}`, firstName: first, lastName: last, email, emailVerification: 'valid', state: 'IL', country: 'US', firm: { name: 'Quiet Lake Advisors', website: 'https://quiet-lake.com' } }] },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).results[0].cadenceContactId as string;
  };
  const untouched = { first: 'Nora', last: `Quiet${stamp % 100000}`, email: `nora.${stamp}@quiet-lake.com` };
  const worked = { first: 'Owen', last: `Quiet${stamp % 100000}`, email: `owen.${stamp}@quiet-lake.com` };
  await push(untouched.first, untouched.last, untouched.email);
  const workedId = await push(worked.first, worked.last, worked.email);

  await signIn(page, 'admin@cadence.local', 'admin12345');
  // The CRM's mail sync creates both; someone then edits Owen in the CRM.
  const a = await page.request.post('/api/test/fake-twenty', { data: { action: 'autoPerson', firstName: untouched.first, lastName: untouched.last, email: untouched.email, source: 'EMAIL' } });
  expect(a.ok()).toBe(true);
  const b = await page.request.post('/api/test/fake-twenty', { data: { action: 'autoPerson', firstName: worked.first, lastName: worked.last, email: worked.email, source: 'EMAIL' } });
  const owen = (await b.json()).person.id as string;
  await page.request.post('/api/test/fake-twenty', { data: { action: 'editPerson', id: owen, jobTitle: 'Partner' } });
  await page.goto(`/people?q=${encodeURIComponent(untouched.first)}`);
  await expect(page.getByRole('link', { name: new RegExp(untouched.last) }).first()).toBeVisible();

  await page.goto('/settings?tab=cold-outreach');
  await expect(page.getByText('On, every 5 minutes')).toBeVisible();
  await page.getByRole('button', { name: 'Clean up now' }).click();
  await expect(page.getByText('Cleanup: 1 removed, 1 kept and flagged.')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/^1 person · 1 in the last 7 days$/)).toBeVisible();

  // Nora is gone from People; Owen stays, and his cold contact says he is in the CRM.
  await page.goto(`/people?q=${encodeURIComponent(untouched.first)}`);
  await expect(page.getByRole('link', { name: new RegExp(untouched.last) })).toHaveCount(0);
  await page.goto(`/cold-outreach/${workedId}`);
  await expect(page.getByText(/Already in CRM/).first()).toBeVisible();
});
