import { expect, test, type Page } from '@playwright/test';
import { db } from '../src/lib/db';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

async function signInIfNeeded(page: Page) {
  await page.goto('/');
  if (new URL(page.url()).pathname === '/setup') {
    await page.getByLabel('Clubname', { exact: true }).fill('WCAG Text Spacing Club');
    await page.getByLabel('Slug', { exact: true }).fill('wcag-text-spacing');
    await page.getByLabel('Name', { exact: true }).fill('Club Admin');
    await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Installation abschließen' }).click();
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/sign-in');
  }
  if (new URL(page.url()).pathname === '/sign-in') {
    await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }
}

async function assertTextSpacing(page: Page, path: string) {
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/sign-in$/);

  await page.addStyleTag({
    content: `
      * {
        line-height: 1.5 !important;
        letter-spacing: 0.12em !important;
        word-spacing: 0.16em !important;
      }
      p { margin-bottom: 2em !important; }
    `,
  });

  const findings = await page.evaluate(() => {
    const result: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) {
      result.push(`page-horizontal-overflow:${root.scrollWidth - root.clientWidth}px`);
    }

    document.querySelectorAll<HTMLElement>('body *').forEach((element) => {
      if (!element.textContent?.trim()) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
      const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
      if (clipsX && element.scrollWidth > element.clientWidth + 1) {
        result.push(`clipped-x:${element.tagName.toLowerCase()}#${element.id || '-'}:${element.scrollWidth - element.clientWidth}px`);
      }
      if (clipsY && element.scrollHeight > element.clientHeight + 1) {
        result.push(`clipped-y:${element.tagName.toLowerCase()}#${element.id || '-'}:${element.scrollHeight - element.clientHeight}px`);
      }
    });
    return result;
  });

  expect(findings, `WCAG 1.4.12 text-spacing loss/clipping on ${page.url()}`).toEqual([]);
}

test('WCAG 1.4.12 text spacing preserves core club beta surfaces', async ({ page }) => {
  await signInIfNeeded(page);
  await assertTextSpacing(page, '/');
  await assertTextSpacing(page, '/athletes');
  await assertTextSpacing(page, '/tests');

  const result = await db.$client.execute({ sql: 'SELECT id FROM tests ORDER BY created_at DESC LIMIT 1', args: [] });
  const testId = result.rows[0]?.id;
  expect(typeof testId, 'The text-spacing contract requires an existing E2E test detail surface').toBe('string');
  await assertTextSpacing(page, `/tests/${String(testId)}`);
});
