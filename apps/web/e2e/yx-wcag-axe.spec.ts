import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { db } from '../src/lib/db';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

async function signInIfNeeded(page: Page) {
  await page.goto('/');

  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  await page.waitForURL((url) => url.pathname === '/');
  await expect(
    page.getByRole('heading', { name: 'Masters Diagnostics' }),
  ).toBeVisible();
}

async function releasedTestId(): Promise<string> {
  const result = await db.$client.execute({
    sql: `SELECT id FROM tests WHERE status = 'RELEASED' ORDER BY released_at DESC LIMIT 1`,
    args: [],
  });
  const id = result.rows[0]?.id;
  if (typeof id !== 'string' || !id) throw new Error('No RELEASED E2E test fixture found');
  return id;
}

async function axeAudit(page: Page, path: string) {
  await page.goto(path);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  expect(
    results.violations,
    `Axe violations on ${path}:\n${results.violations
      .map(
        (violation) =>
          `${violation.id}: ${violation.help}\n` +
          violation.nodes
            .map((node) => `  ${node.target.join(' ')}: ${node.failureSummary ?? ''}`)
            .join('\n'),
      )
      .join('\n\n')}`,
  ).toEqual([]);
}

test('axe WCAG AA audit covers stable Club beta surfaces', async ({ page }) => {
  await signInIfNeeded(page);
  const testId = await releasedTestId();

  await axeAudit(page, '/');
  await axeAudit(page, '/athletes');
  await axeAudit(page, '/tests');
  await axeAudit(page, `/tests/${testId}`);
});
