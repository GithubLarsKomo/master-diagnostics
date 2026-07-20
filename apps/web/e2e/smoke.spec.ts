import { expect, test } from '@playwright/test';
test('shows project landing page', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Masters Diagnostics' })).toBeVisible(); });
