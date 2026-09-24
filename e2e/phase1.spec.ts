import { beginStudio } from './studio-helper';
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email = 'admin@cadence.local', password = 'admin12345') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/** Every navigation the toolbar makes answers late, the way a slow server does. */
async function slowNavigations(page: Page, ms: number) {
  await page.route((url) => url.searchParams.has('_rsc'), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

test('typing fast into a search box keeps every letter while the server is slow', async ({ page }) => {
  await login(page);
  for (const [path, label] of [['/meetings', 'Search meetings'], ['/people?pod=&fo=', 'Search people'], ['/accounts?pod=&fo=', 'Search accounts']] as const) {
    await page.goto(path);
    await slowNavigations(page, 600);
    const box = page.getByLabel(label);
    await box.click();
    await box.pressSequentially('Acubooth', { delay: 90 });
    await expect(box).toHaveValue('Acubooth');
    await expect(page).toHaveURL(/Acubooth/, { timeout: 10_000 });
    await expect(box).toHaveValue('Acubooth');
    await page.unroute(() => true);
  }
});

test('the sort arrow takes focus without an outline escaping the control', async ({ page }) => {
  await login(page);
  await page.goto('/accounts?pod=&fo=');
  const arrow = page.getByRole('button', { name: /^Sort direction/ });
  await arrow.focus();
  const style = await arrow.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset, overflow: getComputedStyle(el.parentElement as HTMLElement).overflow };
  });
  // Nothing drawn outside the control: no outline, or a transparent one, and no clipping parent to
  // turn a stray outline into a sliver.
  expect(style.outline === 'none' || style.color === 'rgba(0, 0, 0, 0)' || style.color === 'transparent').toBe(true);
  expect(style.offset).not.toBe('4px');
  expect(style.overflow).not.toBe('hidden');
});

test('a campaign touchpoint is reordered by dragging its handle', async ({ page }) => {
  await login(page);await beginStudio(page,'StudioDrag',{count:2,endDate:'2027-01-15'});
  await page.getByLabel('Step 1 name').fill('First touch');
  const initialGap = await page.getByLabel('Gap before step 2').inputValue();
  const handles=page.getByRole('button',{name:/^Drag step/});
  await handles.nth(0).dragTo(handles.nth(2));
  await expect(page.getByLabel('Step 3 name')).toHaveValue('First touch');
  await expect(page.getByLabel('Gap before step 2')).toHaveValue(initialGap);
});

test('campaign outreach exposes simple calendar gaps instead of a separate sequence form', async ({ page }) => {
  await login(page);await beginStudio(page,'StudioSpacing',{count:2,endDate:'2027-01-15'});
  await expect(page.getByLabel('Gap before step 2')).toHaveAttribute('min','1');
  await expect(page.getByLabel('Sequence name',{exact:true})).toHaveCount(0);
  await expect(page.getByText(/^calendar days?$/).first()).toBeVisible();
});

test('accounts count people with and without an account, and the second opens People', async ({ page }) => {
  await login(page);
  await page.goto('/accounts?pod=&fo=');
  await expect(page.getByText('People with an account', { exact: true })).toBeVisible();
  await expect(page.getByText('People at matching accounts', { exact: true })).toHaveCount(0);
  await page.getByText('People without an account', { exact: true }).click();
  await expect(page).toHaveURL(/\/people\?.*account=none/);
});

test('a person page carries no CRM error banner and settings shows sync health', async ({ page }) => {
  await login(page);
  await page.goto('/people?pod=&fo=');
  await page.locator('tbody a[href^="/people/"]').first().click();
  await expect(page).toHaveURL(/\/people\//);
  await expect(page.getByText(/temporarily unavailable|Bad Gateway|Twenty unavailable/i)).toHaveCount(0);
  await page.goto('/settings?tab=twenty');
  await expect(page.getByText('Webhooks (24h)', { exact: true })).toBeVisible();
  await expect(page.getByText('Live reads', { exact: true })).toBeVisible();
});

test('the blocked accounts tab carries the non-prospect rules', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=blocked');
  await expect(page.getByLabel('Never prospects - domains')).toHaveValue(/microsoft\.com/);
  await expect(page.getByLabel('Not accounts - personal email domains')).toHaveValue(/gmail\.com/);
  await expect(page.getByRole('button', { name: 'Apply now' })).toBeVisible();
});
