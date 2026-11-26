import type { Page } from '@playwright/test';

/**
 * Opens the password sign-in of a running Cadence for the live:* scripts: /login while it still
 * takes passwords, otherwise /login/admin (admins only), the way in that stays open once Microsoft
 * sign-in has retired passwords on /login (owner, 2 November 2026). Production is the second kind.
 */
export async function goToPasswordSignIn(page: Page, url: string): Promise<void> {
  await page.goto(`${url}/login`, { waitUntil: 'networkidle' });
  if (await page.getByLabel('Password').count()) return;
  await page.goto(`${url}/login/admin`, { waitUntil: 'networkidle' });
}
